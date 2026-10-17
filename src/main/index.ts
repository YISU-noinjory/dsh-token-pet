/**
 * 主进程入口：把窗口、物理、数据层三者装配起来，并管理应用生命周期。
 *
 * 数据流一览：
 *
 *     BalancePoller ──状态──► 广播 ──► 渲染进程（余额 UI + 情绪）
 *                                        │
 *     BrowserWindow ◄──位置── WindowPhysics
 *          ▲                    ▲
 *          │                    │
 *          拖拽/释放速度 ◄──── 渲染进程（指针采样）
 *
 * 也就是说：渲染进程负责「采样用户意图」，主进程负责「推演物理与世界状态」，
 * 结果再回流到渲染进程做形变。渲染进程从不自己决定窗口位置。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, dialog, Menu, protocol, screen, type BrowserWindow } from 'electron'
import { EVENT_CHANNELS } from '../shared/ipc'
import { DEFAULT_SETTINGS, PET_SIZE_LIMITS } from '../shared/config'
import type { BalanceState, PetSettings, PetImageView } from '../shared/types'
import { BalanceClient, BALANCE_ENDPOINT } from '../data/balance-client'
import { BalancePoller } from '../data/balance-poller'
import { CredentialChain } from '../data/credentials'
import { PetWindow } from './pet-window'
import { registerIpcHandlers } from './ipc-handlers'
import { DEFAULT_PHYSICS, WindowPhysics } from './window-physics'
import { PetTray } from './tray'
import { teeConsoleToFile } from './log-file'
import { loadPersistedSettings, savePersistedSettings } from './settings-store'
import { redactValue } from '../shared/redact'
import {
  PET_IMAGE_SCHEME,
  PET_IMAGE_SCHEME_PRIVILEGES,
  PetImageStore,
  createPetImageProtocolHandler,
} from './pet-image'

/** 应用级可变状态。用模块级变量而非类，是因为 Electron 的入口就是过程式的。 */
let petWindow: PetWindow | undefined
let physics: WindowPhysics | undefined
let poller: BalancePoller | undefined
let petImageStore: PetImageStore | undefined
let tray: PetTray | undefined
/** 显示器变化处理函数，退出时移除监听用。 */
let displayChangeHandler: (() => void) | undefined
let disposeIpc: (() => void) | undefined
let settings: PetSettings = DEFAULT_SETTINGS

/**
 * 在 `app.whenReady()` **之前**读到的原始配置。
 *
 * 之所以要提前读一次：下面两个启动开关必须在 ready 之前生效，
 * 而 `app.getAppPath()` 在 ready 之前是可用的，所以这里直接读盘。
 * 读到的结果缓存下来，`loadSettings()` 复用同一份，避免读两次文件
 * 而出现"启动开关和用户设置来自不同版本配置"的诡异情况。
 */
const rawConfig = readRawConfig()

/**
 * Linux 上透明窗口需要显式开启合成支持。
 *
 * 必须在 `app.whenReady()` 之前调用，之后设置不再生效。
 * 其他平台该 switch 无副作用。
 */
app.commandLine.appendSwitch('enable-transparent-visuals')

/**
 * 透明窗口在部分环境下会**完全不可见**——窗口存在、进程活着、
 * 但屏幕上什么都没有。已知触发条件包括：
 *  - 某些 Windows 显卡驱动（尤其较旧的 Intel 集显）参与合成时；
 *  - 远程桌面 / 虚拟机等没有真实 GPU 的场景；
 *  - 多屏且缩放比不一致时的合成层处理。
 *
 * 这类问题的唯一稳妥解法是关掉硬件加速。因此提供一个逃生开关：
 * 环境变量 `DSH_PET_DISABLE_GPU=1`，或 `pet.config.json` 里的
 * `"disableHardwareAcceleration": true`。
 *
 * 必须在 ready 之前调用，所以放在模块顶层。
 */
