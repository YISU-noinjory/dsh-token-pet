/**
 * 余额轮询调度器。
 *
 * 职责边界：
 *  - {@link BalanceClient} 负责「一次请求」；
 *  - 本文件负责「什么时候再请求一次」。
 *
 * 调度策略不是「固定间隔 + 失败就立刻重试」，而是按错误的可重试性分流：
 *
 *  | 错误分类        | 策略                                     |
 *  | --------------- | ---------------------------------------- |
 *  | network/server  | 指数退避 + 抖动（上限 5 分钟）            |
 *  | rate-limited    | 优先遵循服务端 Retry-After，否则退避      |
 *  | unauthorized    | 慢速重试（退避到上限），等待用户改配置     |
 *  | no-credential   | 慢速重试，等待用户补上 Key                |
 *  | malformed       | 慢速重试（接口可能已修复），避免打爆服务端 |
 *
 * 「慢速重试」而非「停止」：用户补 `.env` 或换 Key 之后，
 * 宠物应当自己恢复，而不是要求重启应用。
 */

import type { BalanceState, BalanceError, BalanceErrorCode, BalanceSnapshot } from '../shared/types'
import type { BalanceChainLike } from './credentials'
import type { BalanceClient } from './balance-client'

/** 可注入的定时器，便于在测试中推进虚拟时间。 */
export interface Timers {
  setTimeout(handler: () => void, delayMs: number): NodeJS.Timeout
  clearTimeout(handle: NodeJS.Timeout): void
}

/** 构造选项。 */
export interface BalancePollerOptions {
  readonly client: BalanceClient
  /** 凭证解析链；每次请求前重新解析，这样换 Key 无需重启。 */
  readonly credentials: BalanceChainLike
  /** 正常情况下的轮询间隔（ms）。 */
  readonly intervalMs: number
  /** 状态变化的回调。每次状态迁移恰好调用一次。 */
  readonly onState: (state: BalanceState) => void
  /** 注入定时器；默认用全局的。 */
  readonly timers?: Timers
  /** 诊断日志出口；默认静默，避免污染宿主日志。 */
  readonly log?: (message: string) => void
}

/** 退避参数。 */
const BACKOFF_BASE_MS = 5_000
const BACKOFF_MAX_MS = 5 * 60_000
/** 抖动比例：±20%，避免多个实例在同一秒一起打接口。 */
const JITTER_RATIO = 0.2
/** 服务端 `Retry-After` 的可用区间：太小会立刻再被限流，太大等于停摆。 */
const SERVER_RETRY_MIN_MS = 1_000
const SERVER_RETRY_MAX_MS = 30 * 60_000

const DEFAULT_TIMERS: Timers = {
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
}

/** 该错误是否值得用指数退避（而非慢速重试）来跟进。 */
function isTransient(code: BalanceErrorCode): boolean {
  return code === 'network' || code === 'server' || code === 'rate-limited'
}

/** 施加 ±20% 抖动后取整。 */
function withJitter(delayMs: number): number {
  const jitter = 1 + (Math.random() * 2 - 1) * JITTER_RATIO
  return Math.round(delayMs * jitter)
}

/** 指数退避：第 n 次连续可重试失败对应的延迟。 */
function backoffDelay(attempt: number): number {
  const exponential = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS)
  return withJitter(exponential)
}

