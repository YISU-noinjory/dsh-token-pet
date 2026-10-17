/**
 * DeepSeek 余额接口客户端。
 *
 * 只做一件事：把一次 HTTP 往返翻译成 {@link BalanceSnapshot} 或 {@link BalanceError}。
 * 不做重试、不做定时——那些属于 {@link BalancePoller} 的职责。
 * 这个划分让客户端可以被单测直接喂假响应。
 */

import type {
  BalanceError,
  BalanceErrorCode,
  BalanceSnapshot,
  BalanceWallet,
  Currency,
} from '../shared/types'

/** 官方接口地址。 */
export const BALANCE_ENDPOINT = 'https://api.deepseek.com/user/balance'

/* ------------------------------------------------------------------ *
 * 线上格式（snake_case）—— 仅本文件可见
 * ------------------------------------------------------------------ */

/**
 * 接口原始响应。
 *
 * 单独声明而不复用领域类型，是为了让「服务端字段改名」这件事
 * 只在解析函数里炸掉，而不是渗透到整个应用的类型里。
 */
interface WireBalanceResponse {
  is_available?: unknown
  balance_infos?: unknown
}

interface WireWallet {
  currency?: unknown
  total_balance?: unknown
  granted_balance?: unknown
  topped_up_balance?: unknown
}

/** 客户端构造选项。 */
export interface BalanceClientOptions {
  /** 接口地址，便于指向 mock 服务。 */
  readonly endpoint?: string
  /** 单次请求超时（ms）。 */
  readonly timeoutMs?: number
  /**
   * 注入的 fetch 实现。
   *
   * 注入而非直接引用全局 `fetch`，是为了让测试无需起 HTTP 服务；
   * 同时也让主进程能替换成带代理的实现。
   */
  readonly fetchImpl?: typeof fetch
}

/** 一次请求的结果：成功带快照，失败带分类错误。 */
export type BalanceFetchResult =
  | { readonly ok: true; readonly snapshot: BalanceSnapshot }
  | { readonly ok: false; readonly error: BalanceError }

export class BalanceClient {
  readonly #endpoint: string
  readonly #timeoutMs: number
  readonly #fetch: typeof fetch

  constructor(options: BalanceClientOptions = {}) {
    this.#endpoint = options.endpoint ?? BALANCE_ENDPOINT
    this.#timeoutMs = options.timeoutMs ?? 10_000
    // 绑定到 globalThis，否则在某些宿主里调用会因 this 丢失而抛错。
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  }

  /**
   * 查询余额。
   *
   * @param apiKey - 用户 API Key。
   * @param signal - 外部取消信号（退出、手动停止轮询）。
   * @returns 判别联合的结果，永不抛异常——调用方不需要 try/catch。
   */
  async fetchBalance(apiKey: string, signal?: AbortSignal): Promise<BalanceFetchResult> {
    // 自身超时与外部取消合并：两者任一触发都要中止请求。
    const timeout = AbortSignal.timeout(this.#timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout

    let response: Response
    try {
      response = await this.#fetch(this.#endpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
        signal: combined,
      })
    } catch (cause) {
      return { ok: false, error: this.#mapTransportError(cause, signal) }
    }

    if (!response.ok) {
      return { ok: false, error: await this.#mapHttpError(response) }
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      return {
        ok: false,
        error: {
          code: 'malformed',
          message: '响应不是合法 JSON',
        },
      }
    }

    const parsed = parseBalanceResponse(payload)
    if (!parsed) {
      return {
        ok: false,
        error: {
          code: 'malformed',
          message: '响应结构不符合 /user/balance 的约定',
        },
      }
    }

    return {
      ok: true,
      snapshot: {
        isAvailable: parsed.isAvailable,
        wallets: parsed.wallets,
        fetchedAt: Date.now(),
        source: 'api',
      },
    }
  }

  /**
   * 把 fetch 抛出的异常分成「被取消」与「网络故障」。
   *
   * 这个区分很重要：被取消不该计入退避次数，否则用户每次手动停止
   * 轮询都会让下一次请求的延迟变长。
   */
  #mapTransportError(cause: unknown, externalSignal?: AbortSignal): BalanceError {
    if (externalSignal?.aborted) {
      return { code: 'aborted', message: '请求被调用方取消' }
    }
    if (cause instanceof Error && cause.name === 'TimeoutError') {
      return { code: 'network', message: `请求超时（${this.#timeoutMs}ms）` }
    }
    const detail = cause instanceof Error ? cause.message : String(cause)
    return { code: 'network', message: `网络请求失败：${detail}` }
  }

