/**
 * 「设置 API Key」表单的渲染逻辑。
 *
 * 只在 `?mode=key` 的浮层窗口里运行（见 `main.ts`）。
 *
 * ## 为什么保存结果用对象而不是异常
 *
 * 失败原因（系统不支持安全存储、写盘失败）必须原样展示给用户。跨进程抛出的
 * 异常会被包成 `Error invoking remote method 'credential:set': ...`，
 * 那种文本给用户看毫无意义，所以主进程返回 `{ ok, error }`。
 */

import type { PetBridge } from '../../shared/ipc'
import type { CredentialStatus } from '../../shared/types'

/** 按 id 取元素，缺失时立刻失败并指明是哪个。 */
function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`设置页面找不到必需的元素 #${id}`)
  return element as T
}

/**
 * 启动表单。
 *
 * @param bridge - 与主进程通信的桥。
 */
export function bootstrapKeyForm(bridge: PetBridge): void {
  document.documentElement.dataset.mode = 'key'

  const input = requireElement<HTMLInputElement>('key-input')
  const saveButton = requireElement<HTMLButtonElement>('key-save')
  const clearButton = requireElement<HTMLButtonElement>('key-clear')
  const closeButton = requireElement<HTMLButtonElement>('key-close')
  const statusEl = requireElement<HTMLParagraphElement>('key-status')

  /**
   * 关闭本窗口。
   *
   * 用 `window.close()` 而不是再开一条 IPC：这是 Electron 的渲染进程窗口，
   * 关自己不需要主进程配合，省一个频道也省一处状态。
   */
  const close = (): void => {
    window.close()
  }

  /** 按状态刷新界面。 */
  const render = (status: CredentialStatus): void => {
    if (!status.encryptionAvailable) {
      // 关键：**不降级成明文**，宁可禁掉保存并引导用户改用环境变量。
      statusEl.textContent = '⚠ 当前系统不支持安全存储，无法保存。请改用环境变量 DEEPSEEK_API_KEY。'
      statusEl.dataset.tone = 'error'
      saveButton.disabled = true
      clearButton.disabled = true
      return
    }
    saveButton.disabled = false
    clearButton.disabled = !status.hasKey
    statusEl.textContent = status.hasKey ? '✅ 已保存 Key（加密存储）' : '尚未设置 Key'
    statusEl.dataset.tone = status.hasKey ? 'ok' : 'muted'
  }

  const save = async (): Promise<void> => {
    const value = input.value.trim()
    if (!value) {
      statusEl.textContent = '请先粘贴 Key'
      statusEl.dataset.tone = 'error'
      input.focus()
      return
    }

    saveButton.disabled = true
    statusEl.textContent = '保存中…'
    statusEl.dataset.tone = 'muted'

    try {
      const result = await bridge.credential.set(value)
      if (!result.ok) {
        statusEl.textContent = `❌ ${result.error ?? '保存失败'}`
        statusEl.dataset.tone = 'error'
        saveButton.disabled = false
        return
      }
      input.value = ''
      render(result.status)
      statusEl.textContent = '✅ 已保存，立即生效'
      // 留一点时间让用户看到"已保存"，再自动收起。
      setTimeout(close, 700)
    } catch (cause) {
      console.warn('[dsh-token-pet] 保存 Key 失败', cause)
      statusEl.textContent = '❌ 保存失败，请重试'
      statusEl.dataset.tone = 'error'
      saveButton.disabled = false
    }
  }

  const clear = async (): Promise<void> => {
    try {
      render(await bridge.credential.clear())
      statusEl.textContent = '已清除 Key'
      statusEl.dataset.tone = 'muted'
    } catch (cause) {
      console.warn('[dsh-token-pet] 清除 Key 失败', cause)
      statusEl.textContent = '❌ 清除失败'
      statusEl.dataset.tone = 'error'
    }
  }

  saveButton.addEventListener('click', () => void save())
  clearButton.addEventListener('click', () => void clear())
  closeButton.addEventListener('click', close)

  // 回车即保存；Esc 即关闭。表单只有一件事，围绕它优化。
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void save()
  })
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close()
  })

  void (async () => {
    try {
      render(await bridge.credential.status())
    } catch (cause) {
      console.warn('[dsh-token-pet] 读取 Key 状态失败', cause)
      statusEl.textContent = '读取状态失败'
      statusEl.dataset.tone = 'error'
    }
    input.focus()
  })()
}