/** 把数值夹到闭区间内。 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export class BalancePoller {
  readonly #options: BalancePollerOptions
  readonly #timers: Timers

  /** 定时器句柄；`undefined` 表示当前没有排程（已停止或正在请求中）。 */
  #timer: NodeJS.Timeout | undefined
  /** 防止并发的在途请求：手动刷新与定时触发可能撞车。 */
  #inFlight: Promise<void> | undefined
  /**
   * 连续的可重试失败次数，成功或遇到不可重试错误时归零。
   *
   * 必须与「最近一次失败的分类」分开记录：早先的实现在配置类错误上
   * 也把这个计数推高，导致用户修好 Key 之后第一次网络抖动就直接
   * 跳到 5 分钟退避——退避曲线本该描述"连续的网络问题"，而不是
   * "历史上出过多少次配置问题"。
   */
  #transientFailures = 0
  /** 最近一次失败的分类，决定下一次排程用哪档延迟。 */
  #lastFailure: { readonly code: BalanceErrorCode; readonly transient: boolean } | undefined
  /** 服务端建议的重试延迟；仅 `rate-limited` 会携带。 */
  #serverRetryAfterMs: number | undefined
  #state: BalanceState = { status: 'idle' }
  /** 最近一次成功读数，作为失败时的降级展示。 */
  #lastSnapshot: BalanceSnapshot | undefined
  #stopped = true
  /** 用于取消在途请求。 */
  #abort: AbortController | undefined

  constructor(options: BalancePollerOptions) {
    this.#options = options
    this.#timers = options.timers ?? DEFAULT_TIMERS
  }

  /** 当前状态，供 IPC `balance:get` 直接返回。 */
  getState(): BalanceState {
    return this.#state
  }

  /** 启用轮询。重复调用是安全的空操作。 */
  start(): void {
    if (!this.#stopped) return
    this.#stopped = false
    // 首次立即拉取，不必等一个完整间隔——用户刚启动时最需要看到数字。
    this.#schedule(0)
  }

  /**
   * 停止轮询并取消在途请求。
   *
   * 停止后状态保持不变（不会重置为 idle），这样窗口重新显示时
   * 还能立刻渲染出上一次的数据。
   */
  stop(): void {
    this.#stopped = true
    if (this.#timer !== undefined) {
      this.#timers.clearTimeout(this.#timer)
      this.#timer = undefined
    }
    this.#abort?.abort()
    this.#abort = undefined
  }

  /**
   * 手动刷新。
   *
   * 会重置退避计数：用户的主动意图应当立刻生效，
   * 而不是继续等上一次失败留下的长退避。
   *
   * @returns 本次请求完成后兑现，便于 IPC 等待。
   */
  async refresh(): Promise<void> {
    this.#resetBackoff()
    if (this.#timer !== undefined) {
      this.#timers.clearTimeout(this.#timer)
      this.#timer = undefined
    }
    await this.#runOnce()
    // 手动刷新后重新排程，保持轮询不中断。
    if (!this.#stopped) this.#schedule(this.#options.intervalMs)
  }

  /** 排程下一次请求。 */
  #schedule(delayMs: number): void {
    if (this.#stopped) return
    if (this.#timer !== undefined) this.#timers.clearTimeout(this.#timer)
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = undefined
      void this.#runOnce().then(() => {
        // 请求完成后按「正常间隔」或「退避间隔」排下一次。
        this.#schedule(this.#nextDelay())
      })
    }, delayMs)
  }

  /** 计算下一次请求的延迟。 */
  #nextDelay(): number {
    const failure = this.#lastFailure
    if (!failure) return this.#options.intervalMs

    // 服务端明确给了 Retry-After 就听它的：它比本地猜测更了解限流窗口。
    if (failure.transient && this.#serverRetryAfterMs !== undefined) {
      return clamp(this.#serverRetryAfterMs, SERVER_RETRY_MIN_MS, SERVER_RETRY_MAX_MS)
    }

    if (failure.transient) return backoffDelay(this.#transientFailures)
    // 不可重试错误（凭证无效、接口结构变了）：停在慢速档反复探测，
    // 这样用户改好配置后宠物能自己恢复，而不需要重启应用。
    return withJitter(BACKOFF_MAX_MS)
  }

  /** 清空退避状态。 */
  #resetBackoff(): void {
    this.#transientFailures = 0
    this.#lastFailure = undefined
    this.#serverRetryAfterMs = undefined
  }

  /** 执行一次「解析凭证 → 请求 → 迁移状态」。 */
  async #runOnce(): Promise<void> {
    // 合并并发调用：返回同一个在途 Promise，而不是发第二个请求。
    if (this.#inFlight) return this.#inFlight
    const task = this.#execute()
    this.#inFlight = task
    try {
      await task
    } finally {
      this.#inFlight = undefined
    }
  }

  async #execute(): Promise<void> {
    const credential = await this.#options.credentials.resolve()
    if (!credential) {
      this.#fail({
        code: 'no-credential',
        message: '未找到 DEEPSEEK_API_KEY：请设置环境变量或在项目根目录创建 .env',
      })
      return
    }

    // 有旧数据时进入 refreshing，让 UI 能同时表达「正在刷新」与「旧值仍可用」。
    this.#transition(
      this.#lastSnapshot ? { status: 'refreshing', snapshot: this.#lastSnapshot } : { status: 'loading' },
    )

    this.#abort = new AbortController()
    const result = await this.#options.client.fetchBalance(credential.apiKey, this.#abort.signal)

    if (result.ok) {
      this.#lastSnapshot = result.snapshot
      this.#resetBackoff()
      this.#transition({ status: 'ready', snapshot: result.snapshot })
      return
    }

    this.#fail(result.error)
  }

  /** 处理一次失败：推进退避并迁移状态。 */
  #fail(error: BalanceError): void {
    if (error.code === 'aborted') {
      // 主动取消不算失败，不计入退避。
      return
    }

    const transient = isTransient(error.code)
    if (transient) {
      // 只累计「连续」的可重试失败。中间夹一次配置类错误就重置，
      // 避免历史错误把退避曲线整体推高。
      this.#transientFailures = this.#lastFailure?.transient ? this.#transientFailures + 1 : 1
    } else {
      this.#transientFailures = 0
    }
    this.#lastFailure = { code: error.code, transient }
    this.#serverRetryAfterMs = error.retryAfterMs

    this.#options.log?.(`[balance] 拉取失败 (${error.code})：${error.message}`)

    this.#transition(
      this.#lastSnapshot
        ? { status: 'error', error, staleSnapshot: this.#lastSnapshot }
        : { status: 'error', error },
    )
  }

  /** 状态迁移的唯一出口，保证回调与去重。 */
  #transition(next: BalanceState): void {
    if (isSameState(this.#state, next)) return
    this.#state = next
    this.#options.onState(next)
  }
}

/**
 * 判断两个状态是否等价。
 *
 * 用时间戳与关键字段比较，而不是引用比较：轮询每次都构造新对象，
 * 引用比较会让「每 60 秒推送一次完全相同的余额」变成无谓的 UI 重绘。
 */
function isSameState(a: BalanceState, b: BalanceState): boolean {
  if (a.status !== b.status) return false
  switch (b.status) {
    case 'ready':
    case 'refreshing':
      return a.status === b.status && a.snapshot.fetchedAt === b.snapshot.fetchedAt
    case 'error':
      return (
        a.status === 'error' &&
        a.error.code === b.error.code &&
        a.error.message === b.error.message &&
        a.staleSnapshot?.fetchedAt === b.staleSnapshot?.fetchedAt
      )
    case 'idle':
    case 'loading':
      return true
  }
}
