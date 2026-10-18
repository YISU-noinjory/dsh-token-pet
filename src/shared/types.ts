/**
 * 跨进程共享类型定义。
 *
 * 本文件被三处消费：
 *  - 主进程（tsc → CommonJS）
 *  - preload（tsc → CommonJS）
 *  - 渲染进程（Vite 打包）
 *
 * 因此这里**只能放纯类型与纯数据**，不得引入 Electron / DOM / Node 专有 API，
 * 否则会让某一侧编译不过。
 */

// 只借它的类型。`hexagrams.ts` 本身是纯数据，没有进程依赖。
import type { Hexagram } from './hexagrams'

/* ------------------------------------------------------------------ *
 * 余额领域模型
 * ------------------------------------------------------------------ */

/** DeepSeek 余额钱包支持的币种。 */
export type Currency = 'CNY' | 'USD'

/**
 * 单个钱包。
 *
 * 金额一律保留服务端返回的十进制字符串，**不做 number 转换**：
 * 浮点数会破坏服务端精度（例如 `"110.00"` → `110`，展示层还需要补零），
 * 展示时由 UI 层按币种格式化。
 */
export interface BalanceWallet {
  readonly currency: Currency
  /** 总余额 = 赠送余额 + 充值余额。 */
  readonly totalBalance: string
  /** 赠送余额（有有效期）。 */
  readonly grantedBalance: string
  /** 充值余额。 */
  readonly toppedUpBalance: string
}

/** 一次成功的余额读数。 */
export interface BalanceSnapshot {
  /** 账户是否仍可用（对应接口的 `is_available`）。 */
  readonly isAvailable: boolean
  /** 各币种钱包；接口理论上可能返回多个。 */
  readonly wallets: readonly BalanceWallet[]
  /** 本次读数的本地时间戳（epoch ms）。 */
  readonly fetchedAt: number
  /** 数据来源，用于 UI 区分「实时」与「缓存」。 */
  readonly source: BalanceSource
}

/** 余额数据的来源渠道。 */
export type BalanceSource =
  /** 直接调用 DeepSeek 官方 `/user/balance` 接口。 */
  | 'api'
  /** 上一次成功读数的缓存（当前请求失败时的兜底展示）。 */
  | 'cache'
  /** 由 DSH 宿主的 deepseekAccount 服务提供（账号登录态，而非 API Key）。 */
  | 'dsh-account'

/**
 * 失败分类。
 *
 * 分类而非透传原始错误，是因为调度策略（`BalancePoller`）只关心
 * 「该不该重试、退避多久、要不要停」，而不关心具体的错误文本。
 */
export type BalanceErrorCode =
  /** 未找到 API Key，属于配置问题，重试无意义。 */
  | 'no-credential'
  /** 401/403：Key 无效或权限不足，重试无意义。 */
  | 'unauthorized'
  /** 429：被限流，按 `retryAfterMs` 退避。 */
  | 'rate-limited'
  /** 网络层失败（DNS / 连接 / 超时），值得重试。 */
  | 'network'
  /** 5xx：服务端故障，值得重试。 */
  | 'server'
  /** 响应结构不符合预期，多为接口变更，重试无意义。 */
  | 'malformed'
  /** 主进程被要求主动中止（如退出、切换账号）。 */
  | 'aborted'

/** 一次失败的读数。 */
export interface BalanceError {
  readonly code: BalanceErrorCode
  /** 面向开发者的诊断信息，不直接展示给用户。 */
  readonly message: string
  /** 服务端建议的重试延迟；仅 `rate-limited` 会携带。 */
  readonly retryAfterMs?: number
}

/**
 * 余额状态机。
 *
 * 用可辨识联合而不是 `{ data, loading, error }` 三件套，
 * 是为了让「有数据的同时正在刷新」这种真实状态可以被表达，
 * 而不是靠多个布尔量的组合去猜。
 */
export type BalanceState =
  /** 尚未开始首次拉取。 */
  | { readonly status: 'idle' }
  /** 首次拉取进行中，此时没有可展示的数据。 */
  | { readonly status: 'loading' }
  /** 刷新进行中，同时保留上一次的成功数据供继续展示。 */
  | { readonly status: 'refreshing'; readonly snapshot: BalanceSnapshot }
  /** 至少成功过一次。 */
  | { readonly status: 'ready'; readonly snapshot: BalanceSnapshot }
  /** 从未成功，或最近一次刷新失败。 */
  | {
      readonly status: 'error'
      readonly error: BalanceError
      /** 若曾成功过，则附带旧数据，UI 可降级为「灰显 + 时间戳」。 */
      readonly staleSnapshot?: BalanceSnapshot
    }

