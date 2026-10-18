/**
 * 自定义宠物图片的 UI。
 *
 * ## 这个模块不做什么
 *
 * 它不读文件、不复制、不校验、不持久化——那些全在主进程
 * （`src/main/pet-image.ts`）。这里只做两件事：
 *
 *  1. 把 {@link PetImageView} 翻译成 DOM（`<img src>` 与几个 data 属性）；
 *  2. 把按钮点击翻译成一次 IPC 调用。
 *
 * 分工的理由：文件校验需要 fs，持久化需要 `app.getPath('userData')`，
 * 两者渲染进程都没有。硬要塞进来就只能靠把路径和字节搬过 IPC，
 * 那既慢又多一处信任边界。
 *
 * ## 工具栏为什么由指针事件控制显隐
 *
 * 宠物窗口只有 220×220 且完全透明，常驻一个按钮会一直挂在桌面上很难看。
 * 但"悬停显示"在这里有个陷阱：指针从宠物移向按钮时**会离开宠物本体**，
 * 如果只用 `.pet-body:hover` 控制，工具栏会在指针到达按钮之前就消失，
 * 按钮永远点不到。
 *
 * 所以显隐由 `main.ts` 的指针处理统一驱动：指针在宠物上**或已经在工具栏上**
 * 就保持可见。同时工具栏隐藏时 `pointer-events: none`，
 * 于是 `document.elementFromPoint` 天然不会命中它——
 * "看不见的工具栏不挡点击"这件事不需要额外判断。
 */

import type { PetBridge } from '../../shared/ipc'
import type { MattingOutcomeKind, PetImageView } from '../../shared/types'

/** 提示气泡的显示时长（ms）。 */
const TOAST_DURATION_MS = 4200

/**
 * 抠图结果的提示文案。
 *
 * 成功也要说一声：用户刚选完图，需要知道"背景已经被去掉了、而且能撤销"，
 * 否则会以为图片被裁坏了。失败则必须解释原因，不然功能看起来就是坏的。
 * 空字符串表示不需要提示。
 */
const MATTING_NOTICES: Record<MattingOutcomeKind, string> = {
  applied: '已自动去掉背景 · 右键菜单可切换回原图',
  'no-background': '没找到可去除的背景，已保留原样',
  'gave-up': '背景与主体太接近，为避免误删已保留原图',
  unsupported: '这个格式不支持抠图，已保留原样',
}

/** 构造选项。 */
export interface PetImagePickerOptions {
  readonly bridge: PetBridge
  /** 宠物舞台，承载 `data-has-photo` / `data-clip` 两个开关。 */
  readonly stage: HTMLElement
  /** 展示自定义图片的 `<img>`。 */
  readonly image: HTMLImageElement
  /** 工具栏容器，显隐由 {@link PetImagePicker.setToolbarVisible} 控制。 */
  readonly toolbar: HTMLElement
  /** "换图"按钮。 */
  readonly pickButton: HTMLButtonElement
  /** "恢复默认"按钮。 */
  readonly resetButton: HTMLButtonElement
  /** 出错时显示的气泡。 */
  readonly toast: HTMLElement
}

export class PetImagePicker {
  readonly #options: PetImagePickerOptions
  #toastTimer: number | undefined

  constructor(options: PetImagePickerOptions) {
    this.#options = options
  }