if (shouldDisableHardwareAcceleration(rawConfig)) {
  app.disableHardwareAcceleration()
  console.warn(
    '[dsh-token-pet] 已关闭硬件加速。若宠物可见了，说明之前是 GPU 合成把透明窗口渲染没了。',
  )
}

/**
 * 把 `pet-image:` 注册为标准且安全的协议。
 *
 * **必须在 `app.whenReady()` 之前**：之后调用会抛异常，因为 Chromium
 * 已经在启动时确定了协议表。这条调用因此放在模块顶层，而不是 bootstrap 里。
 */
protocol.registerSchemesAsPrivileged([...PET_IMAGE_SCHEME_PRIVILEGES])

/* ------------------------------------------------------------------ *
 * 单实例
 * ------------------------------------------------------------------ */

// 桌宠在任务栏没有入口，用户很容易重复双击图标启动第二个。
// 单实例锁保证「再启动一次」只会把已有的宠物拉到前面。
const hasLock = app.requestSingleInstanceLock()
if (!hasLock) {
  // 这是"运行后什么都没出现"最隐蔽的原因：上一次的进程还活着，
  // 新进程在这里静默退出，用户操作的仍然是**旧进程**——如果旧进程是
  // 修复前启动的，他会以为修复没生效。所以这段话必须把这一点讲明白。
  console.warn(
    [
      '',
      '='.repeat(72),
      '[dsh-token-pet] 已有实例在运行，本次启动退出（单实例锁）。',
      '',
      '  你正在操作的仍然是**之前那个进程**。如果它是改动之前启动的，',
      '  你看到的就是旧代码的行为——新构建根本没有生效。',
      '',
      '  处理：先把所有 electron.exe 结束掉，再重新启动。',
      '        npm run restart    （会自动结束旧实例再启动）',
      '='.repeat(72),
      '',
    ].join('\n'),
  )
  app.quit()
} else {
  app.on('second-instance', () => {
    const window = petWindow?.browserWindow
    if (!window || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  })

  // bootstrap 是异步的，失败必须显式接住：默认的未处理拒绝
  // 在没有窗口的情况下会让进程挂成一个看不见的僵尸。
  // 退出并留下明确报错，比"什么都没有"好排查得多。
  void bootstrap().catch((cause: unknown) => {
    console.error('[dsh-token-pet] 启动失败：', cause)
    app.quit()
  })
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

/** 组装并启动全部子系统。 */
async function bootstrap(): Promise<void> {
  await app.whenReady()

  // 尽早接上文件日志：Node 写 UTF-8、cmd 用 GBK 显示，中文在控制台里是乱码，
  // 排查问题时根本读不出数字。文件由我们决定编码。
  const logFile = teeConsoleToFile()

  console.log('[dsh-token-pet] 正在启动…')
  console.log(`[dsh-token-pet] 日志文件：${logFile}（若控制台是乱码，看这个文件）`)

  settings = loadSettings()

  /* --- 自定义宠物图片 --- */

  const imageStore = new PetImageStore()
  // 先把磁盘上的状态读回来，再创建窗口：这样渲染进程首帧拿到的
  // getView() 就是最终状态，不会先画内置宠物再闪一下换成图片。
  await imageStore.load()
  petImageStore = imageStore
  // 协议处理函数在这里而不是模块顶层注册：它依赖 store 实例，
  // 而 store 需要 app ready 之后才能拿到 userData 路径。
  protocol.handle(PET_IMAGE_SCHEME, createPetImageProtocolHandler(imageStore))

  petWindow = PetWindow.create({
    size: settings.windowSize,
    alwaysOnTop: settings.alwaysOnTop,
    clickThrough: settings.clickThrough,
    ...(process.env.DSH_PET_DEV_SERVER ? { devServerUrl: process.env.DSH_PET_DEV_SERVER } : {}),
  })

  const window = petWindow
  const initialBounds = window.getBounds()

  // 这行同时给出两个排查"看不到宠物"最需要的信息：
  // 窗口被放在哪儿（位置离谱就是跑了但看不见），以及工作区尺寸。
  const display = screen.getPrimaryDisplay()
  console.log(
    `[dsh-token-pet] 窗口位置 (${initialBounds.x}, ${initialBounds.y})，` +
      `尺寸 ${initialBounds.width}×${initialBounds.height}；` +
      `主显示器工作区 ${display.workArea.width}×${display.workArea.height} @(${display.workArea.x}, ${display.workArea.y})`,
  )

  /* --- 物理 --- */

  physics = new WindowPhysics(
    DEFAULT_PHYSICS,
    window.createPhysicsHost({
      // 运动帧 → 渲染进程，驱动精灵的滞后形变。
      onFrame: (frame) => window.send(EVENT_CHANNELS.motion, frame),
      onStateChange: (state) => window.send(EVENT_CHANNELS.motionState, state),
      onImpact: (horizontal, vertical, speed) =>
        window.send(EVENT_CHANNELS.impact, { horizontal, vertical, speed }),
    }),
  )
  physics.setAnchor(initialBounds.x, initialBounds.y)
  physics.start()

  /* --- 数据层 --- */

  poller = new BalancePoller({
    client: new BalanceClient({ endpoint: resolveEndpoint() }),
    // 每次请求前重新解析凭证：用户补上 .env 或换 Key 后无需重启。
    credentials: CredentialChain.default(app.getAppPath()),
    intervalMs: settings.pollIntervalMs,
    onState: (state: BalanceState) => window.send(EVENT_CHANNELS.balanceState, state),
    log: (message) => console.warn(message),
  })
  poller.start()

  /* --- IPC --- */

  disposeIpc = registerIpcHandlers({
    petWindow: window,
    physics,
    poller,
    petImageStore: imageStore,
    getSettings: () => settings,
    patchSettings: applySettings,
    publishPetImage,
    quit: () => app.quit(),
  })

  registerContextMenu(window.browserWindow)

  /* --- 托盘 --- */

  // 桌宠没有任务栏入口，托盘是它唯一的常驻可见入口：
  // 用来把宠物叫回来、隐藏它、或者明确退出。
  tray = new PetTray({
    petWindow: window,
    physics,
    getSettings: () => settings,
    patchSettings: applySettings,
    refreshBalance: () => {
      void poller?.refresh()
    },
    quit: () => app.quit(),
  })

  /* --- 显示器变化 --- */

  // 拔掉显示器、改分辨率或改缩放比例之后，窗口可能停在已经不存在的坐标上，
  // 表现就是"宠物不见了"而进程还活着。这里做兜底。
  registerDisplayHandlers(window, physics)

  app.on('activate', () => {
    // macOS：点 Dock 图标时把宠物重新显示出来。
    const target = petWindow?.browserWindow
    if (target && !target.isDestroyed()) target.show()
  })
}

/**
 * 合并写入设置，并让改动立即生效。
 *
 * 副作用集中在这里而不是各个调用点：改设置有多个入口（渲染进程的 IPC、
 * 托盘菜单、右键菜单），任何一处漏掉都会造成"改了但没生效"这类难查的问题。
 *
 * @param patch - 要合并的字段。
 * @returns 合并后的完整设置。
 */
function applySettings(patch: Partial<PetSettings>): PetSettings {
  const previousSize = settings.windowSize
  settings = { ...settings, ...patch }
  // 轮询间隔变更要立刻生效，否则用户改了设置得等下一个周期。
  if (patch.pollIntervalMs !== undefined) restartPoller(settings.pollIntervalMs)
  petWindow?.setAlwaysOnTop(settings.alwaysOnTop)
  petWindow?.setClickThrough(settings.clickThrough)

  if (settings.windowSize !== previousSize) {
    const size = Math.min(Math.max(Math.round(settings.windowSize), PET_SIZE_LIMITS.min), PET_SIZE_LIMITS.max)
    settings = { ...settings, windowSize: size }
    // 窗口保持中心不动地缩放，再把物理引擎的尺寸缓存与锚点重新对齐。
    petWindow?.setSize(size)
    physics?.refreshGeometry()
    schedulePersist()
  }

  return settings
}

/**
 * 延迟把设置写盘。
 *
 * 滚轮一次滚动会连发十几二十次补丁，逐次写文件既浪费也毫无意义。
 * 停下来 400ms 之后写一次，既是用户结束操作的时刻，也不会丢最后一次意图。
 */
let persistTimer: NodeJS.Timeout | undefined

function schedulePersist(): void {
  if (persistTimer !== undefined) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = undefined
    savePersistedSettings({ windowSize: settings.windowSize })
  }, 400)
}

