/**
 * 渲染进程的物理内核。
 *
 * 这里只有三类东西，都是纯计算、不碰 DOM：
 *  1. {@link Spring} —— 弹簧-阻尼积分器，"Q弹" 的唯一来源；
 *  2. 挤压/拉伸的换算函数 —— 把形变约束成"看起来是同一个体积的东西被压扁"；
 *  3. {@link VelocityTracker} —— 指针速度采样，为甩抛提供初速度。
 *
 * 为什么不直接用 CSS transition / Web Animations：
 * 那些是时间轴驱动的，只能表达"从 A 到 B"；而宠物的形变由**外部速度**驱动
 * （窗口被甩得多快、撞墙多猛），每帧的目标值都在变。
 * 弹簧是唯一能同时给出「跟随」与「回弹过冲」的模型。
 */

/* ------------------------------------------------------------------ *
 * 弹簧
 * ------------------------------------------------------------------ */

/** 弹簧参数。 */
export interface SpringConfig {
  /** 劲度系数 k：越大回弹越快、越"硬"。 */
  readonly stiffness: number
  /** 阻尼系数 c：越小越"弹"（过冲越多），越大越快静止。 */
  readonly damping: number
  /** 质量 m：越大惯性越强、反应越迟钝。 */
  readonly mass: number
}

/**
 * 常用手感预设。
 *
 * 调参经验：先定 `stiffness` 决定回弹速度，再把 `damping` 调到
 * 刚好过冲一次（`damping ≈ 2 * sqrt(k * m)` 的 0.4~0.7 倍）。
 * 完全不过冲会显得"木"，过冲多次会显得"飘"。
 */
export const SPRING_PRESETS = {
  /** 强弹：用于点击挤压的回弹，过冲明显，最"Q"。 */
  bouncy: { stiffness: 420, damping: 11, mass: 1 },
  /** 中等：用于拖拽时的跟随滞后。 */
  follow: { stiffness: 260, damping: 18, mass: 1 },
  /** 软：用于呼吸、浮动等持续动画。 */
  soft: { stiffness: 90, damping: 12, mass: 1 },
  /** 硬：用于倾斜角回正，不能晃。 */
  stiff: { stiffness: 600, damping: 26, mass: 1 },
} as const satisfies Record<string, SpringConfig>

/** 判定静止的位置阈值。 */
const REST_EPSILON = 0.001
/** 判定静止的速度阈值。 */
const REST_VELOCITY = 0.001
/** 单个子步的最大时长；超过就拆分，否则显式积分会发散。 */
const MAX_SUBSTEP_SECONDS = 1 / 240

/**
 * 一维弹簧-阻尼系统。
 *
 * 积分方式为半隐式欧拉（先更新速度再更新位置）：
 * 相比显式欧拉，它在同样步长下稳定得多，这是游戏物理里的标准选择。
 */
export class Spring {
  #config: SpringConfig
  /** 当前值。 */
  value: number
  /** 目标值。改变它即产生运动。 */
  target: number
  /** 当前速度（单位/秒）。 */
  velocity = 0

  constructor(config: SpringConfig, initial: number) {
    this.#config = config
    this.value = initial
    this.target = initial
  }

  /** 运行期改手感（例如拖拽中切到更硬的预设）。 */
  setConfig(config: SpringConfig): void {
    this.#config = config
  }

  /** 给一个瞬时冲量（单位/秒），用于点击挤压这类"打一下"的效果。 */
  impulse(velocity: number): void {
    this.velocity += velocity
  }

  /** 直接跳到目标位置并清零速度（用于重置，避免复位时看到一段运动）。 */
  snap(value: number): void {
    this.value = value
    this.target = value
    this.velocity = 0
  }

  /**
   * 推进一帧。
   *
   * @param dt - 距上一帧的秒数。会被限幅：切标签页回来时 dt 可能是好几秒，
   *             直接积分会让宠物瞬移到离谱的位置。
   */
  step(dt: number): void {
    const clamped = Math.min(Math.max(dt, 0), 1 / 30)
    const steps = Math.max(1, Math.ceil(clamped / MAX_SUBSTEP_SECONDS))
    const h = clamped / steps

    for (let index = 0; index < steps; index += 1) {
      const { stiffness, damping, mass } = this.#config
      // 胡克定律 + 线性阻尼：F = -k(x - target) - c·v
      const acceleration = (-stiffness * (this.value - this.target) - damping * this.velocity) / mass
      this.velocity += acceleration * h
      this.value += this.velocity * h
    }

    // 收敛后清零，避免浮点残差让 isAtRest 永远为假、动画循环不肯休息。
    if (this.isAtRest) {
      this.value = this.target
      this.velocity = 0
    }
  }

  /** 是否已收敛到目标。 */
  get isAtRest(): boolean {
    return Math.abs(this.value - this.target) < REST_EPSILON && Math.abs(this.velocity) < REST_VELOCITY
  }
}

/** 二维弹簧，由两个独立的一维弹簧组成（本项目的形变在 X/Y 上互不耦合）。 */
export class Spring2D {
  readonly x: Spring
  readonly y: Spring

