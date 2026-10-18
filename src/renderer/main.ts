/**
 * 渲染进程入口：装配宠物与余额徽章，并把主进程的事件接到它们身上。
 *
 * 这里刻意保持"薄"——没有状态管理库，也没有定时器去拉数据。
 * 数据流是单向的：主进程推 → 这里分发 → 宠物/徽章各自重绘。
 * 渲染进程从不主动猜数据，因此永远不会出现"界面显示的和真实余额不一致"。
 */

import { DEFAULT_SETTINGS, deriveMood, selectSnapshot } from '../shared/config'
import type { PetBridge } from '../shared/ipc'
import type { PetSettings } from '../shared/types'
import { Pet } from './pet/pet'
import { BalanceBadge } from './ui/balance-badge'
import { bootstrapFortuneCard } from './ui/fortune-card'
import { installFortuneTrigger } from './ui/fortune-trigger'
import { PetImagePicker } from './ui/pet-image-picker'
import { PetResizer } from './ui/pet-resizer'

/**
 * 按 id 取元素，缺失时抛错。
 *
 * 不用 `!` 断言：如果 HTML 与 TS 的 id 对不上，用断言的结果是
 * 运行时在某个遥远的地方 `Cannot read property of null`；
 * 在这里立刻失败，报错信息直接指向缺失的元素。
 */
function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`渲染进程中找不到必需的元素 #${id}`)
  return element as T
}

/** 启动渲染进程。 */
function bootstrap(): void {
  const bridge: PetBridge = window.petBridge

  /*
   * 同一个页面，两种形态。
   *
   * 主进程创建签筒窗口时给页面加 `?mode=fortune`，这里据此分流。这样做省掉了
   * 一个独立的 Vite 入口：preload、CSP、构建配置全部复用。
   *
   * 必须**在查询任何宠物元素之前**分流，否则卡片窗口会因为找不到 `.pet-body`
   * 而抛错。
   */
  if (new URLSearchParams(window.location.search).get('mode') === 'fortune') {
    bootstrapFortuneCard(bridge)
    return
  }

  const stage = requireElement<HTMLDivElement>('stage')
  const petBody = requireElement<HTMLDivElement>('pet')
  const badge = new BalanceBadge({
    root: requireElement<HTMLDivElement>('badge'),
    amount: requireElement<HTMLSpanElement>('badge-amount'),
    status: requireElement<HTMLSpanElement>('badge-status'),
  })

  const pet = new Pet({ stage, body: petBody, bridge })
  pet.start()

  /* --- 滚轮缩放 --- */

  const resizer = new PetResizer({ bridge, stage, body: petBody })
  resizer.start()

  /* --- 自定义宠物图片 --- */

  const toolbar = requireElement<HTMLDivElement>('pet-toolbar')
  const imagePicker = new PetImagePicker({
    bridge,
    stage,
    image: requireElement<HTMLImageElement>('pet-photo'),
    toolbar,
    pickButton: requireElement<HTMLButtonElement>('pet-image-pick'),
    resetButton: requireElement<HTMLButtonElement>('pet-image-reset'),
    toast: requireElement<HTMLDivElement>('pet-toast'),
  })
  void imagePicker.start()

  /* --- 每日赛博抽签 --- */

  // 菜单在主进程，判定在今天抽没抽过在这里，真正的抽签再回主进程。
  const disposeFortuneTrigger = installFortuneTrigger({
    bridge,
    pet,
    // 复用选图那套气泡：它已经处理好了定时器与显隐。
    notify: (message) => imagePicker.notify(message),
  })

  /**
   * 当前设置。
   *
   * 情绪阈值来自设置，需要保持最新：用户在配置里调了告急线，
   * 下次余额推送就该用新阈值判断，而不是等重启。
   */
  let settings: PetSettings = DEFAULT_SETTINGS

  const unsubscribers = [
    bridge.on('balance', (state) => {
      badge.update(state)
      pet.setMood(deriveMood(selectSnapshot(state), settings))
    }),
    bridge.on('motion', (frame) => pet.onMotion(frame)),
    bridge.on('motionState', (state) => pet.onMotionState(state)),
    bridge.on('impact', (payload) => pet.onImpact(payload)),
    // 换图有两条入口（这里的按钮、主进程的原生右键菜单），
    // 菜单触发的那次只能通过这个事件到达渲染进程。
    bridge.on('petImage', (view) => imagePicker.apply(view)),
  ]

  const disposeHitTest = installHitTest(bridge, pet, toolbar)

  // 首屏：主动拉一次，不必等下一次推送。
  void (async () => {
    try {
      settings = await bridge.settings.get()
    } catch (cause) {
      console.warn('[dsh-token-pet] 读取设置失败，使用默认值', cause)
    }
    try {
      const state = await bridge.balance.get()
      badge.update(state)
      pet.setMood(deriveMood(selectSnapshot(state), settings))
    } catch (cause) {
      console.warn('[dsh-token-pet] 读取初始余额失败', cause)
    }
  })()

  window.addEventListener('beforeunload', () => {
    disposeHitTest()
    for (const unsubscribe of unsubscribers) unsubscribe()
    disposeFortuneTrigger()
    pet.dispose()
    badge.dispose()
    imagePicker.dispose()
    resizer.dispose()
  })

  /**
   * 设置窗口的初始命中状态。
   *
   * 启动瞬间指针多半不在宠物上，先声明为不可交互，
   * 避免宠物刚出现就挡住用户正在点的东西。
   */
  void bridge.overlay.setInteractive(false)
}

