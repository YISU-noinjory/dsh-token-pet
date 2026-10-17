/**
 * 宠物窗口的创建与外观控制。
 *
 * 这个文件负责「窗口是什么样」，不负责「窗口怎么动」（那是 window-physics.ts）。
 * 交付给窗口物理模拟器的宿主适配器也在这里实现——它把
 * `BrowserWindow` 与 `screen` 的能力收敛成 {@link WindowPhysicsHost} 需要的四个回调。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, screen } from 'electron'
import type { EventChannel } from '../shared/ipc'
import type { Bounds, WindowPhysicsHost } from './window-physics'

/** 创建选项。 */
export interface PetWindowOptions {
  /** 窗口边长（px），窗口为正方形。 */
  readonly size: number
  /** 是否置顶。 */
  readonly alwaysOnTop: boolean
  /** 是否开启鼠标穿透。 */
  readonly clickThrough: boolean
  /**
   * 开发模式下的渲染进程地址；提供时走 `loadURL`，否则加载构建产物。
   */
  readonly devServerUrl?: string
}

/** 距工作区右下角的初始留白（px）。 */
const INITIAL_MARGIN = 40

/** 兜底显示窗口的等待时长（ms）。见 `#installShowFallbacks` 的说明。 */
const SHOW_FALLBACK_MS = 2500

export class PetWindow {
  readonly #window: BrowserWindow
  /**
   * 窗口边长（DIP）。
   *
   * 之所以要把它单独存起来并在每次移动时显式写回，是为了抵抗一个
   * Windows + 高 DPI 下的尺寸漂移（见 {@link setPosition}）。
   * 滚轮缩放会改这个值（见 {@link setSize}）。
   */
  #size: number
  /** 用户显式设置的穿透开关。 */
  #clickThrough = false
  /** 渲染进程上报的命中测试结果：指针是否在宠物本体上。 */
  #interactive = true

  private constructor(window: BrowserWindow, size: number) {
    this.#window = window
    this.#size = size
  }

  /**
   * 创建宠物窗口。
   *
   * 透明窗口的关键配置及其原因：
   *  - `transparent: true` + `backgroundColor: '#00000000'`：真透明而非「看起来透明」，
   *    否则 Windows 上会得到一块黑色底；同时必须 `hasShadow: false`，
   *    否则透明区域会被系统画上方形阴影，边界一眼可见。
   *  - `frame: false` + `resizable: false`：无边框且不可缩放。透明窗口在
   *    Windows 上的缩放边框会有绘制残影，固定尺寸是唯一稳妥的选择。
   *  - `skipTaskbar: true`：桌宠不是「一个应用窗口」，不该占用任务栏位置。
   *  - `show: false` 配合 `ready-to-show`：避免加载期的白屏闪一下。
   *  - `backgroundThrottling: false`：窗口失焦时 Chromium 默认会把 rAF 降到 1Hz，
   *    桌宠的呼吸动画会直接卡死。
   *
   * @param options - 创建选项。
   * @returns 已开始加载页面的实例；此时窗口尚未显示。
   */
  static create(options: PetWindowOptions): PetWindow {
    const preloadPath = resolvePreloadPath()

    const window = new BrowserWindow({
      width: options.size,
      height: options.size,
      // 初始位置：主显示器工作区右下角。工作区已扣除任务栏，不会压住开始菜单。
      ...initialPosition(options.size),
      transparent: true,
      backgroundColor: '#00000000',
      frame: false,
      hasShadow: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: options.alwaysOnTop,
      acceptFirstMouse: true,
      show: false,
      webPreferences: {
        preload: preloadPath,
        // 渲染进程不接触 Node：只通过 preload 白名单出的 API 与主进程通信。
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false,
        devTools: options.devServerUrl !== undefined,
      },
    })

    const instance = new PetWindow(window, options.size)

    // 立刻用显式尺寸校正一次初始大小。
    // 在 125% 缩放的 Windows 上，按 `width: 220` 创建透明无边框窗口会得到
    // 223（DPI 往返取整），而这个误差之后还会继续累积——见 setPosition。
    window.setBounds({ ...window.getBounds(), width: options.size, height: options.size })

    instance.#applyPlatformTweaks(options)
    instance.#load(options)
    return instance
  }