  /** HTTP 状态码 → 分类错误。 */
  async #mapHttpError(response: Response): Promise<BalanceError> {
    const code: BalanceErrorCode = (() => {
      if (response.status === 401 || response.status === 403) return 'unauthorized'
      if (response.status === 429) return 'rate-limited'
      if (response.status >= 500) return 'server'
      return 'malformed'
    })()

    const retryAfterMs =
      code === 'rate-limited' ? parseRetryAfter(response.headers.get('retry-after')) : undefined

    // 读取响应体摘要用于诊断，但截断：避免把整页 HTML 错误页塞进日志。
    let detail = ''
    try {
      detail = (await response.text()).slice(0, 200)
    } catch {
      detail = '<响应体不可读>'
    }

    return {
      code,
      message: `HTTP ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    }
  }
}

/**
 * 解析 `Retry-After` 响应头。
 *
 * 该头有两种合法形式：秒数或 HTTP 日期。只实现秒数即可覆盖绝大多数情况，
 * 日期形式直接忽略（退避算法会兜底）。
 *
 * @param header - 响应头原文。
 * @returns 毫秒数；无法解析时为 `undefined`。
 */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number.parseInt(header, 10)
  if (!Number.isFinite(seconds) || seconds < 0) return undefined
  return seconds * 1000
}

/**
 * 把线上结构解析成领域模型。
 *
 * 逐字段校验而不是直接断言：接口字段缺失时，
 * 一个 `undefined` 会一路流到 UI 变成 `NaN`，而在这里失败会得到明确的错误码。
 *
 * @param payload - `response.json()` 的结果。
 * @returns 解析结果；结构不合法时为 `undefined`。
 */
export function parseBalanceResponse(
  payload: unknown,
): { isAvailable: boolean; wallets: BalanceWallet[] } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const wire = payload as WireBalanceResponse

  const rawInfos = wire.balance_infos
  if (!Array.isArray(rawInfos)) return undefined

  const wallets: BalanceWallet[] = []
  for (const raw of rawInfos) {
    if (typeof raw !== 'object' || raw === null) continue
    const item = raw as WireWallet
    const currency = normalizeCurrency(item.currency)
    if (!currency) continue
    wallets.push({
      currency,
      totalBalance: asAmountString(item.total_balance),
      grantedBalance: asAmountString(item.granted_balance),
      toppedUpBalance: asAmountString(item.topped_up_balance),
    })
  }

  // `balance_infos` 存在但不是数组、或数组里一条都解析不出来，都算结构异常。
  if (wallets.length === 0 && rawInfos.length > 0) return undefined

  return { isAvailable: wire.is_available === true, wallets }
}

/** 收敛币种字面量，未知币种返回 `undefined`（跳过该钱包而不是伪造一个）。 */
function normalizeCurrency(value: unknown): Currency | undefined {
  return value === 'CNY' || value === 'USD' ? value : undefined
}

/**
 * 金额字段统一转成字符串。
 *
 * 服务端理论上返回字符串，但历史上出现过数字；两种都接受，
 * 数字转字符串可以避免精度在领域层被 `toFixed` 二次破坏。
 */
function asAmountString(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return '0'
}