/* ------------------------------------------------------------------ *
 * 宠物情绪
 * ------------------------------------------------------------------ */

/**
 * 由余额水位驱动的宠物情绪。
 *
 * 这是「宠物」与「余额显示」两个需求之间唯一的耦合点：
 * 数据层只负责产出数字，情绪映射是纯函数，动画层只消费情绪。
 */
export type PetMood =
  /** 余额健康。 */
  | 'happy'
  /** 余额偏低。 */
  | 'neutral'
  /** 余额告急。 */
  | 'worried'
  /** 余额耗尽或账户不可用。 */
  | 'starving'
  /** 尚未拿到数据。 */
  | 'unknown'

/* ------------------------------------------------------------------ *
 * 窗口几何与运动
 * ------------------------------------------------------------------ */

/** 屏幕坐标系中的一个二维向量（单位 px，原点为主显示器左上角）。 */
export interface Vec2 {
  readonly x: number
  readonly y: number
}

/**
 * 主进程推送给渲染进程的窗口运动帧。
 *
 * 渲染进程不直接读窗口坐标（它读不到），而是消费这个运动流，
 * 用它驱动精灵的「滞后弹簧」——窗口走了、精灵没跟上，于是被拉扁。
 * Q弹的观感来自这个速度差，而不是渲染进程自己算位置。
 */
export interface MotionFrame {
  /** 窗口当前位置（屏幕坐标）。 */
  readonly position: Vec2
  /** 相对上一帧的位移增量（窗口坐标增量）。 */
  readonly delta: Vec2
  /** 主进程推算的瞬时速度（px/s），供渲染进程换算拉伸与倾斜。 */
  readonly velocity: Vec2
  /** 该帧对应的单调时间戳（performance.now 同源量级，仅用于求 dt）。 */
  readonly at: number
}

/** 窗口物理的宏观状态，决定渲染进程该播哪套动画。 */
export type WindowMotionState =
  /** 静止悬浮在锚点。 */
  | 'resting'
  /** 被指针拖拽。 */
  | 'dragging'
  /** 甩出后自由飞行。 */
  | 'flying'
  /** 触边反弹中。 */
  | 'bouncing'
  /** 被弹簧拉回锚点。 */
  | 'returning'

/* ------------------------------------------------------------------ *
 * 自定义宠物图片
 * ------------------------------------------------------------------ */

/**
 * 图片裁剪方式。
 *
 * `circle` 是为 JPG 准备的：JPG 没有 alpha 通道，导入后必然带白底，
 * 用圆形裁切把它变成"圆形头像"比矩形白块好看得多。
 * PNG/GIF/WebP 有透明通道，保持 `none` 即可。
 */
export type PetImageClip = 'none' | 'circle'

/**
 * 当前宠物图片的状态快照。
 *
 * 注意这里**没有真实文件路径**：渲染进程只需要一个可以塞进 `src` 的 URL，
 * 拿到绝对路径既没用又多一处泄漏面。真正决定"哪个文件"的是主进程，
 * 见 `src/main/pet-image.ts` 的说明。
 */
export interface PetImageView {
  /** 是否已设置自定义图片。 */
  readonly hasImage: boolean
  /** 可直接用于 `<img src>` 的 URL；无图时为 `null`。 */
  readonly url: string | null
  /** 原始文件名，仅供界面展示，不含目录。 */
  readonly fileName: string | null
  /** 当前裁剪方式。 */
  readonly clip: PetImageClip
  /** 是否有一份抠好的版本可用（导入时自动生成）。 */
  readonly hasCutout: boolean
  /** 当前显示的是不是抠图版本。`hasCutout` 为 false 时恒为 false。 */
  readonly showingCutout: boolean
}

/** 抠图结果，供界面提示"抠了 / 没抠 / 为什么没抠"。 */
export type MattingOutcomeKind =
  /** 抠图成功，已去除背景。 */
  | 'applied'
  /** 没找到可去除的背景（图片本身可能是纯色主体或已经抠好）。 */
  | 'no-background'
  /** 会连主体一起去掉，已放弃并保留原图。 */
  | 'gave-up'
  /** 这个格式不支持抠图（如 GIF，抠图会丢掉动画）。 */
  | 'unsupported'

