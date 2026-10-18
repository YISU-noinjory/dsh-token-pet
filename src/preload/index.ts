/**
 * preload：渲染进程与主进程之间唯一的通道。
 *
 * 安全模型：
 *  - `contextIsolation: true` + `sandbox: true`，渲染进程拿不到 Node；
 *  - 这里**不暴露 `ipcRenderer` 本身**，而是暴露一组固定的方法。
 *    暴露 ipcRenderer 等于让渲染进程可以往任意频道发消息，
 *    contextIsolation 就白设了；
 *  - 频道名只来自 {@link INVOKE_CHANNELS} / {@link EVENT_CHANNELS} 常量，
 *    杜绝「主进程改了频道名、preload 还在用旧字符串」这类静默失效。
 *
 * 注意：本文件必须被打包成单文件 CJS（见 `vite.preload.config.ts`）。
 * 沙箱化的 preload 只能 `require('electron')` 与少数内置模块，
 * 不能 require 同项目的其他文件。
 */

import { contextBridge, ipcRenderer } from 'electron'
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  type DragEndPayload,
  type PetBridge,
  type PetEventMap,
  type Unsubscribe,
} from '../shared/ipc'
import type {
  BalanceState,
  CredentialSaveResult,
  CredentialStatus,
  FortuneReading,
  PetImageClip,
  PetImageSelectResult,
  PetImageView,
  PetSettings,
} from '../shared/types'

/**
 * 事件名 → 频道名的映射表。
 *
 * 用 `Record<keyof PetEventMap, EventChannel>` 而不是散装 if：
 * 少写一个事件、或写错频道名，都会在编译期报错。
 */
const EVENT_CHANNEL_BY_NAME: Record<keyof PetEventMap, (typeof EVENT_CHANNELS)[keyof typeof EVENT_CHANNELS]> = {
  balance: EVENT_CHANNELS.balanceState,
  motion: EVENT_CHANNELS.motion,
  motionState: EVENT_CHANNELS.motionState,
  impact: EVENT_CHANNELS.impact,
  petImage: EVENT_CHANNELS.petImageChanged,
  fortune: EVENT_CHANNELS.fortuneSignal,
}

/**
 * 订阅主进程事件。
 *
 * @param event - 事件名。
 * @param listener - 载荷回调；`IpcRendererEvent` 被剥离，不泄漏给渲染进程。
 * @returns 取消订阅函数。
 */
function subscribe<K extends keyof PetEventMap>(
  event: K,
  listener: (payload: PetEventMap[K]) => void,
): Unsubscribe {
  const channel = EVENT_CHANNEL_BY_NAME[event]
  // 包一层，把 IpcRendererEvent（含 sender 等敏感引用）挡在渲染进程之外。
  const wrapped = (_ipcEvent: unknown, payload: PetEventMap[K]): void => {
    listener(payload)
  }
  ipcRenderer.on(channel, wrapped)
  return () => {
    ipcRenderer.removeListener(channel, wrapped)
  }
}

/** 渲染进程可用的全部能力。 */
const bridge: PetBridge = {
  balance: {
    get: (): Promise<BalanceState> => ipcRenderer.invoke(INVOKE_CHANNELS.balanceGet),
    refresh: (): Promise<void> => ipcRenderer.invoke(INVOKE_CHANNELS.balanceRefresh),
  },
  settings: {
    get: (): Promise<PetSettings> => ipcRenderer.invoke(INVOKE_CHANNELS.settingsGet),
    patch: (patch: Partial<PetSettings>): Promise<PetSettings> =>
      ipcRenderer.invoke(INVOKE_CHANNELS.settingsPatch, patch),
  },
  drag: {
    // 拖拽位置由主进程读取光标确定，所以 start/move 不需要载荷。
    // 载荷越少，需要校验的面就越小。
    start: (): Promise<void> => ipcRenderer.invoke(INVOKE_CHANNELS.dragStart),
    move: (): Promise<void> => ipcRenderer.invoke(INVOKE_CHANNELS.dragMove),
    end: (payload: DragEndPayload): Promise<void> => ipcRenderer.invoke(INVOKE_CHANNELS.dragEnd, payload),
  },
  pet: {
    return: (): Promise<void> => ipcRenderer.invoke(INVOKE_CHANNELS.petReturn),
  },
  overlay: {
    setInteractive: (interactive: boolean): Promise<void> =>
      ipcRenderer.invoke(INVOKE_CHANNELS.overlayInteractive, interactive === true),
  },
  petImage: {
    get: (): Promise<PetImageView> => ipcRenderer.invoke(INVOKE_CHANNELS.petImageGet),
    // 用户点"取消"时主进程正常返回 { status: 'cancelled' }，不会 reject，
    // 所以渲染进程不需要 try/catch 去区分"取消"和"出错"。
    select: (): Promise<PetImageSelectResult> => ipcRenderer.invoke(INVOKE_CHANNELS.petImageSelect),
    clear: (): Promise<PetImageView> => ipcRenderer.invoke(INVOKE_CHANNELS.petImageClear),
    setClip: (clip: PetImageClip): Promise<PetImageView> =>
      // 只透传白名单字面量，不把渲染进程给的任意值送到主进程。
      ipcRenderer.invoke(INVOKE_CHANNELS.petImageSetClip, clip === 'circle' ? 'circle' : 'none'),
    setCutout: (show: boolean): Promise<PetImageView> =>
      // 强制转成布尔：渲染进程给什么都不该变成别的类型。
      ipcRenderer.invoke(INVOKE_CHANNELS.petImageSetCutout, show === true),
  },
  fortune: {
    draw: (): Promise<FortuneReading> => ipcRenderer.invoke(INVOKE_CHANNELS.fortuneDraw),
    current: (): Promise<FortuneReading | null> => ipcRenderer.invoke(INVOKE_CHANNELS.fortuneCurrent),
    close: (): Promise<void> => ipcRenderer.invoke(INVOKE_CHANNELS.fortuneClose),
  },
  credential: {
    status: (): Promise<CredentialStatus> => ipcRenderer.invoke(INVOKE_CHANNELS.credentialStatus),
    set: (key: string): Promise<CredentialSaveResult> =>
      // 只在边界上收敛成字符串；真正的校验（空值、长度）在主进程里做，
      // 因为那才是决定"存不存"的地方。
      ipcRenderer.invoke(INVOKE_CHANNELS.credentialSet, typeof key === 'string' ? key : ''),
    clear: (): Promise<CredentialStatus> => ipcRenderer.invoke(INVOKE_CHANNELS.credentialClear),
  },
  app: {
    quit: (): Promise<void> => ipcRenderer.invoke(INVOKE_CHANNELS.quit),
  },  on: subscribe,
}

contextBridge.exposeInMainWorld('petBridge', bridge)
