/**
 * 主进程的 IPC 注册。
 *
 * 全部 handler 集中在这里注册，而不是散落在各模块内部，
 * 目的是让「渲染进程能调用哪些东西」在一个文件里一眼看完，
 * 便于做安全审查。
 *
 * 入参一律校验：IPC 的载荷来自渲染进程，即便当前渲染进程是自己的代码，
 * 一旦页面被注入（例如余额文本里藏了 HTML），未校验的入参会直接
 * 传到 `setPosition` 这类敏感 API 上。
 */

import { ipcMain } from 'electron'
import { INVOKE_CHANNELS } from '../shared/ipc'
import type {
  BalanceState,
  FortuneReading,
  PetImageSelectResult,
  PetImageView,
  PetSettings,
} from '../shared/types'
import type { BalancePoller } from '../data/balance-poller'
import type { PetImageStore } from './pet-image'
import type { PetWindow } from './pet-window'
import type { WindowPhysics } from './window-physics'

/** 注册处理器所需的外部依赖。 */
export interface IpcHandlersDeps {
  readonly petWindow: PetWindow
  readonly physics: WindowPhysics
  readonly poller: BalancePoller
  readonly petImageStore: PetImageStore
  /** 读当前设置。 */
  readonly getSettings: () => PetSettings
  /** 合并写设置，返回写入后的完整设置。 */
  readonly patchSettings: (patch: Partial<PetSettings>) => PetSettings
  /**
   * 把宠物图片的新状态广播给渲染进程。
   *
   * 由调用方提供而不是在处理器里直接 `send`，是因为换图有两条入口
   * （这里的 IPC 与 index.ts 的原生右键菜单），广播逻辑只能有一份。
   */
  readonly publishPetImage: (view: PetImageView) => void
  /**
   * 抽一签。
   *
   * 由 index.ts 提供：它持有 FortuneOracle，也负责创建签筒窗口。
   * 处理器只管转发，不碰窗口生命周期。
   */
  readonly drawFortune: () => Promise<FortuneReading>
  /** 读当前这一签；没有时为 `null`。 */
  readonly getFortune: () => FortuneReading | null
  /** 关闭签筒窗口。 */
  readonly closeFortune: () => void
  /** 请求退出应用。 */
  readonly quit: () => void
}

/**
 * 注册全部 invoke 频道。
 *
 * @param deps - 依赖集合。
 * @returns 反注册函数，用于窗口重建时清理（`ipcMain.handle` 对同一频道
 *          重复注册会抛异常，必须先移除）。
 */
export function registerIpcHandlers(deps: IpcHandlersDeps): () => void {
  const {
    petWindow,
    physics,
    poller,
    petImageStore,
    getSettings,
    patchSettings,
    publishPetImage,
    drawFortune,
    getFortune,
    closeFortune,
    quit,
  } = deps

  ipcMain.handle(INVOKE_CHANNELS.balanceGet, (): BalanceState => poller.getState())

  ipcMain.handle(INVOKE_CHANNELS.balanceRefresh, async (): Promise<void> => {
    await poller.refresh()
  })

  ipcMain.handle(INVOKE_CHANNELS.settingsGet, (): PetSettings => getSettings())

  ipcMain.handle(INVOKE_CHANNELS.settingsPatch, (_event, raw: unknown): PetSettings => {
    const patch = sanitizeSettingsPatch(raw)
    // 让改动立即生效的副作用在 `patchSettings` 的实现里（index.ts 的
    // applySettings），不在这里——改设置有多个入口，副作用只能有一份。
    return patchSettings(patch)
  })

  // 拖拽开始/进行不需要载荷：位置由主进程从 screen 模块读取（见 window-physics.ts）。
  ipcMain.handle(INVOKE_CHANNELS.dragStart, (): void => {
    physics.beginDrag()
  })

  ipcMain.handle(INVOKE_CHANNELS.dragMove, (): void => {
    physics.dragTo()
  })

  ipcMain.handle(INVOKE_CHANNELS.dragEnd, (_event, raw: unknown): void => {
    const velocity = sanitizeDragEnd(raw)
    if (velocity) physics.endDrag(velocity.x, velocity.y)
    else physics.endDrag()
  })

  ipcMain.handle(INVOKE_CHANNELS.petReturn, (): void => {
    physics.returnToAnchor()
  })

  ipcMain.handle(INVOKE_CHANNELS.overlayInteractive, (_event, raw: unknown): void => {
    // 严格等于 true：任何非布尔值都按"穿透"处理。
    // 宁可不响应鼠标，也不要让一层看不见的窗口挡住用户点别的东西。
    petWindow.setInteractive(raw === true)
  })

  /* --- 自定义宠物图片 --- */

  ipcMain.handle(INVOKE_CHANNELS.petImageGet, (): PetImageView => petImageStore.getView())

  ipcMain.handle(INVOKE_CHANNELS.petImageSelect, async (): Promise<PetImageSelectResult> => {
    // 把宠物窗口作为父窗口传入：对话框成为它的模态子窗，
    // 不会因为宠物窗口置顶而跑到它后面看不见。
    const result = await petImageStore.select(petWindow.browserWindow)
    if (result.status === 'selected') publishPetImage(result.view)
    return result
  })

  ipcMain.handle(INVOKE_CHANNELS.petImageClear, async (): Promise<PetImageView> => {
    const view = await petImageStore.clear()
    publishPetImage(view)
    return view
  })

  ipcMain.handle(INVOKE_CHANNELS.petImageSetClip, async (_event, raw: unknown): Promise<PetImageView> => {
    // 白名单收敛到两个字面量，脏值不可能流进 DOM 的 data 属性。
    const view = await petImageStore.setClip(raw === 'circle' ? 'circle' : 'none')
    publishPetImage(view)
    return view
  })

  ipcMain.handle(
    INVOKE_CHANNELS.petImageSetCutout,
    async (_event, raw: unknown): Promise<PetImageView> => {
      // 同样只认严格布尔：`'1'`、`1`、`{}` 一律当 false，
      // 免得渲染进程的脏值把显示状态翻到一个不该有的组合。
      const view = await petImageStore.setShowCutout(raw === true)
      publishPetImage(view)
      return view
    },
  )

  ipcMain.handle(INVOKE_CHANNELS.fortuneDraw, async (): Promise<FortuneReading> => drawFortune())

  ipcMain.handle(INVOKE_CHANNELS.fortuneCurrent, (): FortuneReading | null => getFortune())

  ipcMain.handle(INVOKE_CHANNELS.fortuneClose, (): void => {
    closeFortune()
  })

  ipcMain.handle(INVOKE_CHANNELS.quit, (): void => {
    quit()
  })
  // 返回清理函数，逐一移除，避免热重载或窗口重建时重复注册。
  return () => {
    for (const channel of Object.values(INVOKE_CHANNELS)) {
      ipcMain.removeHandler(channel)
    }
  }
}

