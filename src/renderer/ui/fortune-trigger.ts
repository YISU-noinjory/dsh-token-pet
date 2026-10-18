/**
 * 抽签的触发端：菜单（主进程）→ 这里判定今天抽过没有 → 真正去抽。
 *
 * ## 为什么"今天抽过没有"放在渲染进程
 *
 * 需求就是这么定的，而且也有道理：这是**界面状态**，跟着窗口走。主进程只负责
 * "有人点了抽签"，不关心用户昨天抽了什么。
 *
 * ## 存储用 localStorage，但要能坏
 *
 * localStorage 在少数环境下会抛异常（隐私模式、配额满、源被隔离）。这里所有
 * 读写都包了 try/catch：读失败当作"今天没抽过"（宁可多抽一次，也不让用户点了
 * 菜单毫无反应），写失败则只记一条警告——功能照常，只是明天可能还能再抽一次。
 */

import type { PetBridge } from '../../shared/ipc'
import type { Pet } from '../pet/pet'

/** localStorage 键名。带项目前缀，避免与同源的其他页面撞车。 */
const STORAGE_KEY = 'dsh-token-pet.fortune-date'

/** 今天已抽过时的提示。逐字按需求给定。 */
const ALREADY_DRAWN_MESSAGE = '今日已抽签，明天再来'

/** 抽中/关闭时让宠物弹一下的冲击参数。 */
const OPEN_IMPACT_SPEED = 780
const CLOSE_IMPACT_SPEED = 620

/** 构造参数。 */
export interface FortuneTriggerOptions {
  readonly bridge: PetBridge
  readonly pet: Pet
  /** 在宠物旁边弹一条提示（复用已有的气泡元素）。 */
  readonly notify: (message: string) => void
}

/**
 * 生成 `YYYY-MM-DD` 的本地日期键。
 *
 * 必须用**本地**日期而不是 `toISOString()`：后者是 UTC，在东八区会导致
 * 每天早上 8 点才"跨天"，用户会觉得明明过了零点却不能抽。
 *
 * @param date - 用于测试注入；默认当前时间。
 */
export function todayKey(date: Date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 读上次抽签日期；读不到返回 `undefined`。 */
function readLastDate(): string | undefined {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    return value ?? undefined
  } catch (cause) {
    console.warn('[dsh-token-pet] 读取抽签记录失败，按"今天没抽过"处理', cause)
    return undefined
  }
}

/** 写抽签日期。 */
function writeLastDate(value: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, value)
  } catch (cause) {
    // 不致命：功能正常，只是跨天限制可能失效。
    console.warn('[dsh-token-pet] 记录抽签日期失败', cause)
  }
}

/**
 * 安装抽签触发逻辑。
 *
 * @param options - 依赖。
 * @returns 取消订阅的函数。
 */
export function installFortuneTrigger(options: FortuneTriggerOptions): () => void {
  const { bridge, pet, notify } = options

  /** 防止连点菜单抽出两签（一次抽签要等 AI，窗口期不短）。 */
  let drawing = false

  const open = async (): Promise<void> => {
    if (drawing) return

    const today = todayKey()
    if (readLastDate() === today) {
      notify(ALREADY_DRAWN_MESSAGE)
      return
    }

    drawing = true
    // 开签先弹一下，让点击有即时反馈——AI 可能要等一两秒。
    pet.onImpact({ horizontal: 0, vertical: -1, speed: OPEN_IMPACT_SPEED })

    try {
      // 主进程负责选卦、调 AI、创建卡片窗口；这里只等结果。
      await bridge.fortune.draw()
      // 成功之后才记录日期：抽签本身失败时不该白白消耗今天的次数。
      writeLastDate(today)
    } catch (cause) {
      console.warn('[dsh-token-pet] 抽签失败', cause)
      notify('抽签失败，请稍后再试')
    } finally {
      drawing = false
    }
  }

  return bridge.on('fortune', (signal) => {
    if (signal.action === 'open') {
      void open()
      return
    }
    // 卡片关闭：再弹一下，给"收下吉言"一个收尾反馈。
    pet.onImpact({ horizontal: 0, vertical: -1, speed: CLOSE_IMPACT_SPEED })
  })
}