/**
 * 安装命中测试。
 *
 * ## 要解决的问题
 *
 * 窗口是个 220×220 的矩形，但宠物本体只占中间一块。
 * 如果不做处理，宠物周围那一圈完全透明的像素照样会吃掉鼠标事件，
 * 用户点桌面图标时会莫名其妙地点到"空气"。
 *
 * ## 做法
 *
 * 监听 `pointermove`，用 `elementFromPoint` 判断指针是否真的压在
 * 宠物本体或工具栏按钮上，变化时通知主进程切换 `setIgnoreMouseEvents`。
 *
 * 之所以在穿透状态下仍然收得到 `pointermove`，是因为主进程用了
 * `setIgnoreMouseEvents(true, { forward: true })`——那个 `forward`
 * 正是为这个闭环准备的；没有它，指针一旦离开宠物，窗口就再也
 * 收不到事件，会永久卡在穿透状态。
 *
 * ## 工具栏显隐为什么也在这里
 *
 * 指针从宠物移向按钮时会**离开宠物本体**。如果显隐只由 `.pet-body:hover`
 * 决定，工具栏会在指针到达按钮之前就消失，按钮永远点不到。
 * 所以判定条件是"指针在宠物上**或已经在工具栏上**"。
 *
 * 这个条件之所以能收敛，靠的是 `elementFromPoint` 会跳过
 * `pointer-events: none` 的元素：工具栏隐藏时不可命中，指针移到它上方
 * 只会命中舞台（于是保持隐藏）；一旦因悬停宠物而显示，它就变成可命中，
 * 指针移过去后条件成立，工具栏不消失。
 *
 * @param bridge - 与主进程通信的桥。
 * @param pet - 宠物实例，用于查询"是否正被抓着"。
 * @param toolbar - 悬停工具栏。
 * @returns 取消函数。
 */
function installHitTest(bridge: PetBridge, pet: Pet, toolbar: HTMLElement): () => void {
  /** `undefined` 表示尚未上报过，首次一定会上报。 */
  let interactive: boolean | undefined

  const onPointerMove = (event: PointerEvent): void => {
    const hit = document.elementFromPoint(event.clientX, event.clientY)
    const body = pet.bodyElement
    const overPet = hit !== null && (hit === body || body.contains(hit))
    const overToolbar = hit !== null && toolbar.contains(hit)

    // 工具栏可见性完全由这里决定，CSS 不参与判断。
    toolbar.classList.toggle('is-visible', overPet || overToolbar)

    // 被抓住时无条件保持可交互（见 Pet.isEngaged 的说明）。
    const next = pet.isEngaged || overPet || overToolbar
    if (next === interactive) return
    interactive = next
    void bridge.overlay.setInteractive(next)
  }

  window.addEventListener('pointermove', onPointerMove)
  return () => window.removeEventListener('pointermove', onPointerMove)
}

bootstrap()
