/**
 * 赛博签筒卡片的渲染逻辑。
 *
 * 这个模块只在**卡片窗口**里运行：主进程创建窗口时给页面加上 `?mode=fortune`，
 * 入口据此走这条分支（见 `main.ts`）。
 *
 * ## 为什么拉取而不是接收
 *
 * 卡片的生命周期极短：每次抽签都新建一个窗口，关闭即销毁。如果主进程用事件
 * 把结果推过来，事件很可能早于渲染进程注册监听——那是个经典的时序坑。
 * 所以反过来：窗口加载完之后**主动 invoke** 一次读当前结果，天然没有竞态。
 */

import type { PetBridge } from '../../shared/ipc'
import type { FortuneReading } from '../../shared/types'

/** 按 id 取元素，缺失时立刻失败并指明是哪个。 */
function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`签筒页面找不到必需的元素 #${id}`)
  return element as T
}

/**
 * 启动卡片。
 *
 * @param bridge - 与主进程通信的桥。
 */
export function bootstrapFortuneCard(bridge: PetBridge): void {
  // 先切模式再查询元素：CSS 靠这个属性决定"隐藏宠物、显示卡片"。
  document.documentElement.dataset.mode = 'fortune'

  const numberEl = requireElement<HTMLSpanElement>('fortune-number')
  const nameEl = requireElement<HTMLSpanElement>('fortune-name')
  const judgmentEl = requireElement<HTMLParagraphElement>('fortune-judgment')
  const readingEl = requireElement<HTMLParagraphElement>('fortune-reading')
  const noticeEl = requireElement<HTMLParagraphElement>('fortune-notice')
  const closeButton = requireElement<HTMLButtonElement>('fortune-close')

  /** 把结果写进 DOM。 */
  const render = (reading: FortuneReading): void => {
    numberEl.textContent = `第 ${reading.hexagram.number} 卦`
    nameEl.textContent = reading.hexagram.name
    judgmentEl.textContent = reading.hexagram.judgment
    readingEl.textContent = reading.interpretation

    if (reading.notice) {
      noticeEl.textContent = reading.notice
      noticeEl.hidden = false
    } else {
      noticeEl.hidden = true
    }
  }

  /** 关闭卡片。 */
  const close = (): void => {
    void bridge.fortune.close()
  }

  closeButton.addEventListener('click', close)

  // Esc 也能收起——用户不一定想用鼠标去点那个按钮。
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close()
  })

  void (async () => {
    try {
      const reading = await bridge.fortune.current()
      if (reading) {
        render(reading)
      } else {
        // 正常流程不会到这里（窗口总是在抽签之后才创建），
        // 但显式兜住，免得留下一张写着"正在请示"的卡片。
        readingEl.textContent = '这一签没有送达，请再抽一次。'
      }
    } catch (cause) {
      console.warn('[dsh-token-pet] 读取签文失败', cause)
      readingEl.textContent = '读取签文失败，请再抽一次。'
    }
  })()
}
