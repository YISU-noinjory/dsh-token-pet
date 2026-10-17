/**
 * 余额徽章的渲染逻辑。
 *
 * 只做「状态 → 文本与样式」的翻译，不发起任何请求——
 * 数据由主进程推来，这里保持纯展示。这样登录态、缓存、退避策略
 * 全都不需要在这里重新实现一遍。
 */

import { formatAmount, selectSnapshot } from '../../shared/config'
import type { BalanceState } from '../../shared/types'

/** 构造选项。 */
export interface BalanceBadgeOptions {
  /** 徽章根元素，用于切换状态样式类。 */
  readonly root: HTMLElement
  /** 金额文本节点。 */
  readonly amount: HTMLElement
  /** 状态标记（小圆点 / 图标）。 */
  readonly status: HTMLElement
}

/** 徽章的视觉状态。 */
type BadgeTone = 'loading' | 'ok' | 'refreshing' | 'stale' | 'error'

/** 相对时间的刷新间隔（ms）。 */
const AGE_REFRESH_MS = 20_000

export class BalanceBadge {
  readonly #options: BalanceBadgeOptions
  #state: BalanceState = { status: 'idle' }
  #ageTimer: number | undefined

  constructor(options: BalanceBadgeOptions) {
    this.#options = options
  }

  /**
   * 用新的状态重绘。
   *
   * @param state - 主进程推来的余额状态机。
   */
  update(state: BalanceState): void {
    this.#state = state
    this.#paint()
    this.#ensureAgeTimer()
  }

  /** 释放定时器。 */
  dispose(): void {
    if (this.#ageTimer !== undefined) {
      window.clearInterval(this.#ageTimer)
      this.#ageTimer = undefined
    }
  }

  /**
   * 启动相对时间刷新。
   *
   * 「3 分钟前」这类文案必须自己走时，否则数据停止更新后
   * 界面会一直显示一个越来越不准确的旧值，用户却看不出来。
   */
  #ensureAgeTimer(): void {
    if (this.#ageTimer !== undefined) return
    this.#ageTimer = window.setInterval(() => this.#paint(), AGE_REFRESH_MS)
  }

  /** 把状态写成 DOM。 */
  #paint(): void {
    const { root, amount, status } = this.#options
    const snapshot = selectSnapshot(this.#state)
    const tone = resolveTone(this.#state)
    const currency = snapshot?.wallets[0]?.currency ?? 'CNY'

    root.dataset.tone = tone
    root.title = describe(this.#state)

    if (snapshot) {
      amount.textContent = formatAmount(snapshot.wallets[0]?.totalBalance ?? '0', currency)
      // 有旧数据但当前请求失败时，把金额标灰而不是清空：
      // 一个陈旧的数字比一片空白更有信息量，前提是要标明它陈旧。
      root.dataset.staleness = tone === 'error' || tone === 'stale' ? relativeAge(snapshot.fetchedAt) : ''
    } else {
      amount.textContent = this.#state.status === 'error' ? '获取失败' : '读取中'
      root.dataset.staleness = ''
    }

    status.dataset.tone = tone
  }
}

/** 状态 → 视觉基调。 */
function resolveTone(state: BalanceState): BadgeTone {
  switch (state.status) {
    case 'idle':
    case 'loading':
      return 'loading'
    case 'ready':
      return 'ok'
    case 'refreshing':
      return 'refreshing'
    case 'error':
      return state.staleSnapshot ? 'stale' : 'error'
  }
}

/**
 * 生成给 `title` 的详细说明。
 *
 * 余额只显示一个数字，出错原因、数据来源、读数时间都塞进 tooltip，
 * 既不占用桌面的视觉空间，又不至于让用户无从排查。
 *
 * @param state - 当前状态。
 * @returns 多行文本。
 */
function describe(state: BalanceState): string {
  const lines: string[] = ['DeepSeek API Token 余额']

  switch (state.status) {
    case 'idle':
      lines.push('状态：尚未读取')
      break
    case 'loading':
      lines.push('状态：读取中…')
      break
    case 'refreshing':
      lines.push(`状态：刷新中（当前为 ${relativeAge(state.snapshot.fetchedAt)}的数据）`)
      break
    case 'ready':
      lines.push(`状态：正常（${relativeAge(state.snapshot.fetchedAt)}更新）`)
      break
    case 'error':
      lines.push(`状态：失败 — ${state.error.message}`)
      if (state.staleSnapshot) {
        lines.push(`显示的是 ${relativeAge(state.staleSnapshot.fetchedAt)}的数据`)
      }
      break
  }

  const snapshot = selectSnapshot(state)
  if (snapshot) {
    for (const wallet of snapshot.wallets) {
      lines.push(
        `${wallet.currency}：总额 ${wallet.totalBalance}（充值 ${wallet.toppedUpBalance} / 赠送 ${wallet.grantedBalance}）`,
      )
    }
    if (!snapshot.isAvailable) lines.push('⚠ 账户当前不可用')
  }

  lines.push('双击宠物让它回家 · 右键打开菜单')
  return lines.join('\n')
}

/**
 * 把时间戳转成相对时间描述。
 *
 * @param timestamp - epoch 毫秒。
 * @returns 例如 `刚刚` / `3 分钟前`。
 */
function relativeAge(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
  if (seconds < 45) return '刚刚'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}