  constructor(config: SpringConfig, initialX = 0, initialY = 0) {
    this.x = new Spring(config, initialX)
    this.y = new Spring(config, initialY)
  }

  /** 同时设定两个轴的目标。 */
  setTarget(x: number, y: number): void {
    this.x.target = x
    this.y.target = y
  }

  /** 推进一帧。 */
  step(dt: number): void {
    this.x.step(dt)
    this.y.step(dt)
  }

  /** 两轴是否都已静止。 */
  get isAtRest(): boolean {
    return this.x.isAtRest && this.y.isAtRest
  }
}

/* ------------------------------------------------------------------ *
 * 形变换算
 * ------------------------------------------------------------------ */

/**
 * 体积守恒的挤压。
 *
 * 直觉：把一个气球压扁，它会变宽而不是变小。
 * 如果只改 `scaleY`，视觉上宠物是"被缩放了"，不是"被压扁了"。
 *
 * 2D 场景下面积守恒即 `scaleX = 1 / scaleY`。
 * 这里加了一个 `strength` 让效果可调（0 = 不变宽，1 = 严格守恒），
 * 因为严格守恒在极端压缩下会显得横向拉得太长。
 *
 * @param scaleY - 垂直缩放，通常来自弹簧。
 * @param strength - 守恒强度，0~1。
 * @returns 应当施加在 X 轴上的缩放。
 */
export function volumePreservingScaleX(scaleY: number, strength = 0.85): number {
  // 防止 scaleY 接近 0 时 1/scaleY 爆炸。
  const safe = Math.max(scaleY, 0.2)
  return 1 + (1 / safe - 1) * strength
}

/**
 * 把速度换算成轴向拉伸比例。
 *
 * 用 `atan` 型饱和而不是线性：速度再大，拉伸也不超过 `maxStretch`，
 * 否则快速甩动时宠物会被拉成一条线。
 *
 * @param axisSpeed - 该轴上的速度绝对值（px/s）。
 * @param referenceSpeed - 达到"半个最大拉伸"所需的速度。
 * @param maxStretch - 最大额外比例，例如 0.35 表示最多拉长 35%。
 * @returns 该轴的缩放比例，恒 ≥ 1。
 */
export function velocityStretch(axisSpeed: number, referenceSpeed: number, maxStretch: number): number {
  const normalized = Math.abs(axisSpeed) / Math.max(referenceSpeed, 1)
  // (2/π)·atan 把 [0, ∞) 映射到 [0, 1)，是常用的软饱和曲线。
  const saturated = (2 / Math.PI) * Math.atan(normalized)
  return 1 + saturated * maxStretch
}

/** 把数值夹到闭区间。 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/* ------------------------------------------------------------------ *
 * 指针速度采样
 * ------------------------------------------------------------------ */

/** 一个采样点。 */
interface Sample {
  readonly x: number
  readonly y: number
  readonly at: number
}

/**
 * 指针速度采样器。
 *
 * 为什么不用「最后两点之差」：
 * 指针事件在 120Hz 鼠标上非常密，两个相邻采样点之间可能只隔 1ms，
 * 距离也几乎是 0，商出来会是一个巨大且随机的数。
 * 用一段**时间窗口**内的首尾差再除以窗口时长，得到的是平滑且物理正确的速度。
 */
export class VelocityTracker {
  readonly #windowMs: number
  readonly #capacity: number
  #samples: Sample[] = []

  /**
   * @param windowMs - 参与计算的时间窗口长度。
   * @param capacity - 窗口内最多保留的采样点数，防止高频事件下数组无限增长。
   */
  constructor(windowMs = 100, capacity = 32) {
    this.#windowMs = windowMs
    this.#capacity = capacity
  }

  /**
   * 记录一个采样点。
   *
   * @param x - 屏幕 X 坐标。
   * @param y - 屏幕 Y 坐标。
   * @param at - 单调时间戳（`performance.now()`）。
   */
  sample(x: number, y: number, at: number): void {
    this.#samples.push({ x, y, at })
    // 两头同时裁剪：超时的不再代表"当前速度"，超量的直接丢弃最老的。
    const cutoff = at - this.#windowMs
    while (this.#samples.length > 0 && (this.#samples[0]?.at ?? 0) < cutoff) {
      this.#samples.shift()
    }
    while (this.#samples.length > this.#capacity) {
      this.#samples.shift()
    }
  }

  /**
   * 计算当前速度。
   *
   * @returns 速度（px/s）；采样点不足时返回 `{ x: 0, y: 0 }`。
   */
  velocity(): { x: number; y: number } {
    const first = this.#samples[0]
    const last = this.#samples[this.#samples.length - 1]
    if (!first || !last) return { x: 0, y: 0 }

    const elapsedSeconds = (last.at - first.at) / 1000
    // 窗口内只有一个点，或时间没推进时，速度不可测。
    if (elapsedSeconds <= 0.001) return { x: 0, y: 0 }

    return {
      x: (last.x - first.x) / elapsedSeconds,
      y: (last.y - first.y) / elapsedSeconds,
    }
  }

  /** 清空采样，用于开始新一次拖拽。 */
  reset(): void {
    this.#samples = []
  }
}
