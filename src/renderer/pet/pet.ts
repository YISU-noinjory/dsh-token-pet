/**
 * 宠物实体：把「物理状态」翻译成「形变」。
 *
 * ## 职责边界
 *
 * 本类**不决定宠物在屏幕上的位置**——那是主进程的事（见 window-physics.ts）。
 * 它决定的是：在主进程给定的窗口位置上，这个精灵当下该被压多扁、拉多长、歪多少。
 *
 * 这个划分带来一个很自然的效果：窗口被甩出去时主进程会推送速度，
 * 精灵据此沿运动方向拉长；窗口撞墙急停时速度骤降，精灵却因为弹簧惯性
 * 继续往前冲，于是被压扁——**"Q弹"本质上是精灵与窗口之间的速度差**，
 * 而不是任何一条预设的关键帧动画。
 *
 * ## 两条输入通路
 *
 *  1. 指针事件（pointerdown/move/up）→ 表达用户意图。位置信息交给主进程，
 *     这里只负责判定「这是点击还是拖拽」并提供释放速度。
 *  2. 运动帧（motion / motionState / impact）→ 表达世界的反馈。
 *
 * ## 变换的所有权
 *
 * JS 只写 `.pet-body` 的 `transform`；呼吸这类自发动画交给 CSS keyframes
 * 作用在内层元素上。两者作用于不同元素，因此永不互相覆盖——
 * 这是内联 style 与 CSS 动画能共存的唯一干净方式。
 */

import type { ImpactPayload, PetBridge } from '../../shared/ipc'
import type { MotionFrame, PetMood, WindowMotionState } from '../../shared/types'
import {
  SPRING_PRESETS,
  Spring,
  Spring2D,
  VelocityTracker,
  clamp,
  velocityStretch,
  volumePreservingScaleX,
} from './physics'

/** 构造选项。 */
export interface PetOptions {
  /** 承载宠物的舞台元素；用于读取可用空间，本身不变形。 */
  readonly stage: HTMLElement
  /** 实际施加 transform 的元素。 */
  readonly body: HTMLElement
  /** 与主进程通信的桥。 */
  readonly bridge: PetBridge
}

/** 超过这个位移（屏幕 px）才判定为拖拽，否则算点击。 */
const DRAG_THRESHOLD_PX = 4
/** 按住时的垂直压缩比例。 */
const PRESSED_SCALE_Y = 0.86
/** 滞后偏移的幅度上限（px）。窗口瞬移时防止精灵被甩出容器。 */
const MAX_LAG_PX = 26
/** 速度换算拉伸的参考速度（px/s）。越小越"敏感"。 */
const STRETCH_REFERENCE_SPEED = 1800
/** 最大额外拉伸比例。 */
const MAX_STRETCH = 0.32
/** 倾斜角上限（度）。 */
const MAX_TILT_DEG = 14

export class Pet {
  readonly #stage: HTMLElement
  readonly #body: HTMLElement
  readonly #bridge: PetBridge

  /* --- 形变弹簧 --- */
  /** 精灵相对窗口的滞后偏移。窗口动了、精灵没跟上，偏移就被拉开。 */
  readonly #lag = new Spring2D(SPRING_PRESETS.follow, 0, 0)
  /** 垂直缩放。挤压/拉伸的主轴。 */
  readonly #scaleY = new Spring(SPRING_PRESETS.bouncy, 1)
  /** 水平缩放。目标值由 #scaleY 推导（体积守恒），弹簧只提供一点跟随延迟。 */
  readonly #scaleX = new Spring(SPRING_PRESETS.bouncy, 1)
  /** 倾斜角（度），由水平滞后量驱动。 */
  readonly #tilt = new Spring(SPRING_PRESETS.stiff, 0)

  /* --- 指针状态 --- */
  readonly #tracker = new VelocityTracker()
  #pointerId: number | undefined
  #pressed = false
  #dragging = false
  /** 按下时的屏幕坐标，用于判定是否越过拖拽阈值。 */
  #pressOrigin = { x: 0, y: 0 }
  /** 本帧是否有待发送的拖拽位置更新（用于把高频 pointermove 合并成每帧一次 IPC）。 */
  #pendingDragMove = false