/** 选择被拒绝的原因。取消（用户点了"取消"）不是拒绝，见 {@link PetImageSelectResult}。 */
export type PetImageRejectReason =
  /** 文件头魔数不在支持列表里（改扩展名骗不过去）。 */
  | 'unsupported-format'
  /** 超过体积上限。 */
  | 'too-large'
  /** 读不到、不是普通文件、或读取时出错。 */
  | 'unreadable'
  /** 复制到 userData 失败（通常是磁盘或权限问题）。 */
  | 'copy-failed'

/**
 * 一次"选择宠物图片"的结果。
 *
 * 用三态而不是「成功返回值 / 失败抛异常」：用户按下取消是**正常操作**，
 * 不该走异常路径，也不该在界面上报错。
 */
export type PetImageSelectResult =
  | {
      readonly status: 'selected'
      readonly view: PetImageView
      /** 抠图结果；界面据此给出提示。 */
      readonly matting: MattingOutcomeKind
    }
  | { readonly status: 'cancelled' }
  | {
      readonly status: 'rejected'
      readonly reason: PetImageRejectReason
      /** 面向用户的中文说明，已包含必要的具体数值（体积上限等）。 */
      readonly message: string
    }

/* ------------------------------------------------------------------ *
 * 每日赛博抽签
 * ------------------------------------------------------------------ */

/**
 * 一次抽签的完整结果。
 *
 * 卦象与解读一起返回，而不是分两步：界面拿到它就能一次性渲染完，
 * 不会出现"先显示卦名、过两秒才冒出解读"的中间态。
 */
export interface FortuneReading {
  /** 抽到的卦。 */
  readonly hexagram: Hexagram
  /** 展示给用户的解读文字（AI 生成，或本地兜底文案）。 */
  readonly interpretation: string
  /**
   * 解读来自哪里。
   *
   * `fallback` 表示 AI 没调通（没 Key、网络不通、限流…），此时仍然展示卦象和
   * 兜底文案——抽签本身就成立，不该因为 AI 挂了就什么都不给。
   */
  readonly source: 'ai' | 'fallback'
  /** 降级原因；`source` 为 `ai` 时不存在。用于界面上一行小字说明。 */
  readonly notice?: string
}

/**
 * 主进程发给宠物渲染进程的抽签信号。
 *
 * 菜单在**主进程**里被点击，但"今天抽过没有"的判断在**渲染进程**的
 * localStorage 里，所以这里只需要一个信号，"抽不抽"由渲染进程决定。
 */
export interface FortuneSignal {
  /** `open` 请求开签；`closed` 卡片已关闭（宠物据此弹一下）。 */
  readonly action: 'open' | 'closed'
}

/* ------------------------------------------------------------------ *
 * 应用内 API Key 设置
 * ------------------------------------------------------------------ */

/** 应用内保存的 Key 的状态。 */
export interface CredentialStatus {
  /** 是否已保存过 Key。 */
  readonly hasKey: boolean
  /**
   * 系统加密是否可用（Windows 上是 DPAPI）。
   *
   * 为 false 时**不会**降级成明文保存——界面应提示用户改用环境变量。
   */
  readonly encryptionAvailable: boolean
}

/**
 * 保存 Key 的结果。
 *
 * 用结果对象而不是抛异常：失败原因（系统不支持加密、写盘失败）需要原样
 * 展示给用户，而跨进程抛出的异常会被包成
 * `Error invoking remote method '...'` 这类没法直接给用户看的文本。
 */
export interface CredentialSaveResult {
  readonly ok: boolean
  readonly status: CredentialStatus
  /** 失败原因，面向用户的中文说明。`ok` 为 true 时不存在。 */
  readonly error?: string
}

/* ------------------------------------------------------------------ *
 * 运行时设置
 * ------------------------------------------------------------------ */

/** 宠物窗口与余额行为的可调参数。 */
export interface PetSettings {
  /** 轮询间隔（ms）。 */
  readonly pollIntervalMs: number
  /** 窗口边长（px，正方形）。 */
  readonly windowSize: number
  /** 是否始终置顶。 */
  readonly alwaysOnTop: boolean
  /** 是否开启「鼠标穿透」（穿透时点击落到下层应用）。 */
  readonly clickThrough: boolean
  /** 情绪阈值：余额低于该值即视为告急。 */
  readonly lowBalanceThreshold: number
  /** 情绪阈值：余额低于该值即视为偏低。 */
  readonly warnBalanceThreshold: number
}