  /** 底层窗口对象，供 IPC 注册与事件推送使用。 */
  get browserWindow(): BrowserWindow {
    return this.#window
  }

  /** 窗口是否仍然存活。 */
  get isAlive(): boolean {
    return !this.#window.isDestroyed()
  }

  /**
   * 切换鼠标穿透（用户设置）。
   *
   * @param enabled - 是否让点击落到下层窗口。
   */
  setClickThrough(enabled: boolean): void {
    this.#clickThrough = enabled
    this.#applyMouseMode()
  }

  /**
   * 上报命中测试结果。
   *
   * 与 {@link setClickThrough} 是两件事：后者是用户的全局开关，
   * 这里是「指针此刻是否真的压在宠物身上」。两者取或——
   * 用户要求穿透、或者指针不在宠物上，都应该让事件落下去。
   *
   * @param interactive - 指针是否在宠物本体上。
   */
  setInteractive(interactive: boolean): void {
    if (this.#interactive === interactive) return
    this.#interactive = interactive
    this.#applyMouseMode()
  }

  /**
   * 把两个开关合成一次 `setIgnoreMouseEvents` 调用。
   *
   * `forward: true` 是必须的：它让窗口在穿透状态下仍能收到 `mousemove`，
   * 否则指针一旦离开宠物，渲染进程就再也收不到事件，
   * 无法检测到指针回到宠物身上，窗口会永久卡在穿透状态。
   */
  #applyMouseMode(): void {
    if (!this.isAlive) return
    this.#window.setIgnoreMouseEvents(this.#clickThrough || !this.#interactive, { forward: true })
  }

  /**
   * 切换置顶。
   *
   * 层级用 `'screen-saver'` 而不是默认的 `'floating'`：
   * 桌宠的预期行为是「全屏看视频时它也在」，`'floating'` 会被全屏窗口盖住。
   *
   * @param enabled - 是否置顶。
   */
  setAlwaysOnTop(enabled: boolean): void {
    if (!this.isAlive) return
    this.#window.setAlwaysOnTop(enabled, enabled ? 'screen-saver' : 'normal')
  }

  /**
   * 显示窗口。
   *
   * 隐藏不会销毁窗口，所以 `window-all-closed` 不会触发、进程继续活着，
   * 余额也照常轮询——这正是"隐藏"与"退出"的区别。
   */
  show(): void {
    if (!this.isAlive) return
    this.#window.show()
  }

  /** 隐藏窗口。进程与轮询都不受影响，可用托盘菜单重新显示。 */
  hide(): void {
    if (!this.isAlive) return
    this.#window.hide()
  }

  /** 当前是否可见。托盘菜单据此决定显示"显示宠物"还是"隐藏宠物"。 */
  get isVisible(): boolean {
    return this.isAlive && this.#window.isVisible()
  }

  /** 读取窗口当前矩形。 */
  getBounds(): Bounds {
    const { x, y, width, height } = this.#window.getBounds()
    return { x, y, width, height }
  }

