/**
 * 滚轮缩放宠物。
 *
 * ## 单一真相是「窗口尺寸」
 *
 * 精灵的视觉大小并不单独存一份，而是完全由窗口边长推出来：
 *
 * ```
 * --pet-scale = 窗口边长 / PET_DESIGN_SIZE
 * ```
 *
 * 好处是渲染进程不需要知道"当前缩放比例是多少"这种状态。滚轮只负责请求
 * 一个新的窗口边长，主进程改完窗口后触发 `resize`，这里据此更新 CSS 变量，
 * 精灵就跟着变了。任何一方漏更新都不会造成两边不一致——
 * 因为比例只有一个来源。
 *
 * ## 为什么缩放在这一层，而不是让 `.pet-body` 一起缩放
 *
 * `.pet-body` 的 transform 每帧被 `pet.ts` 的 `#render()` 重写，且它的
 * `transform-origin` 是**底部**（挤压时要贴着地面）。从底部缩放会让宠物
 * 朝上长而不是原地变大。所以缩放在内层 `.pet-inner` 上做，origin 是中心。
 */

import { PET_DESIGN_SIZE, PET_SIZE_LIMITS } from '../../shared/config'
import type { PetBridge } from '../../shared/ipc'

/**
 * 两次向主进程发送尺寸的最小间隔（ms）。
 *
 * 滚轮事件在一秒内可以来几十次，每次都发 IPC 并触发窗口重排既没有必要
 * 也浪费。50ms ≈ 20Hz，肉眼看不出延迟。
 */
const SEND_INTERVAL_MS = 50

/** 把数值夹到闭区间内。 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** 构造参数。 */
export interface PetResizerOptions {
  /** 与主进程通信的桥。 */
  bridge: PetBridge
  /** 舞台元素，用来承载 `--pet-scale` 变量。 */
  stage: HTMLElement
  /** 宠物本体元素：只有指针真的压在它上面时才响应滚轮。 */
  body: HTMLElement
}

/** 滚轮缩放控制器。 */
export class PetResizer {
  readonly #bridge: PetBridge
  readonly #stage: HTMLElement
  readonly #body: HTMLElement

  /**
   * 最近一次请求的窗口边长。
   *
   * 用它而不是 `window.innerWidth` 作为下一格的基准：窗口改尺寸要经过
   * IPC 往返，连续快速滚动时 `innerWidth` 会落后好几格，导致步长变小、
   * 手感发滞。
   */
  #desiredSize: number | undefined

  /** 已排队但尚未执行的发送定时器。 */
  #flushTimer: number | undefined

  /** 上一次真正发送的时刻，用于限流。 */
  #lastSentAt = 0

  constructor(options: PetResizerOptions) {
    this.#bridge = options.bridge
    this.#stage = options.stage
    this.#body = options.body
  }

  /** 开始监听。 */
  start(): void {
    this.#applyScale()
    window.addEventListener('resize', this.#onResize)
    // passive: false —— 需要 preventDefault 阻止滚轮事件继续冒泡到页面滚动。
    window.addEventListener('wheel', this.#onWheel, { passive: false })
  }

  /** 解除监听。 */
  dispose(): void {
    window.removeEventListener('resize', this.#onResize)
    window.removeEventListener('wheel', this.#onWheel)
    if (this.#flushTimer !== undefined) {
      clearTimeout(this.#flushTimer)
      this.#flushTimer = undefined
    }
  }

  /** 窗口尺寸变化后重算缩放系数。 */
  #onResize = (): void => {
    this.#applyScale()
  }

  /**
   * 把当前窗口尺寸换算成精灵的缩放系数。
   *
   * `window.innerWidth` 就是窗口的 CSS 视口宽度，与 `setBounds` 使用的
   * DIP 一致，所以不需要任何换算。
   */
  #applyScale = (): void => {
    const scale = window.innerWidth / PET_DESIGN_SIZE
    this.#stage.style.setProperty('--pet-scale', scale.toFixed(4))
  }

  /**
   * 滚轮：向上变大，向下变小。
   *
   * 只在指针真的压在宠物本体上时才响应。窗口是个方形，四角是透明的，
   * 那些区域本来就不该吃事件——虽然命中测试通常已经把窗口设为穿透，
   * 但拖拽期间窗口整块都是可交互的，那时四个角也会收到滚轮。
   */
  #onWheel = (event: WheelEvent): void => {
    if (event.deltaY === 0) return
    if (!this.#isOverPet(event)) return

    // 阻止滚轮做别的事（页面缩放/滚动）。
    event.preventDefault()

    const current = this.#desiredSize ?? window.innerWidth
    const direction = event.deltaY < 0 ? 1 : -1
    // 按比例变步长：在 150px 和 400px 时，一格滚轮的"手感变化量"一致。
    const step = current * PET_SIZE_LIMITS.stepRatio
    const next = clamp(
      Math.round(current + direction * step),
      PET_SIZE_LIMITS.min,
      PET_SIZE_LIMITS.max,
    )

    if (next === this.#desiredSize) return
    this.#desiredSize = next
    this.#scheduleFlush()
  }

  /** 指针是否压在宠物本体上。 */
  #isOverPet(event: WheelEvent): boolean {
    const hit = document.elementFromPoint(event.clientX, event.clientY)
    if (hit === null) return false
    return hit === this.#body || this.#body.contains(hit)
  }

  /**
   * 限流地把期望尺寸发给主进程。
   *
   * 已经排了一个定时器就不再排：多次滚动会合并成一次发送，
   * 而 `#desiredSize` 始终是最新值，所以不会丢掉中间意图。
   */
  #scheduleFlush(): void {
    if (this.#flushTimer !== undefined) return

    const wait = Math.max(0, SEND_INTERVAL_MS - (performance.now() - this.#lastSentAt))
    this.#flushTimer = window.setTimeout(() => {
      this.#flushTimer = undefined
      const size = this.#desiredSize
      if (size === undefined) return

      this.#lastSentAt = performance.now()
      void this.#bridge.settings.patch({ windowSize: size }).catch((cause: unknown) => {
        console.warn('[dsh-token-pet] 发送缩放设置失败', cause)
      })
    }, wait)
  }
}