  /* --- 世界状态 --- */
  #motion: MotionFrame | undefined
  #windowState: WindowMotionState = 'resting'
  #mood: PetMood = 'unknown'

  /* --- 循环 --- */
  #rafHandle = 0
  #lastFrameAt = 0
  #disposed = false

  constructor(options: PetOptions) {
    this.#stage = options.stage
    this.#body = options.body
    this.#bridge = options.bridge
  }

  /** 绑定事件并启动动画循环。 */
  start(): void {
    if (this.#disposed) throw new Error('Pet 实例已销毁，不能重新启动')
    const body = this.#body
    body.addEventListener('pointerdown', this.#onPointerDown)
    body.addEventListener('pointermove', this.#onPointerMove)
    body.addEventListener('pointerup', this.#onPointerUp)
    body.addEventListener('pointercancel', this.#onPointerCancel)
    body.addEventListener('dblclick', this.#onDoubleClick)
    // 注意：不拦截 contextmenu —— 主进程监听 webContents 的 'context-menu'
    // 事件来弹出原生菜单，在这里 preventDefault 会让那个事件不再触发。

    this.#lastFrameAt = performance.now()
    this.#rafHandle = requestAnimationFrame(this.#frame)
  }

  /** 解绑并停止。必须调用，否则事件监听与 rAF 会随窗口存活而泄漏。 */
  dispose(): void {
    this.#disposed = true
    cancelAnimationFrame(this.#rafHandle)
    const body = this.#body
    body.removeEventListener('pointerdown', this.#onPointerDown)
    body.removeEventListener('pointermove', this.#onPointerMove)
    body.removeEventListener('pointerup', this.#onPointerUp)
    body.removeEventListener('pointercancel', this.#onPointerCancel)
    body.removeEventListener('dblclick', this.#onDoubleClick)
  }

  /** 本体元素，供外部的命中测试判断指针是否落在宠物上。 */
  get bodyElement(): HTMLElement {
    return this.#body
  }

  /**
   * 是否正被用户"抓住"（按住或拖拽中）。
   *
   * 命中测试需要它：拖拽时指针一定会离开宠物本体（窗口跟着手跑，
   * 指针却可能压到宠物边缘之外），如果此时把窗口切成穿透，
   * 拖拽会当场断掉。所以抓着的时候必须强制保持可交互。
   */
  get isEngaged(): boolean {
    return this.#pressed || this.#dragging
  }

  /* ---------------------------------------------------------------- *
   * 外部输入
   * ---------------------------------------------------------------- */

  /**
   * 设置情绪。通过 data 属性交给 CSS 处理配色，
   * 这样"情绪长什么样"完全留在样式表里，JS 不掺和颜色。
   *
   * @param mood - 由余额水位推导出的情绪。
   */
  setMood(mood: PetMood): void {
    if (this.#mood === mood) return
    this.#mood = mood
    this.#stage.dataset.mood = mood
  }

  /**
   * 接收主进程的运动帧。
   *
   * 这里的关键一步是把窗口位移**反向**加到滞后偏移上：
   * 窗口向右走了 dx，精灵应当相对窗口向左落后 dx。
   * 随后 {@link Spring2D} 会把偏移拉回 0，于是产生"跟上来"的回弹。
   *
   * @param frame - 主进程推送的运动数据。
   */
  onMotion(frame: MotionFrame): void {
    this.#motion = frame

    this.#lag.x.value = clamp(this.#lag.x.value - frame.delta.x, -MAX_LAG_PX, MAX_LAG_PX)
    this.#lag.y.value = clamp(this.#lag.y.value - frame.delta.y, -MAX_LAG_PX, MAX_LAG_PX)
  }

  /**
   * 接收窗口物理状态。
   *
   * @param state - 主进程的宏观状态。
   */
  onMotionState(state: WindowMotionState): void {
    this.#windowState = state
    this.#stage.dataset.motion = state
  }

  /**
   * 落地/撞墙：给弹簧一个冲量。
   *
   * 用冲量而不是直接改 target，是因为冲量作用于**速度**，
   * 弹簧会自然地先压过头再弹回来——这正是"砸在地上"的观感。
   * 改 target 则只会得到一个平滑的位置移动，毫无冲击力。
   *
   * @param payload - 撞击方向与速度。
   */
  onImpact(payload: ImpactPayload): void {
    // 归一化到 0~1，超过 1600px/s 的撞击不再增强（否则重甩时会压成一张饼）。
    const magnitude = clamp(payload.speed / 1600, 0, 1)

    if (payload.vertical === 1) {
      // 落地：垂直压扁。
      this.#scaleY.impulse(-9 * magnitude)
    } else if (payload.vertical === -1) {
      // 撞天花板：垂直拉长。
      this.#scaleY.impulse(6 * magnitude)
    }

    if (payload.horizontal !== 0) {
      // 撞侧墙：水平压缩。
      this.#scaleX.impulse(-7 * magnitude)
      // 顺带歪一下，像是被拍在墙上。
      this.#tilt.impulse(payload.horizontal * 60 * magnitude)
    }
  }

  /* ---------------------------------------------------------------- *
   * 指针
   * ---------------------------------------------------------------- */

  #onPointerDown = (event: PointerEvent): void => {
    // 只处理主键；右键留给原生上下文菜单。
    if (event.button !== 0) return
    this.#pointerId = event.pointerId
    // 捕获指针：拖到窗口外（拖拽时窗口就在动）也能继续收到事件。
    this.#body.setPointerCapture(event.pointerId)
    this.#pressed = true
    this.#dragging = false
    this.#pressOrigin = { x: event.screenX, y: event.screenY }
    this.#tracker.reset()
    this.#tracker.sample(event.screenX, event.screenY, performance.now())
    // 尽早开始采样：拖拽阈值是在 move 里判定的，
    // 如果等到越过阈值才开始采样，释放速度会缺掉最初那段。
  }

  #onPointerMove = (event: PointerEvent): void => {
    if (this.#pointerId !== event.pointerId) return
    this.#tracker.sample(event.screenX, event.screenY, performance.now())

    if (!this.#dragging) {
      const dx = event.screenX - this.#pressOrigin.x
      const dy = event.screenY - this.#pressOrigin.y
      // 阈值内不动窗口：否则每次单击都会让宠物"哆嗦"一下位置。
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
      this.#dragging = true
      // 一旦开始拖拽，按下的挤压效果就该让位给拖拽形变。
      this.#pressed = false
      void this.#bridge.drag.start()
    }

    // 只置标志位，真正的 IPC 在动画帧里发（见 #frame）。
    this.#pendingDragMove = true
  }

  #onPointerUp = (event: PointerEvent): void => {
    if (this.#pointerId !== event.pointerId) return
    this.#releasePointer(event.pointerId)

    if (this.#dragging) {
      const velocity = this.#tracker.velocity()
      this.#dragging = false
      // 把高频指针采样得到的释放速度交给主进程做抛掷。
      void this.#bridge.drag.end({ velocity })
    } else {
      // 单击：松开时向上给一个冲量，弹簧会先拉长再回弹，
      // 配合体积守恒，观感就是"啵"地弹回来。
      this.#scaleY.impulse(7)
    }

    this.#pressed = false
  }

  #onPointerCancel = (event: PointerEvent): void => {
    if (this.#pointerId !== event.pointerId) return
    this.#releasePointer(event.pointerId)
    if (this.#dragging) {
      this.#dragging = false
      // 取消时速度归零，避免宠物被"幽灵甩"出去。
      void this.#bridge.drag.end({ velocity: { x: 0, y: 0 } })
    }
    this.#pressed = false
  }

  #onDoubleClick = (): void => {
    void this.#bridge.pet.return()
  }

  /** 释放指针捕获并清空指针状态。 */
  #releasePointer(pointerId: number): void {
    this.#pointerId = undefined
    this.#pendingDragMove = false
    if (this.#body.hasPointerCapture(pointerId)) {
      this.#body.releasePointerCapture(pointerId)
    }
  }

  /* ---------------------------------------------------------------- *
   * 动画循环
   * ---------------------------------------------------------------- */

  #frame = (now: number): void => {
    if (this.#disposed) return
    this.#rafHandle = requestAnimationFrame(this.#frame)

    // dt 限幅：切走标签页再回来时 now 可能跳好几秒，直接积分会炸。
    const dt = Math.min(Math.max((now - this.#lastFrameAt) / 1000, 0), 1 / 30)
    this.#lastFrameAt = now

    // 把本帧内累积的所有 pointermove 合并成一次 IPC。
    // 120Hz 鼠标 + 60Hz 渲染 = 每帧最多一次，而不是每次 move 一次。
    if (this.#dragging && this.#pendingDragMove) {
      this.#pendingDragMove = false
      void this.#bridge.drag.move()
    }

    this.#updateTargets()
    this.#stepSprings(dt)
    this.#render()
  }

  /** 每帧根据当前世界状态重算弹簧目标值。 */
  #updateTargets(): void {
    const velocity = this.#motion?.velocity ?? { x: 0, y: 0 }
    const airborne = this.#windowState === 'flying' || this.#windowState === 'bouncing'

    // 速度越大，沿运动轴拉得越长。
    const stretchX = velocityStretch(Math.abs(velocity.x), STRETCH_REFERENCE_SPEED, MAX_STRETCH)
    const stretchY = velocityStretch(Math.abs(velocity.y), STRETCH_REFERENCE_SPEED, MAX_STRETCH)

    // 垂直缩放的目标：按住时压扁，其余情况由速度决定。
    const targetScaleY = this.#pressed ? PRESSED_SCALE_Y : stretchY
    this.#scaleY.target = targetScaleY

    // 水平缩放由**当前的** #scaleY.value 推出，而不是 target。
    // 用 value 才能让两个轴在同一时刻保持体积守恒；
    // 用 target 会让 X 比 Y 早一步到位，压缩看起来是"错开"的。
    // 再乘上水平速度带来的额外拉伸（自由飞行时沿运动方向被拉长）。
    const volumeLocked = airborne || this.#pressed || !this.#scaleY.isAtRest
    this.#scaleX.target = volumeLocked
      ? volumePreservingScaleX(this.#scaleY.value) * stretchX
      : volumePreservingScaleX(this.#scaleY.value)

    // 倾斜：水平滞后越大，歪得越多，像是被拖着走。
    this.#tilt.target = clamp(this.#lag.x.value * 0.5, -MAX_TILT_DEG, MAX_TILT_DEG)
  }

  /** 推进所有弹簧。 */
  #stepSprings(dt: number): void {
    this.#lag.step(dt)
    this.#scaleY.step(dt)
    this.#scaleX.step(dt)
    this.#tilt.step(dt)
  }

  /**
   * 写 DOM。
   *
   * 静止时直接返回：弹簧收敛后每帧的 transform 完全相同，
   * 继续写 style 会让 Chromium 每帧都重算样式与合成层，白耗电。
   */
  #render(): void {
    if (this.#isAtRest()) return

    const lagX = this.#lag.x.value
    const lagY = this.#lag.y.value

    // 滞后偏移同时写进舞台的 CSS 变量，让余额徽章与工具栏跟着精灵一起位移。
    //
    // 它们是相对**窗口**绝对定位的，而精灵有自己的滞后偏移。不跟着走的话，
    // 拖拽时精灵会被拉开最多 26px 而它们留在原地——实测精灵下移 26px 时，
    // 下方间隙会从 +17.6px 变成 −8.4px，也就是精灵直接压在余额徽章上。
    // 拖拽全程滞后都钉在上限，所以这个错位是持续可见的，不是一闪而过。
    const stage = this.#stage
    stage.style.setProperty('--pet-lag-x', `${lagX.toFixed(2)}px`)
    stage.style.setProperty('--pet-lag-y', `${lagY.toFixed(2)}px`)

    this.#body.style.transform =
      `translate3d(${lagX.toFixed(2)}px, ${lagY.toFixed(2)}px, 0) ` +
      `rotate(${this.#tilt.value.toFixed(2)}deg) ` +
      `scale(${this.#scaleX.value.toFixed(4)}, ${this.#scaleY.value.toFixed(4)})`
  }

  /**
   * 是否处于静止。
   *
   * 除了弹簧收敛，还必须考虑「保持按住的压缩状态」与「正在拖拽」：
   * 这两种情况下弹簧已经到位，但状态随时可能因为下一次输入而改变，
   * 不能提前进入跳帧。
   */
  #isAtRest(): boolean {
    if (this.#pressed || this.#dragging) return false
    return (
      this.#lag.isAtRest && this.#scaleY.isAtRest && this.#scaleX.isAtRest && this.#tilt.isAtRest
    )
  }
}
