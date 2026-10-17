/**
 * 宠物窗口的宏观物理模拟。
 *
 * 为什么放在主进程而不是渲染进程：
 *  1. 「桌面」的边界是显示器工作区（含多显示器、任务栏高度），
 *     只有主进程通过 `screen` 模块拿得到；
 *  2. 窗口位置本身就只能在主进程改（`BrowserWindow.setPosition`），
 *     渲染进程算完再跨 IPC 传过去，会慢一帧且抖动。
 *
 * 分工结论：
 *  - 主进程 = 窗口**在哪**（拖拽跟随、甩抛惯性、重力、撞墙反弹、回位）；
 *  - 渲染进程 = 宠物**长什么样**（滞后形变、挤压、拉伸）。
 *
 * ## 位置状态归模拟器所有，窗口只是它的投影
 *
 * 这是本文件最重要的一条设计约束。`BrowserWindow.setPosition` 只接受整数，
 * 如果模拟器把窗口坐标**读回来**当作自己的位置状态，就会撞上一个隐蔽的死锁：
 *
 *   位置被量化到整像素 → 弹簧的平衡速度只够让位置移动 0.24px（不足半像素）
 *   → 取整后又回到同一个整数 → 弹簧力不减小 → 速度停在"阻尼恰好抵消弹力"
 *   的平衡值 → 位置永远不变。
 *
 * 实测表现是宠物悬停在离锚点 17px 的地方再也不动。因此模拟器维护自己的
 * 浮点 `#x/#y`，只在写窗口时取整；`measure()` 仅在启动与拖拽开始时用于
 * 采集真实位置和窗口尺寸。
 *
 * ## 为什么拖拽位置由主进程自己读光标
 *
 * 直觉上应该由渲染进程把 `MouseEvent.screenX/Y` 通过 IPC 送过来。
 * 但那条路有一个同样隐蔽的坑：`screenX` 的单位是 CSS 像素，其"屏幕原点"
 * 与 `BrowserWindow.setPosition` 使用的 DIP 坐标在**多显示器不同缩放比**
 * 的场景下并不总是同源。一旦对不上，宠物会随显示器漂移，
 * 而且这种 bug 只在特定硬件配置上复现，极难排查。
 *
 * 因此这里改用 `screen.getCursorScreenPoint()` 作为权威位置源：
 * 它和 `setPosition` 出自同一个坐标系，天然一致；
 * 渲染进程只需要告诉主进程「开始拖了 / 松手了」。
 * 渲染进程的指针速度采样仍然有价值（输入设备的事件频率高于
 * 主进程 125Hz 的轮询），所以松手时优先采用它给出的速度。
 *
 * 本类不引用 Electron：位置通过注入的 `setPosition` 回调写回，
 * 几何通过 `measure` / `workAreaAt` / `cursorPoint` 回调查询。
 * 这样整个模拟器可以在纯 Node 环境里单测。
 */

import type { MotionFrame, WindowMotionState } from '../shared/types'

/** 窗口在屏幕上的矩形（与 Electron 的 Rectangle 结构一致，此处自行声明以解耦）。 */
export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/** 物理参数。 */
export interface WindowPhysicsOptions {
  /** 重力加速度（px/s²），抛掷后下落用。 */
  readonly gravity: number
  /** 撞墙/落地的法向速度保留比例，0 表示完全吸收（不弹）。 */
  readonly restitution: number
  /** 地面水平摩擦：每次地面碰撞保留的水平速度比例。 */
  readonly groundFriction: number
  /** 空气阻力：每秒保留的速度比例（指数衰减）。 */
  readonly airRetention: number
  /** 判定「停稳」的速度阈值（px/s）。 */
  readonly restSpeed: number
  /** 停稳后归位前原地停留的时长（ms）。 */
  readonly idleBeforeReturnMs: number
  /** 归位弹簧的劲度系数。 */
  readonly returnStiffness: number
  /** 归位弹簧的阻尼系数。 */
  readonly returnDamping: number
  /** 模拟推进的固定步长上限（s）；超出则拆成多步，避免数值爆炸。 */
  readonly maxStepSeconds: number
  /** 运动帧的最小推送间隔（ms），用于节流 IPC。 */
  readonly motionThrottleMs: number
  /** 触发撞击事件的额外速度阈值（px/s），避免落地后的细微抖动反复触发。 */
  readonly impactSpeedThreshold: number
}