/* ------------------------------------------------------------------ *
 * 载荷校验
 * ------------------------------------------------------------------ */

/** 判断是否为有限数值。 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * 解析拖拽结束载荷里的释放速度。
 *
 * 速度是**唯一**从渲染进程流入物理模拟的数值，所以这里必须收紧：
 * 一个 `Infinity` 或 `1e308` 会让窗口在一帧内飞出屏幕且再也找不回来。
 *
 * @param raw - 渲染进程传来的载荷。
 * @returns 合法的速度；缺省或非法时为 `undefined`，调用方会让主进程自行估计。
 */
function sanitizeDragEnd(raw: unknown): { x: number; y: number } | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const velocity = (raw as { velocity?: unknown }).velocity
  if (typeof velocity !== 'object' || velocity === null) return undefined
  const point = velocity as { x?: unknown; y?: unknown }
  if (!isFiniteNumber(point.x) || !isFiniteNumber(point.y)) return undefined

  // 与 window-physics.ts 的 MAX_RELEASE_SPEED 保持一致：这里只做"是不是离谱"的拦截，
  // 精确限幅由物理层负责（它知道自己的单位与上限）。
  const MAX_PLAUSIBLE_SPEED = 20_000
  if (Math.abs(point.x) > MAX_PLAUSIBLE_SPEED || Math.abs(point.y) > MAX_PLAUSIBLE_SPEED) return undefined
  return { x: point.x, y: point.y }
}

/**
 * 过滤设置补丁。
 *
 * 白名单式合并：只接受已知字段且类型正确，其余静默丢弃。
 * 这比 `Object.assign` 安全——后者允许渲染进程塞进任意键，
 * 之后某次 `{ ...defaults, ...settings }` 就会把它们带进配置文件。
 *
 * @param raw - 渲染进程传来的补丁。
 * @returns 通过校验的字段。
 */
function sanitizeSettingsPatch(raw: unknown): Partial<PetSettings> {
  if (typeof raw !== 'object' || raw === null) return {}
  const input = raw as Record<string, unknown>
  const patch: {
    pollIntervalMs?: number
    windowSize?: number
    alwaysOnTop?: boolean
    clickThrough?: boolean
    lowBalanceThreshold?: number
    warnBalanceThreshold?: number
  } = {}

  // 轮询间隔下限 10s：再密没有必要，且会快速消耗接口配额。
  if (isFiniteNumber(input.pollIntervalMs)) {
    patch.pollIntervalMs = Math.min(Math.max(input.pollIntervalMs, 10_000), 3_600_000)
  }
  if (isFiniteNumber(input.windowSize)) {
    patch.windowSize = Math.min(Math.max(input.windowSize, 120), 640)
  }
  if (typeof input.alwaysOnTop === 'boolean') patch.alwaysOnTop = input.alwaysOnTop
  if (typeof input.clickThrough === 'boolean') patch.clickThrough = input.clickThrough
  if (isFiniteNumber(input.lowBalanceThreshold)) patch.lowBalanceThreshold = input.lowBalanceThreshold
  if (isFiniteNumber(input.warnBalanceThreshold)) patch.warnBalanceThreshold = input.warnBalanceThreshold

  return patch
}