  /**
   * 写入窗口位置。
   *
   * **必须用 `setBounds` 并显式带回尺寸，不能图省事用 `setPosition`。**
   * 这不是风格问题，而是一个实测确认的平台陷阱：
   *
   * 在 125% 缩放的 Windows 上，透明无边框窗口每调用约两次 `setPosition`，
   * 窗口就会自己长大约 1px——DPI 往返（DIP → 物理 → DIP）的取整误差被
   * 累积到了**尺寸**上，而且不会缩回去。实测数据：
   *
   * ```
   * 创建后            223x223      （请求 220）
   * setPosition × 60  283x283      （涨了 60px）
   * setBounds  × 60   220x220      （精确，不漂移）
   * ```
   *
   * 物理引擎在拖拽时以 125Hz 调用这里，所以每次拖动都会让窗口长大几十像素，
   * 并且**永久保留**。用户看到的现象是："拖得越久，余额徽章和工具栏离宠物
   * 越远"——徽章钉在窗口底边、工具栏钉在顶边，而宠物始终在窗口里居中，
   * 窗口一大，上下两边就同时分开。反复拖拽会不断累积，最后宠物变成一个大
   * 透明窗口中央的小点。
   */
  setPosition(x: number, y: number): void {
    if (!this.isAlive) return
    this.#window.setBounds({ x, y, width: this.#size, height: this.#size })
  }