/** 默认参数：手感取向是「重、不弹跳过头、有黏性」。 */
export const DEFAULT_PHYSICS: WindowPhysicsOptions = {
  gravity: 2600,
  restitution: 0.52,
  groundFriction: 0.82,
  airRetention: 0.55,
  restSpeed: 24,
  idleBeforeReturnMs: 4000,
  returnStiffness: 26,
  returnDamping: 7.5,
  maxStepSeconds: 1 / 240,
  motionThrottleMs: 16,
  impactSpeedThreshold: 60,
}

/** 模拟器依赖的外部能力。 */
export interface WindowPhysicsHost {
  /** 读当前窗口矩形（用于初始化与采集尺寸，不作为每帧的位置来源）。 */
  measure(): Bounds
  /** 写回窗口位置（整数）。 */
  setPosition(x: number, y: number): void
  /** 查询包含给定屏幕坐标的显示器工作区。 */
  workAreaAt(x: number, y: number): Bounds
  /**
   * 所有显示器工作区的并集（虚拟桌面的可用范围）。
   *
   * 拖拽时用它约束窗口，而不是用"窗口所在的单块显示器"：后者会让窗口
   * 被夹在 A 屏右边缘、中心永远够不到边界，**跨屏拖拽直接卡死**。
   * 并集则允许窗口在相邻显示器之间自由移动，同时挡住最外侧的越界。
   */
  unionWorkArea(): Bounds
  /** 读光标屏幕坐标，与 `setPosition` 同坐标系。 */
  cursorPoint(): { x: number; y: number }
  /** 推送运动帧给渲染进程。 */
  onFrame(frame: MotionFrame): void
  /** 状态迁移通知。 */
  onStateChange(state: WindowMotionState): void
  /** 撞击通知。 */
  onImpact(horizontal: -1 | 0 | 1, vertical: -1 | 0 | 1, speed: number): void
}

/** 模拟推进的节拍（ms）。8ms ≈ 125Hz，高于 60Hz 的显示刷新，留出插值余量。 */
const TICK_MS = 8

/** 单次拖拽位移超过该值时，拖拽速度估计才可信（滤掉静止时的抖动）。 */
const DRAG_VELOCITY_FLOOR_MS = 1

export class WindowPhysics {
  readonly #options: WindowPhysicsOptions
  readonly #host: WindowPhysicsHost

  /**
   * 权威位置（浮点）。
   *
   * 绝不是"缓存"——它就是真实状态。窗口坐标是它的整数投影，
   * 把投影读回来当状态会导致上面的死锁。
   */
  #x = 0
  #y = 0
  /** 窗口尺寸，首次测量后缓存（尺寸在运行期不变）。 */
  #size: { width: number; height: number } | undefined

  /** 当前速度（px/s）。拖拽期间它表示窗口的跟随速度。 */
  #vx = 0
  #vy = 0
  /** 拖拽时指针相对窗口左上角的偏移，保证抓哪儿走哪儿。 */
  #grabOffsetX = 0
  #grabOffsetY = 0
  /** 上一次拖拽采样的光标位置与时刻，用于估计跟随速度。 */
  #lastCursor: { x: number; y: number; at: number } | undefined
  /** 停稳的时刻（epoch ms），`undefined` 表示未进入停稳态。 */
  #restedAt: number | undefined
  #state: WindowMotionState = 'resting'
  /** 宠物「家」的位置，归位弹簧的目标。 */
  #anchor: { x: number; y: number } | undefined
  #ticker: NodeJS.Timeout | undefined
  #lastTickAt = 0
  #lastFrameAt = 0
  #lastPosition: { x: number; y: number } | undefined

  constructor(options: WindowPhysicsOptions, host: WindowPhysicsHost) {
    this.#options = options
    this.#host = host
  }

  /** 当前物理状态。 */
  get state(): WindowMotionState {
    return this.#state
  }

