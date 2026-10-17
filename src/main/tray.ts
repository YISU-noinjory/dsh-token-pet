/**
 * 托盘图标。
 *
 * ## 为什么桌宠需要它
 *
 * 宠物窗口没有边框、没有任务栏入口、也可能被别的全屏窗口盖住。在这之前，
 * 一旦它从视野里消失，用户既不知道进程还在不在，也没有任何办法把它叫回来
 * 或明确退出——只能去任务管理器。托盘补上的就是这个缺口：
 * **一个始终可见的入口**。
 *
 * ## 菜单为什么要重建
 *
 * 第一项的文案（显示/隐藏）和两个勾选项都取决于当前状态，而 Windows 的托盘
 * 菜单是 `setContextMenu` 一次设定的静态对象。所以每次状态变化后重新构建一次，
 * 保证下次右键看到的是真实状态。重建用 `setImmediate` 推迟到当前事件派发之后，
 * 避免在菜单自己的 click 回调里改动正在派发的菜单对象。
 */

import { Menu, Tray, screen, type MenuItemConstructorOptions } from 'electron'
import type { PetSettings } from '../shared/types'
import type { PetWindow } from './pet-window'
import type { WindowPhysics } from './window-physics'
import { createTrayIcon } from './tray-icon'

/** 构造托盘所需的依赖。 */
export interface PetTrayDeps {
  readonly petWindow: PetWindow
  readonly physics: WindowPhysics
  /** 读当前设置。 */
  readonly getSettings: () => PetSettings
  /** 合并写设置（调用方负责让改动立即生效）。 */
  readonly patchSettings: (patch: Partial<PetSettings>) => PetSettings
  /** 立即刷新余额。 */
  readonly refreshBalance: () => void
  /** 退出应用。 */
  readonly quit: () => void
}

export class PetTray {
  readonly #deps: PetTrayDeps
  readonly #tray: Tray

  constructor(deps: PetTrayDeps) {
    this.#deps = deps
    this.#tray = new Tray(createTrayIcon())
    this.#tray.setToolTip('Token Pet — DeepSeek 余额桌宠')
    // 双击召回：宠物"不见了"时最直觉的动作。
    this.#tray.on('double-click', () => this.recall())
    this.rebuildMenu()
  }

  /**
   * 把宠物叫回**指针所在显示器**的中央。
   *
   * 选指针所在的显示器而不是主显示器：多屏时用户的眼睛在哪块屏上，
   * 就希望宠物出现在哪块屏上。单屏下等价于屏幕中央。
   *
   * 用 `moveTo` 而不是让物理引擎飞过去——用户按这个菜单项是要立刻看到宠物，
   * 不是看它表演一段飞行。
   */
  recall(): void {
    const { petWindow, physics } = this.#deps
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const { workArea } = display
    const { width, height } = petWindow.getBounds()
    const x = Math.round(workArea.x + (workArea.width - width) / 2)
    const y = Math.round(workArea.y + (workArea.height - height) / 2)

    // 先显示再移动：隐藏状态下 setPosition 在部分平台上不会反映到
    // 下次显示的首帧位置，先 show 更稳。
    petWindow.show()
    physics.moveTo(x, y)
    this.rebuildMenu()
  }

  /**
   * 按当前状态重建菜单。
   *
   * 公开是因为窗口可见性也可能被托盘之外的操作改变（例如以后可能加的
   * 全局快捷键）。任何状态变化后调一次即可。
   */
  rebuildMenu(): void {
    const { petWindow, getSettings, patchSettings, refreshBalance, quit } = this.#deps
    const settings = getSettings()
    const visible = petWindow.isVisible

    /** 状态改动后推迟到当前事件派发结束再重建，避免改动正在使用的菜单。 */
    const afterChange = (): void => {
      setImmediate(() => this.rebuildMenu())
    }

    const template: MenuItemConstructorOptions[] = [
      {
        label: visible ? '隐藏宠物' : '显示宠物',
        click: () => {
          if (petWindow.isVisible) petWindow.hide()
          else petWindow.show()
          afterChange()
        },
      },
      {
        label: '把宠物叫回来',
        click: () => this.recall(),
      },
      { type: 'separator' },
      {
        label: '立即刷新余额',
        click: () => refreshBalance(),
      },
      { type: 'separator' },
      {
        label: '始终置顶',
        type: 'checkbox',
        checked: settings.alwaysOnTop,
        click: (item) => {
          patchSettings({ alwaysOnTop: item.checked })
          afterChange()
        },
      },
      {
        label: '鼠标穿透',
        type: 'checkbox',
        checked: settings.clickThrough,
        click: (item) => {
          patchSettings({ clickThrough: item.checked })
          afterChange()
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => quit(),
      },
    ]

    this.#tray.setContextMenu(Menu.buildFromTemplate(template))
  }

  /**
   * 销毁托盘。
   *
   * 退出时必须调用：否则图标会残留在通知区域，直到用户把鼠标划过去才消失。
   */
  destroy(): void {
    this.#tray.destroy()
  }
}
