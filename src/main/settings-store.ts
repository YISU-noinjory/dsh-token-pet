/**
 * 运行期设置的持久化（`userData/pet-settings.json`）。
 *
 * ## 为什么不写回 `pet.config.json`
 *
 * 那是**应用根目录**里的配置文件：打包成 asar 之后是只读的，而且把用户
 * 滚轮随手调出来的尺寸写进"配置"，会让配置和状态混在一起。所以运行期
 * 状态单独存一份，配置文件仍然只由用户自己编辑。
 *
 * ## 优先级
 *
 * `默认值 < pet.config.json < pet-settings.json`
 *
 * 运行期状态排最后，因为它是用户**最近一次明确操作**的结果（滚了一下滚轮），
 * 比静态配置更新。否则用户每次调完尺寸、重启又变回去，会以为功能坏了。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { PET_SIZE_LIMITS } from '../shared/config'

/** 状态文件名。 */
const FILE_NAME = 'pet-settings.json'

/**
 * 会持久化的字段。
 *
 * 刻意只放"用户会在运行期调整"的项。托盘里的置顶/穿透开关目前仍是
 * 会话级的（不落盘），需要时在这里加字段即可。
 */
export interface PersistedSettings {
  /** 窗口边长（DIP），由滚轮缩放写入。 */
  windowSize?: number
}

/** 状态文件绝对路径。 */
function settingsPath(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

/**
 * 读取持久化的设置。
 *
 * 文件不存在、内容损坏、字段类型不对，一律静默退回空对象——
 * 启动不该因为一个状态文件起不来。
 *
 * @returns 通过校验的字段。
 */
export function loadPersistedSettings(): PersistedSettings {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(settingsPath(), 'utf8'))
  } catch {
    return {}
  }
  if (typeof raw !== 'object' || raw === null) return {}

  const input = raw as Record<string, unknown>
  const result: PersistedSettings = {}

  if (typeof input.windowSize === 'number' && Number.isFinite(input.windowSize)) {
    // 即便文件被手改过，也夹回合法范围：窗口尺寸越界会让界面无法操作。
    result.windowSize = Math.min(
      Math.max(Math.round(input.windowSize), PET_SIZE_LIMITS.min),
      PET_SIZE_LIMITS.max,
    )
  }

  return result
}

/**
 * 合并写入设置。
 *
 * 先读后写而不是直接覆盖：这样以后新增字段时，旧版本写下的其他键不会被抹掉。
 *
 * @param patch - 要写入的字段。
 */
export function savePersistedSettings(patch: PersistedSettings): void {
  const merged: PersistedSettings = { ...loadPersistedSettings(), ...patch }
  try {
    writeFileSync(settingsPath(), `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
  } catch (cause) {
    // 落盘失败只影响"下次启动的记忆"，不该打断当前交互。
    console.warn(`[dsh-token-pet] 保存设置失败：${String(cause)}`)
  }
}