  /** 当前浮点位置，供测试与诊断使用。 */
  get position(): { x: number; y: number } {
    return { x: this.#x, y: this.#y }
  }

  /** 设定归位锚点。 */
  setAnchor(x: number, y: number): void {
    this.#anchor = { x, y }
  }

  /**
   * 直接移动到指定位置并停稳，同时把「家」改到这里。
   *
   * 托盘的「把宠物叫回来」用它：用户按这个菜单项是要**立刻**看到宠物，
   * 不是看它从屏幕外飞过来，所以不做弹簧动画，直接落位。
   *
   * @param x - 目标屏幕 X。
   * @param y - 目标屏幕 Y。
   */
  moveTo(x: number, y: number): void {
    this.#x = x
    this.#y = y
    this.#vx = 0
    this.#vy = 0
    // 清掉停稳时刻：否则下一次 tick 会立刻触发"停稳后自动归位"。
    this.#restedAt = undefined
    this.#host.setPosition(Math.round(x), Math.round(y))
    this.setAnchor(x, y)
    this.#setState('resting')
    this.#emitFrame(true)
  }

  /**
   * 窗口尺寸变了之后重新对齐。
   *
   * 滚轮缩放会改变窗口边长，而模拟器缓存了尺寸（`#measureSize`）并持有
   * 自己的浮点位置。不同步的话会出现两个问题：
   *  - 边界夹取仍按旧尺寸算，大尺寸时宠物能越界、小尺寸时又离边界太远；
   *  - `#lastPosition` 是旧的，下一帧算出的 `delta` 会是一大截突变，
   *    精灵会被这一帧的滞后量猛地拉一下。
   *
   * 所以这里把位置、尺寸、上一帧位置一次性对齐，并把「家」也挪到新位置——
   * 用户是在原地缩放，宠物不该因为尺寸变了就想着跑回旧坐标。
   */
  refreshGeometry(): void {
    this.#syncFromWindow()
    this.#lastPosition = { x: this.#x, y: this.#y }
    this.#vx = 0
    this.#vy = 0
    this.setAnchor(this.#x, this.#y)
    this.ensureOnScreen()
  }

  /**
   * 把窗口拉回可见区域。
   *
   * 拔掉显示器、改分辨率或改缩放比例之后，窗口可能停在已经不存在的坐标上——
   * 表现就是"宠物不见了"，而进程和窗口其实都还在。这个方法是那种情况的兜底。
   *
   * 不需要传目标显示器：`workAreaAt` 用当前位置查询，`getDisplayNearestPoint`
   * 会返回离它最近的那块屏，于是窗口自然被收拢到最近的可见区域。
   */
  ensureOnScreen(): void {
    const size = this.#measureSize()
    const work = this.#host.workAreaAt(this.#x + size.width / 2, this.#y + size.height / 2)

    // 工作区比窗口还小时（极端缩放）用 max 兜底，否则 clamp 的下界会大于上界。
    const maxX = Math.max(work.x, work.x + work.width - size.width)
    const maxY = Math.max(work.y, work.y + work.height - size.height)
    const x = clamp(this.#x, work.x, maxX)
    const y = clamp(this.#y, work.y, maxY)

    if (Math.round(x) === Math.round(this.#x) && Math.round(y) === Math.round(this.#y)) return

    this.#x = x
    this.#y = y
    this.#vx = 0
    this.#vy = 0
    this.#host.setPosition(Math.round(x), Math.round(y))
    this.#emitFrame(true)
  }

  /**
   * 锚点当前是否完整落在某块显示器的可见工作区内。
   *
   * 显示器配置变化后，原来的「家」可能已经不在任何屏幕上了；
   * 此时若还保留旧锚点，"停稳后自动归位"会把宠物送回一个看不见的坐标。
   *
   * @returns 锚点可见时为 `true`；尚未设定锚点时为 `false`。
   */
  isAnchorOnScreen(): boolean {
    const anchor = this.#anchor
    if (!anchor) return false
    const size = this.#measureSize()
    const work = this.#host.workAreaAt(anchor.x + size.width / 2, anchor.y + size.height / 2)
    return (
      anchor.x >= work.x &&
      anchor.y >= work.y &&
      anchor.x + size.width <= work.x + work.width &&
      anchor.y + size.height <= work.y + work.height
    )
  }

  /** 启动模拟循环。 */
  start(): void {
    if (this.#ticker) return
    // 先与真实窗口对齐一次，否则第一帧会从 (0,0) 跳过去。
    this.#syncFromWindow()
    this.#lastTickAt = performance.now()
    this.#ticker = setInterval(() => this.#tick(), TICK_MS)
    // 这个定时器不应该拖住进程退出。
    this.#ticker.unref?.()
  }

  /** 停止模拟循环。 */
  stop(): void {
    if (!this.#ticker) return
    clearInterval(this.#ticker)
    this.#ticker = undefined
  }

  /* ---------------------------------------------------------------- *
   * 拖拽
   * ---------------------------------------------------------------- */

  /**
   * 开始拖拽。
   *
   * 记录「指针在窗口内的抓取点」：后续移动时窗口按这个偏移跟随，
   * 而不是把窗口中心吸到指针上——后者会让宠物在按下瞬间跳一下。
   */
  beginDrag(): void {
    // 拖拽前重新对齐：窗口可能被用户或系统移动过。
    this.#syncFromWindow()
    const cursor = this.#host.cursorPoint()
    this.#grabOffsetX = cursor.x - this.#x
    this.#grabOffsetY = cursor.y - this.#y
    this.#vx = 0
    this.#vy = 0
    this.#lastCursor = { x: cursor.x, y: cursor.y, at: performance.now() }
    this.#restedAt = undefined
    console.log(
      `[dsh-token-pet] 开始拖拽：窗口 (${Math.round(this.#x)}, ${Math.round(this.#y)})，` +
        `光标 (${cursor.x}, ${cursor.y})，抓取偏移 (${this.#grabOffsetX}, ${this.#grabOffsetY})`,
    )
    this.#setState('dragging')
  }

  /**
   * 拖拽跟随：把窗口移到「光标 − 抓取偏移」的位置，并约束在虚拟桌面内。
   *
   * 不接收坐标参数，而是自己读光标——原因见文件头注释。
   *
   * ## 为什么要约束
   *
   * 窗口位置 = 光标 − 抓取偏移，所以抓取点越靠近宠物左上角，窗口就越贴近光标。
   * 光标抵到屏幕边缘时，窗口会有一大截（最多一个窗口宽）被推到屏幕外——
   * 用户看到的就是"宠物滑出去了"，而且可能再也抓不回来。
   * 自由飞行阶段本来就有边界反弹，只有拖拽这一条路径漏了。
   *
   * 边界取**所有显示器工作区的并集**而不是单块屏（理由见 `unionWorkArea`）。
   */
  dragTo(): void {
    const cursor = this.#host.cursorPoint()
    const size = this.#measureSize()
    const area = this.#host.unionWorkArea()

    // 工作区比窗口还小时用 max 兜底，否则 clamp 的下界会大于上界。
    const maxX = Math.max(area.x, area.x + area.width - size.width)
    const maxY = Math.max(area.y, area.y + area.height - size.height)
    const targetX = clamp(cursor.x - this.#grabOffsetX, area.x, maxX)
    const targetY = clamp(cursor.y - this.#grabOffsetY, area.y, maxY)

    this.#updateDragVelocity(cursor)

    this.#x = targetX
    this.#y = targetY
    this.#host.setPosition(Math.round(targetX), Math.round(targetY))
    // 拖拽时强制推帧：跟手效果不能受节流影响。
    this.#emitFrame(true)
  }

  /**
   * 结束拖拽并施加释放速度。
   *
   * @param rendererVelocityX - 渲染进程采样出的光标速度（px/s）。输入设备的事件
   *   频率通常高于主进程 125Hz 的轮询，所以它更准；缺省时退回主进程自己的估计。
   * @param rendererVelocityY - 同上。
   */
  endDrag(rendererVelocityX?: number, rendererVelocityY?: number): void {
    // 速度上限：人手甩不出 6000px/s，但故障的采样会，限幅可避免宠物飞出屏幕。
    const MAX_RELEASE_SPEED = 6000

    /**
     * 「放下」与「甩出」的分界速度（px/s）。
     *
     * 低于它视为**有意放置**：宠物停在原地，并把这里当成新的家。
     * 高于它才是甩抛，让物理引擎去飞、去弹。
     *
     * 不区分这两者会导致一个很反直觉的行为：用户轻轻把宠物挪到别处、
     * 松手，它也会立刻自由落体摔到屏幕底部——无论放得多小心都一样。
     * 400px/s 大致是"手停下来"与"有意一甩"之间的分界。
     */
    const THROW_SPEED_THRESHOLD = 400

    const sourceX = rendererVelocityX ?? this.#vx
    const sourceY = rendererVelocityY ?? this.#vy
    this.#vx = clamp(sourceX, -MAX_RELEASE_SPEED, MAX_RELEASE_SPEED)
    this.#vy = clamp(sourceY, -MAX_RELEASE_SPEED, MAX_RELEASE_SPEED)
    this.#lastCursor = undefined
    this.#restedAt = undefined

    const speed = Math.hypot(this.#vx, this.#vy)

    if (speed < THROW_SPEED_THRESHOLD) {
      // 放下：停在原地，位置在 dragTo 里已经夹取过，必然在可见区内。
      this.#vx = 0
      this.#vy = 0
      // 把新位置设为「家」：用户把宠物挪到哪儿，它就住在哪儿。
      // 不这么做的话，四秒后"停稳自动归位"会把它弹回原处，
      // 用户会觉得"我明明放好了它自己又跑了"。
      this.setAnchor(this.#x, this.#y)
      console.log(
        `[dsh-token-pet] 放下：位置 (${Math.round(this.#x)}, ${Math.round(this.#y)})` +
          `（初速 ${Math.round(speed)} < ${THROW_SPEED_THRESHOLD}，已成为新的家）`,
      )
      this.#setState('resting')
      return
    }

    console.log(
      `[dsh-token-pet] 甩出：位置 (${Math.round(this.#x)}, ${Math.round(this.#y)})，` +
        `初速 (${Math.round(this.#vx)}, ${Math.round(this.#vy)})`,
    )
    this.#setState('flying')
  }

  /** 立刻把窗口拉回锚点（双击触发）。 */
  returnToAnchor(): void {
    if (!this.#anchor) return
    this.#restedAt = undefined
    this.#setState('returning')
  }

  /**
   * 用两次光标采样的差分估计跟随速度。
   *
   * 加指数平滑：单帧的位置取整噪声会被除以很小的 dt 放大成尖刺，
   * 而拖拽速度直接决定宠物的拉伸幅度，尖刺会让它一下一下地抖。
   */
  #updateDragVelocity(cursor: { x: number; y: number }): void {
    const previous = this.#lastCursor
    const now = performance.now()
    if (!previous) {
      this.#lastCursor = { x: cursor.x, y: cursor.y, at: now }
      return
    }

    const elapsedMs = now - previous.at
    if (elapsedMs < DRAG_VELOCITY_FLOOR_MS) return

    const elapsedSeconds = elapsedMs / 1000
    const instantVx = (cursor.x - previous.x) / elapsedSeconds
    const instantVy = (cursor.y - previous.y) / elapsedSeconds
    const smoothing = 0.35
    this.#vx = this.#vx * (1 - smoothing) + instantVx * smoothing
    this.#vy = this.#vy * (1 - smoothing) + instantVy * smoothing
    this.#lastCursor = { x: cursor.x, y: cursor.y, at: now }
  }

  /* ---------------------------------------------------------------- *
   * 模拟
   * ---------------------------------------------------------------- */

  /** 采集真实窗口位置与尺寸，让模拟器状态与实际对齐。 */
  #syncFromWindow(): void {
    const bounds = this.#host.measure()
    this.#x = bounds.x
    this.#y = bounds.y
    this.#size = { width: bounds.width, height: bounds.height }
  }

  /** 取窗口尺寸；尚未测量过时补测一次。 */
  #measureSize(): { width: number; height: number } {
    if (!this.#size) {
      const bounds = this.#host.measure()
      this.#size = { width: bounds.width, height: bounds.height }
    }
    return this.#size
  }

  /** 推进一帧，按实际耗时拆成固定步长子步。 */
  #tick(): void {
    const now = performance.now()
    let elapsed = (now - this.#lastTickAt) / 1000
    this.#lastTickAt = now
    // 系统休眠/进程被挂起后 elapsed 可能是几秒，直接积分会让宠物瞬移出屏幕。
    elapsed = Math.min(elapsed, 0.1)

    const steps = Math.max(1, Math.ceil(elapsed / this.#options.maxStepSeconds))
    const dt = elapsed / steps
    for (let index = 0; index < steps; index += 1) {
      this.#step(dt, now)
    }

    this.#checkOnScreen()
    this.#emitFrame(false)
  }

  /** 单个固定步长的积分。 */
  #step(dt: number, now: number): void {
    switch (this.#state) {
      case 'dragging':
        // 拖拽期间位置由 dragTo 直接写入，模拟器不介入。
        return
      case 'returning':
        this.#stepReturn(dt)
        return
      case 'flying':
      case 'bouncing':
        this.#stepFreeFlight(dt, now)
        return
      case 'resting':
        this.#stepResting(now)
        return
    }
  }

  /** 自由飞行：重力 + 空气阻力 + 边界反弹。 */
  #stepFreeFlight(dt: number, now: number): void {
    const size = this.#measureSize()
    const work = this.#host.workAreaAt(this.#x + size.width / 2, this.#y + size.height / 2)

    // 重力
    this.#vy += this.#options.gravity * dt
    // 空气阻力：按指数衰减，是与 dt 无关的稳定形式。
    const retention = this.#options.airRetention ** dt
    this.#vx *= retention

    let x = this.#x + this.#vx * dt
    let y = this.#y + this.#vy * dt

    let horizontal: -1 | 0 | 1 = 0
    let vertical: -1 | 0 | 1 = 0
    let impactSpeed = 0

    // 左右墙
    const minX = work.x
    const maxX = work.x + work.width - size.width
    if (x < minX) {
      x = minX
      impactSpeed = Math.max(impactSpeed, Math.abs(this.#vx))
      this.#vx = -this.#vx * this.#options.restitution
      horizontal = -1
    } else if (x > maxX) {
      x = maxX
      impactSpeed = Math.max(impactSpeed, Math.abs(this.#vx))
      this.#vx = -this.#vx * this.#options.restitution
      horizontal = 1
    }

    // 天花板与地面
    const minY = work.y
    const maxY = work.y + work.height - size.height
    if (y < minY) {
      y = minY
      impactSpeed = Math.max(impactSpeed, Math.abs(this.#vy))
      this.#vy = -this.#vy * this.#options.restitution
      vertical = -1
    } else if (y > maxY) {
      y = maxY
      impactSpeed = Math.max(impactSpeed, Math.abs(this.#vy))
      this.#vy = -this.#vy * this.#options.restitution
      // 落地同时吃掉一部分水平速度，否则宠物会在地面上永远滑下去。
      this.#vx *= this.#options.groundFriction
      vertical = 1
    }

    this.#x = x
    this.#y = y
    this.#host.setPosition(Math.round(x), Math.round(y))

    if (impactSpeed > this.#options.impactSpeedThreshold) {
      this.#host.onImpact(horizontal, vertical, impactSpeed)
      this.#setState('bouncing')
    }

    // 停稳判定：贴地、且整体速度低于阈值。
    const speed = Math.hypot(this.#vx, this.#vy)
    const onGround = y >= maxY - 1
    if (onGround && speed < this.#options.restSpeed) {
      this.#vx = 0
      this.#vy = 0
      this.#restedAt = now
      this.#setState('resting')
    }
  }

  /** 停稳：原地待一会儿，然后自动归位。 */
  #stepResting(now: number): void {
    if (this.#restedAt === undefined || !this.#anchor) return
    if (now - this.#restedAt < this.#options.idleBeforeReturnMs) return
    this.#setState('returning')
  }

  /** 归位：向锚点做弹簧运动，带阻尼。 */
  #stepReturn(dt: number): void {
    const anchor = this.#anchor
    if (!anchor) return

    const accelerationX =
      -this.#options.returnStiffness * (this.#x - anchor.x) - this.#options.returnDamping * this.#vx
    const accelerationY =
      -this.#options.returnStiffness * (this.#y - anchor.y) - this.#options.returnDamping * this.#vy

    this.#vx += accelerationX * dt
    this.#vy += accelerationY * dt

    this.#x += this.#vx * dt
    this.#y += this.#vy * dt
    this.#host.setPosition(Math.round(this.#x), Math.round(this.#y))

    // 到位判定：位置与速度都收敛。
    const dx = Math.abs(anchor.x - this.#x)
    const dy = Math.abs(anchor.y - this.#y)
    if (dx < 1.5 && dy < 1.5 && Math.hypot(this.#vx, this.#vy) < this.#options.restSpeed) {
      this.#x = anchor.x
      this.#y = anchor.y
      this.#host.setPosition(anchor.x, anchor.y)
      this.#vx = 0
      this.#vy = 0
      this.#restedAt = undefined
      this.#setState('resting')
    }
  }

  /* ---------------------------------------------------------------- *
   * 输出
   * ---------------------------------------------------------------- */

  /**
   * 推送一帧运动数据给渲染进程。
   *
   * 节流到约 60fps：模拟器跑 125Hz，但 IPC 与渲染都按 60fps 消费，
   * 多推的帧只是白白过一遍结构化克隆。拖拽时强制推送，保证跟手不掉帧。
   *
   * @param force - 跳过节流。
   */
  #emitFrame(force: boolean): void {
    const now = performance.now()
    if (!force && now - this.#lastFrameAt < this.#options.motionThrottleMs) return
    this.#lastFrameAt = now

    const previous = this.#lastPosition
    const payload: MotionFrame = {
      position: { x: this.#x, y: this.#y },
      delta: {
        x: previous ? this.#x - previous.x : 0,
        y: previous ? this.#y - previous.y : 0,
      },
      velocity: { x: this.#vx, y: this.#vy },
      at: now,
    }
    this.#lastPosition = { x: this.#x, y: this.#y }
    this.#host.onFrame(payload)
  }

  /** 状态迁移的唯一出口，保证不重复通知。 */
  #setState(next: WindowMotionState): void {
    if (this.#state === next) return
    // 状态迁移是排查"宠物乱跑"最有价值的信息：它能把"拖拽中突然开始下坠"
    // 直接暴露成 dragging → flying 这样一条时间线，不用靠猜。
    console.log(
      `[dsh-token-pet] 状态 ${this.#state} → ${next}，` +
        `位置 (${Math.round(this.#x)}, ${Math.round(this.#y)})，` +
        `速度 (${Math.round(this.#vx)}, ${Math.round(this.#vy)})`,
    )
    this.#state = next
    this.#host.onStateChange(next)
  }

  /**
   * 不变量检查：窗口必须落在虚拟桌面内。
   *
   * 这类问题事后极难复现，所以必须在**发生的那一帧**留下证据。
   * 它同时是一个判别器：
   *  - 日志里出现越界记录 → 位置真的飞了，看同一行的状态与速度找原因；
   *  - 完全没有越界记录、但用户看不到宠物 → 位置是对的，问题在窗口可见性
   *    或渲染层，方向完全不同。
   */
  #checkOnScreen(): void {
    const size = this.#measureSize()
    const area = this.#host.unionWorkArea()
    const tolerance = 2
    const outside =
      this.#x < area.x - tolerance ||
      this.#y < area.y - tolerance ||
      this.#x + size.width > area.x + area.width + tolerance ||
      this.#y + size.height > area.y + area.height + tolerance

    if (!outside) return

    console.error(
      `[dsh-token-pet] ❌ 不变量被破坏：状态=${this.#state} ` +
        `位置=(${this.#x.toFixed(1)}, ${this.#y.toFixed(1)}) ` +
        `速度=(${this.#vx.toFixed(1)}, ${this.#vy.toFixed(1)}) ` +
        `窗口=${size.width}×${size.height} 桌面=${area.width}×${area.height}@(${area.x},${area.y})`,
    )
  }
}

/** 把数值夹到闭区间内。 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
