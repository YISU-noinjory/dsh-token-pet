/**
 * IPC 契约：频道名 + 双向调用的类型签名。
 *
 * 为什么集中在一处：主进程注册 handler、preload 暴露 API、渲染进程调用，
 * 三边必须对同一个字符串和同一组类型达成一致。分散定义时，
 * 改一个频道名不会有任何编译错误，只会在运行时静默失效。
 *
 * 这里的 `PetBridge` 是渲染进程能看到的**全部**能力面。
 * preload 只按这个接口白名单地挂载方法，不暴露 `ipcRenderer` 本身。
 */

import type {
  BalanceState,
  MotionFrame,
  PetImageClip,
  PetImageSelectResult,
  PetImageView,
  PetSettings,
  WindowMotionState,
} from './types'

/* ------------------------------------------------------------------ *
 * 频道名
 * ------------------------------------------------------------------ */

/** 渲染进程 → 主进程（`ipcRenderer.invoke`，有返回值）。 */
export const INVOKE_CHANNELS = {
  /** 取当前余额状态。 */
  balanceGet: 'balance:get',
  /** 手动触发一次刷新，立即返回，结果通过事件推送。 */
  balanceRefresh: 'balance:refresh',
  /** 读设置。 */
  settingsGet: 'settings:get',
  /** 合并写入设置。 */
  settingsPatch: 'settings:patch',
  /** 拖拽开始。主进程自行读取光标位置，故不需要载荷。 */
  dragStart: 'pet:drag-start',
  /** 拖拽进行中。载荷为空——位置由主进程从 `screen` 读，见 window-physics.ts。 */
  dragMove: 'pet:drag-move',
  /** 拖拽结束：交出释放速度。 */
  dragEnd: 'pet:drag-end',
  /** 请求把窗口拉回锚点（双击）。 */
  petReturn: 'pet:return',
  /**
   * 命中测试结果：指针当前是否落在宠物本体上。
   *
   * 透明窗口的整块矩形都会吃掉鼠标事件，包括宠物周围那圈透明像素。
   * 渲染进程用 `elementFromPoint` 判断指针是否真的在宠物身上，
   * 主进程据此开关穿透，让边距上的点击落到下层应用。
   */
  overlayInteractive: 'overlay:set-interactive',
  /** 读当前宠物图片状态。 */
  petImageGet: 'pet-image:get',
  /** 弹出系统文件选择框选一张图片；用户取消会正常返回，不抛异常。 */
  petImageSelect: 'pet-image:select',
  /** 清除自定义图片，回到内置的 CSS 宠物。 */
  petImageClear: 'pet-image:clear',
  /** 切换裁剪方式。 */
  petImageSetClip: 'pet-image:set-clip',
  /** 在抠图版本与原图之间切换（原图始终保留）。 */
  petImageSetCutout: 'pet-image:set-cutout',
  /** 退出应用。 */
  quit: 'app:quit',
} as const

/** 主进程 → 渲染进程（`webContents.send`，单向推送）。 */
export const EVENT_CHANNELS = {
  /** 余额状态变化。 */
  balanceState: 'balance:state',
  /** 窗口运动帧，驱动精灵形变。 */
  motion: 'pet:motion',
  /** 窗口物理状态切换。 */
  motionState: 'pet:motion-state',
  /** 落地/撞墙的冲击事件，渲染进程据此播一次挤压。 */
  impact: 'pet:impact',
  /**
   * 宠物图片状态变化。
   *
   * 必须存在，因为换图有**两条**入口：渲染进程的按钮，以及主进程的原生右键菜单。
   * 菜单触发的那次换图，渲染进程只能通过这个事件知道。
   */
  petImageChanged: 'pet-image:changed',
} as const

/** 频道名的字面量联合类型，供调试与日志使用。 */
export type InvokeChannel = (typeof INVOKE_CHANNELS)[keyof typeof INVOKE_CHANNELS]
export type EventChannel = (typeof EVENT_CHANNELS)[keyof typeof EVENT_CHANNELS]

/* ------------------------------------------------------------------ *
 * 载荷类型
 * ------------------------------------------------------------------ */

