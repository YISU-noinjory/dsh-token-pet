/**
 * 跨进程共享的默认配置与纯函数推导。
 *
 * 「纯」是这里的硬约束：`deriveMood` 被渲染进程每一帧调用，
 * 也被主进程用于托盘图标与提示文本，两侧必须得到完全一致的结果。
 */

import type { BalanceSnapshot, PetMood, PetSettings } from './types'

/**
 * 精灵的设计基准尺寸（DIP）。
 *
 * 渲染进程里耳朵、眼睛、嘴巴都是固定 px，无法随容器按比例缩放，
 * 所以精灵整体用一个 `transform: scale()` 缩放，而缩放系数的分母就是它：
 * `--pet-scale = 窗口边长 / PET_DESIGN_SIZE`。
 * 这样"宠物始终占窗口的 60%"这条比例关系在任何尺寸下都成立。
 */
export const PET_DESIGN_SIZE = 220

/**
 * 滚轮缩放的取值范围与步长。
 *
 * 下限 150：再小的话工具栏（约 24px）和余额徽章会挤在一起，
 * 连"换图 / 默认"两个按钮都点不准。
 * 上限 420：再大就会盖住太多桌面，也超出了精灵贴图的分辨率收益。
 */
export const PET_SIZE_LIMITS = {
  min: 150,
  max: 420,
  /** 每一格滚轮改变当前尺寸的这个比例——按比例而不是固定像素，手感才线性。 */
  stepRatio: 0.05,
} as const

/** 默认设置。可被 `pet.config.json` 与 IPC 的 `settings:patch` 覆盖。 */
export const DEFAULT_SETTINGS: PetSettings = {
  // 60s 是余额变化的合理分辨率：余额只在自己发起请求时下降，
  // 更密的轮询除了浪费配额没有额外信息量。
  pollIntervalMs: 60_000,
  windowSize: PET_DESIGN_SIZE,
  alwaysOnTop: true,
  clickThrough: false,
  // 阈值按人民币计价；USD 钱包按 7 折算后再比较（见 `deriveMood`）。
  lowBalanceThreshold: 5,
  warnBalanceThreshold: 20,
}

/** 情绪对应的主题色，主进程（托盘）与渲染进程（宠物）共用。 */
export const MOOD_COLORS: Record<PetMood, string> = {
  happy: '#3ecf8e',
  neutral: '#4c9aff',
  worried: '#f5a623',
  starving: '#f2545b',
  unknown: '#8b93a7',
}

/* ------------------------------------------------------------------ *
 * 自定义宠物图片的约束
 * ------------------------------------------------------------------ */

/** 宠物图片的导入限制。主进程与渲染进程共用，避免两边各写一套。 */
export const PET_IMAGE_LIMITS = {
  /**
   * 单张图片的体积上限（字节）。
   *
   * 20MB 的取值理由：一张 512×512 的 PNG 通常 < 500KB，
   * 而 GIF 动图很容易上到几 MB。20MB 既放得下合理的动图，
   * 又能在用户误选了几百 MB 的素材时立刻拦下，不至于把内存和
   * 合成器拖垮——毕竟这个图片每帧都在参与 Q弹形变。
   */
  maxBytes: 20 * 1024 * 1024,
  /** 选择框里展示的扩展名过滤。注意这只是"建议"，真正的判定靠文件头魔数。 */
  extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] as const,
  /**
   * 建议的源图尺寸（像素），仅用于提示文案。
   *
   * 不是硬限制：宠物显示区只有 132×132，过大的图会被 `object-fit: contain`
   * 缩下去，但解码成本仍按原图算，动图尤其明显。
   */
  recommendedSize: 512,
} as const

/** 把字节数格式化成便于阅读的 MB 文本。 */
export function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)}MB`
}

/** 人民币对美元的比较汇率；仅用于阈值比较，不用于展示。 */
const CNY_PER_USD = 7

/**
 * 把金额字符串解析为可用于阈值比较的数值。
 *
 * 用 `Number.parseFloat` 而不是 `Number()`：服务端可能返回 `"1,234.56"`
 * 这类带分隔符的字符串，`Number()` 会得到 `NaN`。
 *
 * @param amount - 服务端返回的十进制金额字符串。
 * @returns 解析后的数值；无法解析时为 `0`，让调用方走「耗尽」分支而不是「健康」分支。
 */
export function parseAmount(amount: string): number {
  const parsed = Number.parseFloat(amount.replace(/,/g, ''))
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * 从余额快照推导宠物情绪。
 *
 * 取所有钱包折算成人民币后的**最小值**作为水位：
 * 只要有一个钱包见底，宠物就该表现出饿的状态，而不是被另一个钱包的余额掩盖。
 *
 * @param snapshot - 最近一次成功的余额读数。
 * @param settings - 阈值来源，默认取 {@link DEFAULT_SETTINGS}。
 * @returns 情绪；`snapshot` 为 `undefined` 时为 `'unknown'`。
 */
export function deriveMood(
  snapshot: BalanceSnapshot | undefined,
  settings: Pick<PetSettings, 'lowBalanceThreshold' | 'warnBalanceThreshold'> = DEFAULT_SETTINGS,
): PetMood {
  if (!snapshot) return 'unknown'
  if (!snapshot.isAvailable) return 'starving'
  if (snapshot.wallets.length === 0) return 'unknown'

  const waterLevel = Math.min(
    ...snapshot.wallets.map((wallet) => {
      const total = parseAmount(wallet.totalBalance)
      return wallet.currency === 'USD' ? total * CNY_PER_USD : total
    }),
  )

  if (waterLevel <= 0) return 'starving'
  if (waterLevel < settings.lowBalanceThreshold) return 'worried'
  if (waterLevel < settings.warnBalanceThreshold) return 'neutral'
  return 'happy'
}

/**
 * 取状态机中「当前可展示」的快照。
 *
 * @param state - 余额状态机。
 * @returns 可展示的快照；从未成功过时为 `undefined`。
 */
export function selectSnapshot(
  state: import('./types').BalanceState,
): BalanceSnapshot | undefined {
  switch (state.status) {
    case 'ready':
    case 'refreshing':
      return state.snapshot
    case 'error':
      return state.staleSnapshot
    case 'idle':
    case 'loading':
      return undefined
  }
}

/**
 * 格式化金额用于展示。
 *
 * @param amount - 十进制金额字符串。
 * @param currency - 币种，决定符号。
 * @returns 形如 `¥110.00` / `$3.50` 的展示文本。
 */
export function formatAmount(amount: string, currency: 'CNY' | 'USD'): string {
  const symbol = currency === 'CNY' ? '¥' : '$'
  const value = parseAmount(amount)
  return `${symbol}${value.toFixed(2)}`
}
