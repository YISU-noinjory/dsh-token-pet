/**
 * 「赛博签筒」卡片窗口。
 *
 * ## 为什么必须是独立窗口
 *
 * 宠物窗口只有 220×220（滚轮可调到 150–420），而卡片要放「卦名 + 一句解读 +
 * 关闭按钮」。塞进宠物窗口只有两条路：把窗口撑大（会打乱物理引擎的锚点与
 * 精灵缩放），或者让它被裁掉。独立窗口两者都不用牺牲。
 *
 * ## 定位策略
 *
 * 优先放在宠物**右侧**，右边放不下就放左侧，两边都放不下就贴住工作区边缘。
 * 垂直方向与宠物中心对齐，再夹回工作区内——这样无论宠物被拖到哪里，
 * 卡片都出现在它旁边且完整可见。
 */

import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import type { Bounds } from './window-physics'

/** 卡片尺寸（DIP）。与渲染进程里 `.fortune-card` 的宽高保持一致。 */
export const FORTUNE_CARD_WIDTH = 320
export const FORTUNE_CARD_HEIGHT = 264

/** 卡片与宠物之间的间距。 */
const GAP = 12

/** 卡片窗口。 */
export class FortuneWindow {
  readonly #window: BrowserWindow

  private constructor(window: BrowserWindow) {
    this.#window = window
  }

  /**
   * 创建并显示卡片窗口。
   *
   * @param petBounds - 宠物窗口的当前边界，用于计算摆放位置。
   * @param devServerUrl - 开发模式下的 Vite 地址；生产为 `undefined`。
   * @returns 卡片窗口实例。
   */
  static create(petBounds: Bounds, devServerUrl?: string): FortuneWindow {
    const position = computePosition(petBounds)

    const window = new BrowserWindow({
      ...position,
      width: FORTUNE_CARD_WIDTH,
      height: FORTUNE_CARD_HEIGHT,
      // 与宠物窗口同款的透明无边框：卡片自己是圆角，窗口不该有矩形边界。
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
        // 卡片没有动画循环，省电即可；开着也无妨，与宠物窗口保持一致。
        backgroundThrottling: true,
      },
    })

    // 盖在全屏应用之上，与宠物窗口同一层级。
    window.setAlwaysOnTop(true, 'screen-saver')

    const instance = new FortuneWindow(window)
    instance.#load(devServerUrl)
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

  /** 加载卡片页面。 */
  #load(devServerUrl?: string): void {
    const window = this.#window

    window.once('ready-to-show', () => {
      // showInactive 而不是 show：卡片是"浮出来的提示"，不该抢走用户
      // 正在打字的焦点。
      if (!window.isDestroyed()) window.showInactive()
    })

    // ready-to-show 在透明窗口上并不总是触发（宠物窗口就踩过这个坑），
    // 所以补一个加载完成兜底。
    window.webContents.once('did-finish-load', () => {
      if (!window.isDestroyed() && !window.isVisible()) window.showInactive()
    })

    // 卡片只允许用户点"收下吉言"把它关掉；意外关闭时让主进程知道。
    window.on('closed', () => {
      // 窗口已销毁，外部通过 isAlive 判断，不做额外处理。
    })

    if (devServerUrl) {
      const url = new URL(devServerUrl)
      url.searchParams.set('mode', 'fortune')
      void window.loadURL(url.toString())
    } else {
      // 与宠物窗口同一个页面，用查询参数切到卡片模式——
      // 这样不用新增一个 Vite 入口，preload 与 CSP 也完全复用。
      void window.loadFile(join(__dirname, '../renderer/index.html'), {
        query: { mode: 'fortune' },
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
 * 计算卡片的摆放位置。
 *
 * @param petBounds - 宠物窗口边界。
 * @returns 可直接展开进 `BrowserWindow` 选项的 `x` / `y`。
 */
function computePosition(petBounds: Bounds): { x: number; y: number } {
  const centerX = petBounds.x + petBounds.width / 2
  const centerY = petBounds.y + petBounds.height / 2
  const workArea = screen.getDisplayNearestPoint({ x: centerX, y: centerY }).workArea

  // 优先右侧
  let x = petBounds.x + petBounds.width + GAP
  if (x + FORTUNE_CARD_WIDTH > workArea.x + workArea.width) {
    // 右侧放不下 → 左侧
    x = petBounds.x - FORTUNE_CARD_WIDTH - GAP
  }
  if (x < workArea.x) {
    // 两边都放不下（宠物贴边且屏幕窄）→ 贴住工作区并压住一点宠物，
    // 总比跑到屏幕外看不见好。
    x = workArea.x + 8
  }

  const maxY = workArea.y + workArea.height - FORTUNE_CARD_HEIGHT
  const y = Math.min(Math.max(centerY - FORTUNE_CARD_HEIGHT / 2, workArea.y), Math.max(workArea.y, maxY))

  return { x: Math.round(x), y: Math.round(y) }
}
