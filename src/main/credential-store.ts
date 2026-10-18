/**
 * 应用内设置 API Key 的加密存储。
 *
 * ## 为什么用 safeStorage 而不是明文 JSON
 *
 * 打包版发给别人之后，用户没有环境变量可配，只能在界面里填 Key。如果把它
 * 明文写进 `userData/*.json`，任何能读这个文件的程序（包括同机的其他账号外的
 * 恶意软件）都能直接拿走——那和写在记事本里没区别。
 *
 * Electron 的 `safeStorage` 在 Windows 上走 **DPAPI**：密文与当前 Windows
 * 用户账号绑定，换用户、换机器都解不开。代价是无法跨设备同步，但对一个
 * 桌面宠物来说这是正确的取舍。
 *
 * ## 失败的姿态
 *
 * 有些环境（部分 Linux 桌面、无钥匙串的容器）`isEncryptionAvailable()` 为
 * false。这时**不降级成明文**——宁可拒绝保存并告诉用户，也不静默写一个
 * 裸 Key 到磁盘。用户在那种环境下仍可用环境变量或 `.env`。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, safeStorage } from 'electron'
import { redactValue } from '../shared/redact'

/** 密文文件名，位于 `app.getPath('userData')` 下。 */
const FILE_NAME = 'pet-credential.bin'

/** 存储状态，供界面展示。 */
export interface CredentialStatus {
  /** 是否已保存过 Key。 */
  readonly hasKey: boolean
  /**
   * 系统加密是否可用。
   *
   * 为 false 时界面应提示"当前系统不支持安全存储"，并引导用户改用环境变量，
   * 而不是让保存按钮假装成功。
   */
  readonly encryptionAvailable: boolean
}

/** 应用内 Key 的存储。 */
export class CredentialStore {
  /** 延迟取路径：`app.getPath` 在 ready 之后才可靠。 */
  #filePath(): string {
    return join(app.getPath('userData'), FILE_NAME)
  }

  /** 系统加密是否可用。 */
  get encryptionAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  /** 当前状态。 */
  getStatus(): CredentialStatus {
    return { hasKey: existsSync(this.#filePath()), encryptionAvailable: this.encryptionAvailable }
  }

  /**
   * 读取并解密 Key。
   *
   * @returns Key 明文；没有存过、或解密失败（换了 Windows 账号、文件损坏）时为 `undefined`。
   */
  read(): string | undefined {
    const path = this.#filePath()
    if (!existsSync(path)) return undefined

    try {
      const encrypted = readFileSync(path)
      return safeStorage.decryptString(encrypted)
    } catch (cause) {
      // 解密失败通常是换了用户账号或文件被改坏。当作"没有 Key"继续跑，
      // 但一定要记日志——否则用户只会看到"未配置 Key"而不知道为什么。
      console.warn(`[dsh-token-pet] 读取已保存的 API Key 失败：${redactValue(cause)}`)
      return undefined
    }
  }

  /**
   * 加密保存 Key。
   *
   * @param key - Key 明文。
   * @throws 系统加密不可用、或写盘失败时抛出——调用方需要把失败告诉用户，
   *         不能假装保存成功。
   */
  save(key: string): void {
    if (!this.encryptionAvailable) {
      throw new Error('当前系统不支持安全存储，请改用环境变量 DEEPSEEK_API_KEY')
    }
    const trimmed = key.trim()
    if (!trimmed) throw new Error('Key 不能为空')

    const encrypted = safeStorage.encryptString(trimmed)
    const path = this.#filePath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, encrypted)
  }

  /** 删除已保存的 Key。文件本来就不存在时视为成功。 */
  clear(): void {
    rmSync(this.#filePath(), { force: true })
  }
}
