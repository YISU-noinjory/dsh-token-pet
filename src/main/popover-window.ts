/**
 * 「浮层」窗口：签筒卡片、设置 Key 表单这类临时界面的通用容器。
 *
 * ## 为什么需要独立窗口
 *
 * 宠物窗口只有 220×220（滚轮可调到 150–420），任何带文字和按钮的面板都塞不进去。
 * 塞进去只有两条路：把窗口撑大（会打乱物理引擎的锚点与精灵缩放），
 * 或者让内容被裁掉。独立窗口两者都不用牺牲。
 *
 * ## 为什么共用同一份实现
 *
 * 签筒和设置表单的窗口需求完全一致：透明、无边框、置顶、贴边摆放、
 * 加载同一个页面只是 `?mode=` 不同。复制一份只会让"下次改窗口参数要改两处"。
 *
 * ## 定位策略
 *
 * 优先放在锚点窗口**右侧**，右边放不下就放左侧，两边都放不下就贴住工作区边缘。
 * 垂直方向与锚点中心对齐，再夹回工作区内——这样无论宠物被拖到哪里，
 * 浮层都出现在它旁边且完整可见。
 */

import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import type { Bounds } from './window-physics'

/** 浮层与锚点窗口之间的间距。 */
const GAP = 12

/** 构造参数。 */
export interface PopoverOptions {
  /** 页面模式，最终变成 `?mode=<值>`。 */
  readonly mode: 'fortune' | 'key'
  /** 窗口宽高（DIP）。必须与渲染进程里对应卡片的尺寸一致。 */
  readonly width: number
  readonly height: number
  /** 锚点窗口的边界（通常是宠物窗口），用于计算摆放位置。 */
  readonly anchor: Bounds
  /** 开发模式下的 Vite 地址；生产为 `undefined`。 */
  readonly devServerUrl?: string
}

/** 浮层窗口。 */
export class PopoverWindow {
  readonly #window: BrowserWindow

  private constructor(window: BrowserWindow) {
    this.#window = window
  }

  /**
   * 创建并显示浮层。
   *
   * @param options - 尺寸与位置参数。
   * @returns 浮层实例。
   */
  static create(options: PopoverOptions): PopoverWindow {
    const position = computePosition(options.anchor, options.width, options.height)

    const window = new BrowserWindow({
      ...position,
      width: options.width,
      height: options.height,
      // 与宠物窗口同款的透明无边框：内容自己是圆角，窗口不该有矩形边界。
      transparent: true,
      backgroundColor: '#00000000',
      frame: false,
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        // 浮层没有动画循环，让它按后台节流跑即可。
        backgroundThrottling: true,
      },
    })

    // 盖在全屏应用之上，与宠物窗口同一层级。
    window.setAlwaysOnTop(true, 'screen-saver')

    const instance = new PopoverWindow(window)
    instance.#load(options)
    return instance
  }

  /** 底层窗口对象。 */
  get browserWindow(): BrowserWindow {
    return this.#window
  }

  /** 窗口是否还活着。 */
  get isAlive(): boolean {
    return !this.#window.isDestroyed()
  }

  /** 加载页面。 */
  #load(options: PopoverOptions): void {
    const window = this.#window

    const show = (): void => {
      // showInactive 而不是 show：浮层是"浮出来的提示"，不该抢走用户
      // 正在打字的焦点。
      if (!window.isDestroyed()) window.showInactive()
    }

    window.once('ready-to-show', show)
    // ready-to-show 在透明窗口上并不总是触发（宠物窗口就踩过这个坑），
    // 所以补一个加载完成兜底。
    window.webContents.once('did-finish-load', show)

    if (options.devServerUrl) {
      const url = new URL(options.devServerUrl)
      url.searchParams.set('mode', options.mode)
      void window.loadURL(url.toString())
    } else {
      // 与宠物窗口同一个页面，用查询参数切模式——
      // 这样不用新增 Vite 入口，preload 与 CSP 也完全复用。
      void window.loadFile(join(__dirname, '../renderer/index.html'), {
        query: { mode: options.mode },
      })
    }
  }

  /** 关闭并销毁。 */
  close(): void {
    if (!this.isAlive) return
    this.#window.destroy()
  }
}

/**
 * 计算浮层的摆放位置。
 *
 * @param anchor - 锚点窗口边界。
 * @param width - 浮层宽度。
 * @param height - 浮层高度。
 * @returns 可直接展开进 `BrowserWindow` 选项的 `x` / `y`。
 */
function computePosition(anchor: Bounds, width: number, height: number): { x: number; y: number } {
  const centerX = anchor.x + anchor.width / 2
  const centerY = anchor.y + anchor.height / 2
  const workArea = screen.getDisplayNearestPoint({ x: centerX, y: centerY }).workArea

  // 优先右侧
  let x = anchor.x + anchor.width + GAP
  if (x + width > workArea.x + workArea.width) {
    // 右侧放不下 → 左侧
    x = anchor.x - width - GAP
  }
  if (x < workArea.x) {
    // 两边都放不下（宠物贴边且屏幕窄）→ 贴住工作区，总比跑到屏幕外好。
    x = workArea.x + 8
  }

  const maxY = workArea.y + workArea.height - height
  const y = Math.min(Math.max(centerY - height / 2, workArea.y), Math.max(workArea.y, maxY))

  return { x: Math.round(x), y: Math.round(y) }
}