  /**
   * 改变窗口边长，**保持中心不动**。
   *
   * 保持中心而不是左上角：滚轮缩放时宠物应该「原地变大」。若钉住左上角，
   * 每次放大都会朝右下角长出去，反复缩放后宠物会一点点挪到屏幕边缘。
   *
   * 尺寸同样必须经 `setBounds` 显式写入（理由见 {@link setPosition}）。
   *
   * @param size - 新的边长（DIP），调用方负责夹到合法范围。
   */
  setSize(size: number): void {
    if (!this.isAlive) return
    const bounds = this.#window.getBounds()
    const centerX = bounds.x + bounds.width / 2
    const centerY = bounds.y + bounds.height / 2
    this.#size = size
    this.#window.setBounds({
      x: Math.round(centerX - size / 2),
      y: Math.round(centerY - size / 2),
      width: size,
      height: size,
    })
  }

  /** 当前窗口边长（DIP）。 */
  get size(): number {
    return this.#size
  }

  /** 向渲染进程推送事件。 */
  send(channel: EventChannel, payload: unknown): void {
    if (!this.isAlive) return
    const contents = this.#window.webContents
    if (contents.isDestroyed()) return
    contents.send(channel, payload)
  }

  /**
   * 构造窗口物理模拟器的宿主适配器。
   *
   * 把 Electron 的同步 API 包装成模拟器需要的窄接口，
   * 让模拟器本身完全不依赖 Electron。
   *
   * @param hooks - 模拟器的输出回调。
   * @returns 可直接传给 `new WindowPhysics(options, host)` 的宿主。
   */
  createPhysicsHost(
    hooks: Omit<
      WindowPhysicsHost,
      'measure' | 'setPosition' | 'workAreaAt' | 'unionWorkArea' | 'cursorPoint'
    >,
  ): WindowPhysicsHost {
    return {
      measure: () => this.getBounds(),
      setPosition: (x, y) => this.setPosition(x, y),
      workAreaAt: (x, y) => screen.getDisplayNearestPoint({ x, y }).workArea,
      unionWorkArea: () => unionOfWorkAreas(),
      // 与 setPosition 同坐标系，避免渲染进程 screenX 的 DPI 换算问题。
      cursorPoint: () => screen.getCursorScreenPoint(),
      ...hooks,
    }
  }

  /** 平台相关的边界处理。 */
  #applyPlatformTweaks(options: PetWindowOptions): void {
    // macOS：让窗口在所有 Space 与全屏应用之上都可见。
    // 其他平台该调用是空操作，直接调用即可，无需分支。
    this.#window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

    if (options.alwaysOnTop) this.setAlwaysOnTop(true)
    if (options.clickThrough) this.setClickThrough(true)
  }

  /** 加载渲染进程页面。 */
  #load(options: PetWindowOptions): void {
    const window = this.#window
    this.#installDiagnostics(window)
    this.#installShowFallbacks(window)

    if (options.devServerUrl) {
      void window.loadURL(options.devServerUrl)
      return
    }
    void window.loadFile(join(rendererDirectory(), 'index.html'))
  }

  /**
   * 安全地显示窗口。
   *
   * ## 为什么要三条路径
   *
   * 只用 `ready-to-show` 是常见写法，但它在**透明窗口**上偶发不触发：
   * 该事件要求渲染进程已经产出首帧，而透明窗口在某些驱动路径下首帧
   * 迟迟不就绪。一旦不触发，`show()` 永远不会被调用——用户看到的是
   * "什么都没发生"，进程却活着。这是最难排查的一类症状。
   *
   * 所以这里挂三条，先到先得（重复调用 `show()` 是安全的）：
   *  1. `ready-to-show`：首选，首帧已就绪，不会出现"先白后透明"的闪烁；
   *  2. `did-finish-load`：页面加载完成即可，不依赖首帧判定；
   *  3. 超时兜底：即使页面始终加载不成功也要显示窗口——
   *     一个空白窗口比"什么都没有"好排查得多。
   *
   * @param window - 宠物窗口。
   */
  #installShowFallbacks(window: BrowserWindow): void {
    let shown = false
    const showOnce = (reason: string): void => {
      if (shown || window.isDestroyed()) return
      shown = true
      window.show()
      // 这行是排查"看不到宠物"最直接的线索：
      // 它出现 → 窗口确实显示了，问题在渲染内容或窗口位置；
      // 它不出现 → 卡在显示之前的某个环节。
      console.log(`[dsh-token-pet] 宠物窗口已显示（${reason}）`)
    }

    window.once('ready-to-show', () => showOnce('ready-to-show'))
    window.webContents.once('did-finish-load', () => showOnce('did-finish-load'))

    const timer = setTimeout(() => showOnce('兜底超时'), SHOW_FALLBACK_MS)
    window.once('closed', () => clearTimeout(timer))
  }

  /**
   * 把渲染进程侧的失败转发到主进程 stdout。
   *
   * 桌宠没有 DevTools、也没有任务栏入口，渲染进程里发生的错误
   * （脚本被 CSP 拦下、preload 抛异常、页面路径写错）默认是**完全静默**的：
   * 用户只会看到"没有宠物"。所以这几类事件必须显式接出来。
   *
   * @param window - 宠物窗口。
   */
  #installDiagnostics(window: BrowserWindow): void {
    const contents = window.webContents

    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // 子框架失败无关紧要，只关心主框架。
      if (!isMainFrame) return
      console.error(`[dsh-token-pet] 页面加载失败：${errorCode} ${errorDescription}（${validatedURL}）`)
    })

    contents.on('preload-error', (_event, preloadPath, error) => {
      console.error(`[dsh-token-pet] preload 执行出错（${preloadPath}）：${error.message}`)
    })

    // 注意参数个数：WebContents 上是 (event, details)，
    // 三参数的 (event, webContents, details) 是 App 上的同名事件。
    contents.on('render-process-gone', (_event, details) => {
      console.error(`[dsh-token-pet] 渲染进程终止：${details.reason}`)
    })

    contents.on('console-message', (_event, levelOrDetails: unknown, maybeMessage?: unknown) => {
      const entry = normalizeConsoleMessage(levelOrDetails, maybeMessage)
      // 只转发警告与错误，避免渲染进程的普通日志淹没 stdout。
      if (!entry || (entry.level < 2 && !entry.isPolicyViolation)) return
      console.warn(`[renderer${entry.source ? `/${entry.source}` : ''}] ${entry.message}`)
    })
  }
}

/** 归一化后的 console 消息。 */
interface ConsoleEntry {
  /** 0 verbose、1 info、2 warning、3 error。 */
  readonly level: number
  /** 消息来源；旧载荷形式下为空串。 */
  readonly source: string
  readonly message: string
  /** 是否是 CSP / 策略拦截。 */
  readonly isPolicyViolation: boolean
}