  /**
   * 绑定按钮并拉取一次当前状态。
   *
   * @returns 首次状态应用完成后兑现。
   */
  async start(): Promise<void> {
    this.#options.pickButton.addEventListener('click', this.#onPick)
    this.#options.resetButton.addEventListener('click', this.#onReset)

    try {
      // 主进程在创建窗口**之前**就把磁盘状态读回来了，
      // 所以这里的 get() 是同步语义的快照，不会出现"先默认后图片"的闪烁。
      this.apply(await this.#options.bridge.petImage.get())
    } catch (cause) {
      console.warn('[dsh-token-pet] 读取宠物图片状态失败', cause)
    }
  }

  /** 解绑并清理定时器。 */
  dispose(): void {
    this.#options.pickButton.removeEventListener('click', this.#onPick)
    this.#options.resetButton.removeEventListener('click', this.#onReset)
    if (this.#toastTimer !== undefined) {
      window.clearTimeout(this.#toastTimer)
      this.#toastTimer = undefined
    }
  }

  /**
   * 应用一份状态。
   *
   * 幂等：主进程的 IPC 返回值与 `pet-image:changed` 事件都会调到这里，
   * 重复应用必须没有副作用。
   *
   * @param view - 主进程给出的状态快照。
   */
  apply(view: PetImageView): void {
    const { stage, image, resetButton } = this.#options

    // 用 data 属性而不是直接改 style：切图/切裁剪方式都只是换一个选择器匹配，
    // 具体长什么样完全留在样式表里。
    stage.dataset.hasPhoto = view.hasImage ? 'true' : 'false'
    stage.dataset.clip = view.clip

    if (view.url) {
      // 只在 URL 变化时赋值。重复赋同一个 src 会让 Chromium
      // 取消并重发请求，动图会因此从头开始播。
      if (image.getAttribute('src') !== view.url) image.src = view.url
      image.alt = view.fileName ?? '自定义宠物图片'
    } else {
      image.removeAttribute('src')
      image.alt = ''
    }

    resetButton.disabled = !view.hasImage
  }

  /**
   * 控制工具栏显隐。
   *
   * @param visible - 是否显示。隐藏时同时摘掉 `pointer-events`，
   *   让命中测试不再考虑它。
   */
  setToolbarVisible(visible: boolean): void {
    this.#options.toolbar.classList.toggle('is-visible', visible)
  }

  /** "换图"按钮。 */
  #onPick = async (): Promise<void> => {
    try {
      const result = await this.#options.bridge.petImage.select()
      if (result.status === 'selected') {
        this.apply(result.view)
        // 抠图结果必须反馈：用户选了"自动抠图"，如果没抠就得说清为什么，
        // 否则他会以为功能坏了。
        const notice = MATTING_NOTICES[result.matting]
        if (notice) this.#showToast(notice)
      } else if (result.status === 'rejected') {
        // 被拒绝是"用户选了但文件不可用"，必须告诉他为什么；
        // 而 cancelled 是正常操作，不提示任何东西。
        this.#showToast(result.message)
      }
    } catch (cause) {
      console.warn('[dsh-token-pet] 选择图片失败', cause)
      this.#showToast('打开文件选择框失败，请重试。')
    }
  }

  /** "恢复默认"按钮。 */
  #onReset = async (): Promise<void> => {
    try {
      this.apply(await this.#options.bridge.petImage.clear())
    } catch (cause) {
      console.warn('[dsh-token-pet] 恢复默认宠物失败', cause)
      this.#showToast('恢复默认宠物失败。')
    }
  }

  /**
   * 用宠物旁边的气泡提示一条消息。
   *
   * 这个方法存在只是因为**这个类持有那个气泡元素**。抽签之类的其他功能也
   * 需要给用户一句短提示，与其各写一份定时器与样式操作，不如共用一处。
   *
   * @param message - 提示文案。
   */
  notify(message: string): void {
    this.#showToast(message)
  }

  /**
   * 显示一条提示气泡。
   *
   * @param message - 面向用户的文案。
   */
  #showToast(message: string): void {
    const toast = this.#options.toast
    toast.textContent = message
    toast.classList.add('is-visible')

    if (this.#toastTimer !== undefined) window.clearTimeout(this.#toastTimer)
    this.#toastTimer = window.setTimeout(() => {
      toast.classList.remove('is-visible')
      this.#toastTimer = undefined
    }, TOAST_DURATION_MS)
  }
}