/** 立即把待写的设置刷盘（退出前调用）。 */
function flushPersist(): void {
  if (persistTimer === undefined) return
  clearTimeout(persistTimer)
  persistTimer = undefined
  savePersistedSettings({ windowSize: settings.windowSize })
}

/**
 * 注册显示器变化处理。
 *
 * @param window - 宠物窗口。
 * @param physics - 窗口物理引擎。
 */
function registerDisplayHandlers(window: PetWindow, physics: WindowPhysics): void {
  const handleChange = (): void => {
    // 先把窗口拉回可见区，再判断锚点是否还成立——顺序不能反，
    // 否则会拿旧坐标去算锚点可见性。
    physics.ensureOnScreen()
    if (physics.isAnchorOnScreen()) return
    // 原来的「家」已经不在任何屏幕上了（比如那块显示器被拔掉）。
    // 把家改到当前位置，避免停稳后自动归位到一个看不见的坐标。
    const bounds = window.getBounds()
    physics.setAnchor(bounds.x, bounds.y)
    console.log(`[dsh-token-pet] 显示器配置变化，宠物已重新定位到 (${bounds.x}, ${bounds.y})`)
  }

  displayChangeHandler = handleChange
  screen.on('display-metrics-changed', handleChange)
  screen.on('display-added', handleChange)
  screen.on('display-removed', handleChange)
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

// 宠物窗口是唯一的窗口：关掉它就等于退出应用。
app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  // 把还挂在防抖定时器里的设置写盘——用户可能刚滚完就退出，
  // 那 400ms 还没到，不在这里补一刀就会丢掉最后一次调整。
  flushPersist()

  // 顺序很重要：先停轮询，避免退出过程中还有在途请求回调过来访问已销毁的窗口。
  poller?.stop()
  physics?.stop()

  // 托盘必须显式销毁，否则图标会残留在通知区域，直到鼠标划过才消失。
  tray?.destroy()
  tray = undefined

  if (displayChangeHandler) {
    screen.removeListener('display-metrics-changed', displayChangeHandler)
    screen.removeListener('display-added', displayChangeHandler)
    screen.removeListener('display-removed', displayChangeHandler)
    displayChangeHandler = undefined
  }

  disposeIpc?.()
  disposeIpc = undefined
  petWindow = undefined
  physics = undefined
  poller = undefined
  petImageStore = undefined
})