/**
 * 归一化 `console-message` 的两种载荷形式。
 *
 * Electron 33 的 `WebContents` 用的是旧形式 `(level, message, line, sourceId)`，
 * 而 35+ 换成了单个 `MessageDetails` 对象。这里两种都认：诊断代码最不该
 * 因为版本差异而**静默**失效，那恰好违背它存在的意义。
 *
 * CSP 拦截在新形式下表现为 `source === 'security' | 'violation'`；旧形式下
 * 没有结构化的来源字段，只能靠消息文本里是否出现 "Content Security Policy" 判断。
 *
 * @param levelOrDetails - 第二个实参，可能是数字（旧）或对象（新）。
 * @param maybeMessage - 旧形式下的消息文本。
 * @returns 归一化结果；无法识别时返回 `undefined`。
 */
function normalizeConsoleMessage(levelOrDetails: unknown, maybeMessage: unknown): ConsoleEntry | undefined {
  if (typeof levelOrDetails === 'object' && levelOrDetails !== null) {
    const details = levelOrDetails as { level?: unknown; source?: unknown; message?: unknown }
    const source = typeof details.source === 'string' ? details.source : ''
    return {
      level: typeof details.level === 'number' ? details.level : 0,
      source,
      message: typeof details.message === 'string' ? details.message : '',
      isPolicyViolation: source === 'security' || source === 'violation',
    }
  }

  if (typeof levelOrDetails === 'number') {
    const message = typeof maybeMessage === 'string' ? maybeMessage : ''
    return {
      level: levelOrDetails,
      source: '',
      message,
      isPolicyViolation: message.includes('Content Security Policy'),
    }
  }

  return undefined
}

/**
 * 计算初始位置。
 *
 * 用 `screen.getPrimaryDisplay().workArea` 而不是 `getBounds()`：
 * 后者包含任务栏区域，会让宠物一半藏在任务栏下面。
 */
function initialPosition(size: number): { x: number; y: number } {
  const { workArea } = screen.getPrimaryDisplay()
  return {
    x: workArea.x + workArea.width - size - INITIAL_MARGIN,
    y: workArea.y + workArea.height - size - INITIAL_MARGIN,
  }
}

/**
 * 计算所有显示器工作区的并集。
 *
 * 拖拽时用它约束窗口：既挡住最外侧的越界（宠物滑出屏幕），又允许窗口在
 * 相邻显示器之间自由移动。
 *
 * 换成"窗口所在的那块显示器"是不行的：窗口会被夹在 A 屏右边缘、中心永远
 * 够不到边界，跨屏拖拽会直接卡死。并集没有这个问题——只要相邻显示器的工作区
 * 是连通的（常见的左右/上下排列），窗口就能顺畅地跨过去。
 *
 * 注意它只是外接矩形：显示器呈 L 形排列时，矩形里会有不被任何屏幕覆盖的
 * 死角。这比"能跑到任意位置"已经好得多，且这种排列很少见。
 *
 * @returns 并集矩形；一块屏都取不到时退回主显示器工作区。
 */
function unionOfWorkAreas(): Bounds {
  const areas = screen.getAllDisplays().map((display) => display.workArea)
  if (areas.length === 0) return screen.getPrimaryDisplay().workArea

  const left = Math.min(...areas.map((area) => area.x))
  const top = Math.min(...areas.map((area) => area.y))
  const right = Math.max(...areas.map((area) => area.x + area.width))
  const bottom = Math.max(...areas.map((area) => area.y + area.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * 定位 preload 脚本。
 *
 * 编译产物是 `dist/main/…` 与 `dist/preload/index.js`，
 * 所以从当前模块出发是 `../preload/index.js`。
 */
function resolvePreloadPath(): string {
  const candidate = join(__dirname, '..', 'preload', 'index.js')
  if (existsSync(candidate)) return candidate
  // 走到这里说明构建产物缺失，报错比静默降级（渲染进程拿不到 bridge）好排查。
  throw new Error(`找不到 preload 脚本：${candidate}。请先执行 npm run build:main`)
}

/** 渲染进程构建产物目录。 */
function rendererDirectory(): string {
  return join(__dirname, '..', 'renderer')
}