/** 拖拽结束。 */
export interface DragEndPayload {
  /**
   * 指针在释放瞬间的速度（px/s），可缺省。
   *
   * 为什么要由渲染进程提供：指针事件的分辨率取决于输入设备（游戏鼠标可达
   * 1000Hz），而主进程的模拟循环只有 125Hz。用渲染进程的采样能让甩抛的
   * 初速度更贴合手感。缺省时主进程退回使用自己的光标差分估计。
   */
  readonly velocity?: { x: number; y: number }
}

/** 落地/撞墙冲击。 */
export interface ImpactPayload {
  /** 撞击相对窗口的水平方向：-1 左墙、0 未撞墙、1 右墙。 */
  readonly horizontal: -1 | 0 | 1
  /** 撞击相对窗口的垂直方向：-1 天花板、0 未撞、1 地面。 */
  readonly vertical: -1 | 0 | 1
  /** 撞击速度（px/s），用于换算形变幅度。 */
  readonly speed: number
}

/* ------------------------------------------------------------------ *
 * preload 暴露的能力面
 * ------------------------------------------------------------------ */

/** 事件订阅的取消函数。 */
export type Unsubscribe = () => void

/** 主进程推来的事件 → 载荷类型映射。 */
export interface PetEventMap {
  balance: BalanceState
  motion: MotionFrame
  motionState: WindowMotionState
  impact: ImpactPayload
  petImage: PetImageView
}

/**
 * `window.petBridge` 的类型。
 *
 * 渲染进程只依赖这个接口，不依赖 Electron。
 * 这也意味着渲染进程可以在纯浏览器里被 mock 着调试。
 */
export interface PetBridge {
  readonly balance: {
    get(): Promise<BalanceState>
    refresh(): Promise<void>
  }
  readonly settings: {
    get(): Promise<PetSettings>
    patch(patch: Partial<PetSettings>): Promise<PetSettings>
  }
  readonly drag: {
    /** 通知主进程拖拽开始；抓取偏移由主进程读光标自行确定。 */
    start(): Promise<void>
    /** 拖拽进行中；位置由主进程读取，无需载荷。 */
    move(): Promise<void>
    /** 松手，交出释放速度（可缺省）。 */
    end(payload: DragEndPayload): Promise<void>
  }
  readonly pet: {
    /** 让窗口立刻弹回锚点。 */
    return(): Promise<void>
  }
  readonly overlay: {
    /**
     * 上报指针是否落在宠物本体上。
     *
     * @param interactive - `true` 时窗口接收鼠标事件，`false` 时穿透到下层。
     */
    setInteractive(interactive: boolean): Promise<void>
  }
  readonly petImage: {
    /** 读当前状态；启动时调用一次即可。 */
    get(): Promise<PetImageView>
    /**
     * 弹出系统文件选择框。
     *
     * @returns 三态结果；用户取消时是 `{ status: 'cancelled' }`，不是异常。
     */
    select(): Promise<PetImageSelectResult>
    /** 清除自定义图片。 */
    clear(): Promise<PetImageView>
    /** 切换裁剪方式。 */
    setClip(clip: PetImageClip): Promise<PetImageView>
    /**
     * 在抠图版本与原图之间切换。
     *
     * @param show - `true` 显示抠图；`false` 显示原图。原图永远保留，可反复切换。
     */
    setCutout(show: boolean): Promise<PetImageView>
  }
  readonly app: {
    quit(): Promise<void>
  }
  /**
   * 订阅主进程事件。
   *
   * 泛型把频道名与载荷类型绑定，调用方写错频道名拿到的就不是 `any`，
   * 而是编译错误。返回的取消函数必须被调用，否则窗口销毁后会内存泄漏。
   */
  on<K extends keyof PetEventMap>(
    event: K,
    listener: (payload: PetEventMap[K]) => void,
  ): Unsubscribe
}

/** 渲染进程全局声明：让 `window.petBridge` 在 TS 中可见。 */
declare global {
  interface Window {
    readonly petBridge: PetBridge
  }
}