/* ------------------------------------------------------------------ *
 * 辅助
 * ------------------------------------------------------------------ */

/**
 * 右键菜单。
 *
 * 窗口没有边框也没有任务栏入口，右键菜单是用户唯一能稳定触及的
 * 「应用级操作」入口（换图、刷新余额、切换置顶/穿透、退出）。
 * 渲染进程的悬停工具栏是同一批操作的快捷入口，但菜单是保底的那一份——
 * 工具栏依赖命中测试与悬停状态，菜单不依赖任何东西。
 *
 * @param window - 宠物窗口。
 */
function registerContextMenu(window: BrowserWindow): void {
  window.webContents.on('context-menu', () => {
    const current = petWindow
    if (!current) return
    const view = petImageStore?.getView()
    Menu.buildFromTemplate([
      {
        label: view?.hasImage ? '更换宠物图片…' : '导入宠物图片…',
        click: () => {
          void selectPetImage()
        },
      },
      {
        label: '显示抠图（去掉背景）',
        type: 'checkbox',
        // 没有抠图产物时禁用：抠不出来（或格式不支持）就没什么可切的。
        enabled: view?.hasCutout === true,
        checked: view?.showingCutout === true,
        click: (item) => {
          void toggleCutout(item.checked)
        },
      },
      {
        label: '圆形裁剪',
        type: 'checkbox',
        // 只在有图片时可用：内置宠物本来就是圆的，这个开关对它没意义。
        enabled: view?.hasImage === true,
        checked: view?.clip === 'circle',
        click: (item) => {
          void applyClip(item.checked ? 'circle' : 'none')
        },
      },
      {
        label: '恢复默认宠物',
        enabled: view?.hasImage === true,
        click: () => {
          void resetPetImage()
        },
      },
      { type: 'separator' },
      {
        label: '立即刷新余额',
        click: () => {
          void poller?.refresh()
        },
      },
      { type: 'separator' },
      {
        label: '始终置顶',
        type: 'checkbox',
        checked: settings.alwaysOnTop,
        click: (item) => {
          // 走 applySettings 而不是直接改 settings：设置的副作用只有那一份实现，
          // 否则托盘菜单与这里会各自维护一遍"改了要生效"。
          applySettings({ alwaysOnTop: item.checked })
        },
      },
      {
        label: '鼠标穿透',
        type: 'checkbox',
        checked: settings.clickThrough,
        click: (item) => {
          applySettings({ clickThrough: item.checked })
        },
      },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]).popup({ window })
  })
}

/* ------------------------------------------------------------------ *
 * 宠物图片：主进程侧的统一入口
 * ------------------------------------------------------------------ */

/**
 * 把图片状态广播给渲染进程。
 *
 * 换图有两条入口（渲染进程按钮、原生右键菜单），两条都必须走这里，
 * 否则菜单换的图不会反映到界面上。
 *
 * @param view - 新状态。
 */
function publishPetImage(view: PetImageView): void {
  petWindow?.send(EVENT_CHANNELS.petImageChanged, view)
}

/**
 * 弹出选择框并导入图片（右键菜单入口）。
 *
 * 渲染进程那条入口走 IPC，行为等价；两处都只是调用 store，
 * 真正的校验、复制、持久化只有 store 里那一份实现。
 */
async function selectPetImage(): Promise<void> {
  const store = petImageStore
  if (!store) return
  const result = await store.select(petWindow?.browserWindow)
  if (result.status === 'selected') {
    publishPetImage(result.view)
  } else if (result.status === 'rejected') {
    // 菜单入口没有可以回显错误的界面，用系统提示框兜底。
    // 渲染进程入口则会把 message 显示成宠物旁边的气泡，更好看也更就近。
    await dialog.showMessageBox({
      type: 'warning',
      title: '无法使用这张图片',
      message: result.message,
      buttons: ['知道了'],
    })
  }
}

/** 切换裁剪方式（右键菜单入口）。 */
async function applyClip(clip: 'none' | 'circle'): Promise<void> {
  const store = petImageStore
  if (!store) return
  publishPetImage(await store.setClip(clip))
}

/** 在抠图与原图之间切换（右键菜单入口）。 */
async function toggleCutout(show: boolean): Promise<void> {
  const store = petImageStore
  if (!store) return
  publishPetImage(await store.setShowCutout(show))
}

/** 恢复内置宠物（右键菜单入口）。 */
async function resetPetImage(): Promise<void> {
  const store = petImageStore
  if (!store) return
  publishPetImage(await store.clear())
}

/** 用新的间隔重启轮询。 */
function restartPoller(intervalMs: number): void {
  if (!poller || !petWindow) return
  const window = petWindow
  poller.stop()
  poller = new BalancePoller({
    client: new BalanceClient({ endpoint: resolveEndpoint() }),
    credentials: CredentialChain.default(app.getAppPath()),
    intervalMs,
    onState: (state: BalanceState) => window.send(EVENT_CHANNELS.balanceState, state),
    log: (message) => console.warn(message),
  })
  poller.start()
}

/**
 * 解析接口地址。
 *
 * 允许通过环境变量指向 mock 服务，便于在没有真实 Key 的情况下
 * 开发 UI 与物理手感。
 */
function resolveEndpoint(): string {
  return process.env.DSH_PET_BALANCE_ENDPOINT ?? BALANCE_ENDPOINT
}

/**
 * 在 app ready 之前读一次 `pet.config.json`。
 *
 * ## 为什么有两个候选位置
 *
 * 开发时配置在项目根，用 `app.getAppPath()` 就能拿到。但**打包之后**
 * `getAppPath()` 指向 `resources/app.asar`——那是归档内部的虚拟路径，
 * 用户既改不到也放不进去，配置会静默失效。
 *
 * 所以先找**可执行文件旁边**（安装目录，用户能编辑），找不到再回落到应用根。
 * 这个顺序不能反：反过来在打包版里会先命中 asar 内部那个不存在的路径。
 *
 * 读失败或格式错误都退回空对象——拿不到配置时的正确行为是"用默认值继续跑"，
 * 而不是让应用起不来。
 *
 * @returns 解析后的原始对象；不存在或不可解析时为空对象。
 */
function readRawConfig(): Record<string, unknown> {
  const candidates = [
    // 打包版：安装目录里的配置，用户可编辑。
    join(dirname(app.getPath('exe')), 'pet.config.json'),
    // 开发版：项目根目录。
    join(app.getAppPath(), 'pet.config.json'),
  ]

  for (const configPath of candidates) {
    if (!existsSync(configPath)) continue
    try {
      const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null) return {}
      return parsed as Record<string, unknown>
    } catch (cause) {
      console.warn(
        `[dsh-token-pet] pet.config.json 解析失败，使用默认设置：${redactValue(cause)}`,
      )
      return {}
    }
  }

  return {}
}

/**
 * 是否关闭硬件加速。
 *
 * @param config - ready 之前读到的原始配置。
 * @returns 环境变量显式要求，或配置里打开时返回 `true`。
 */
function shouldDisableHardwareAcceleration(config: Record<string, unknown>): boolean {
  if (process.env.DSH_PET_DISABLE_GPU === '1') return true
  return config.disableHardwareAcceleration === true
}

/**
 * 读取设置。
 *
 * 配置来源优先级：`pet.config.json`（应用根目录）> 内置默认值。
 * 这里刻意**不**把 API Key 作为配置项：Key 属于机密，
 * 应当走环境变量或系统钥匙串，而不是一个可能被提交进版本库的 JSON 文件。
 *
 * 再加上 `pet-settings.json`（userData）里的运行期状态，且它优先级最高：
 * 那是用户最近一次明确操作的结果（滚轮调过的尺寸），比静态配置更新。
 *
 * @returns 合并后的设置。
 */
function loadSettings(): PetSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...pickKnownSettings(rawConfig),
    ...loadPersistedSettings(),
  }
}

/** 从任意对象里挑出已知的设置字段。 */
function pickKnownSettings(raw: Record<string, unknown>): Partial<PetSettings> {
  const result: Record<string, unknown> = {}
  const numericKeys = [
    'pollIntervalMs',
    'windowSize',
    'lowBalanceThreshold',
    'warnBalanceThreshold',
  ] as const
  for (const key of numericKeys) {
    const value = raw[key]
    if (typeof value === 'number' && Number.isFinite(value)) result[key] = value
  }
  const booleanKeys = ['alwaysOnTop', 'clickThrough'] as const
  for (const key of booleanKeys) {
    const value = raw[key]
    if (typeof value === 'boolean') result[key] = value
  }
  return result as Partial<PetSettings>
}
