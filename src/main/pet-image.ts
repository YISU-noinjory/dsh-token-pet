/**
 * 自定义宠物图片的存储与投递。
 *
 * ## 为什么渲染进程拿不到文件路径
 *
 * 直觉做法是把绝对路径交给渲染进程，再拼成 `<img src="file:///C:/...">`。
 * 这条路在本项目里走不通，原因有两个，各自都足以否决它：
 *
 * 1. **`file://` 页面引用 `file://` 子资源不可靠。** 生产环境用
 *    `loadFile` 加载 `dist/renderer/index.html`，页面本身就是 `file://` 源，
 *    再去引另一个 `file://` 资源，行为随平台与 Electron 版本漂移。
 *    要让它稳定就得关掉 `webSecurity`，那是拿整个应用的安全性换一个 `src`。
 *
 * 2. **绝对路径本身是多余的信息面。** 渲染进程只需要一个能塞进 `src` 的 URL；
 *    一旦路径进了 DOM，它就会出现在 devtools、截图、以及任何渲染进程被注入后的
 *    读取面上。而"当前用哪个文件"这个决定，本来就只有主进程需要知道。
 *
 * 因此这里注册一个自定义协议 `pet-image:`，URL 恒为 `pet-image://current?v=N`：
 * `v` 只是换图后的缓存破坏标记，**不参与文件选择**。协议处理函数永远只投递
 * 「当前图片」，请求里的任何部分都不被信任。于是路径穿越在这个设计里
 * 根本没有攻击面——不是被过滤掉了，而是不存在。
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { app, dialog, nativeImage, type BrowserWindow, type OpenDialogOptions } from 'electron'
import { PET_IMAGE_LIMITS, formatBytes } from '../shared/config'
import type {
  MattingOutcomeKind,
  PetImageClip,
  PetImageRejectReason,
  PetImageSelectResult,
  PetImageView,
} from '../shared/types'
// 格式识别与路径解析是安全边界上的纯逻辑，刻意放在不依赖 Electron 的
// 模块里，以便脱离 Electron 单独测试。
import { HEADER_BYTES, resolveManagedImagePath, sniffImageType } from './pet-image-files'
import type { ImageSignature } from './pet-image-files'
// 抠图算法同样是不依赖 Electron 的纯逻辑，输入输出都是裸 BGRA 像素。
import { removeBackground } from './pet-matting'

// 重新导出，让调用方只需要认识 pet-image 这一个入口。
export { resolveManagedImagePath, sniffImageType } from './pet-image-files'
export type { ImageSignature } from './pet-image-files'

/** 自定义协议名。 */
export const PET_IMAGE_SCHEME = 'pet-image'

/**
 * 协议特权声明。
 *
 * 必须在 `app.whenReady()` **之前**交给 `protocol.registerSchemesAsPrivileged`。
 * - `standard`：让它按标准 URL 语法解析（`pet-image://host/path`），
 *   否则 Chromium 会当成不透明源，`<img>` 加载行为不一致。
 * - `secure`：标记为安全上下文，避免被当成混合内容拦下。
 *
 * 刻意**不开** `bypassCSP`：我们更愿意在 index.html 的 CSP 里显式写上
 * `img-src pet-image:`，让"允许这个协议"这件事留在策略文件里可见，
 * 而不是靠一个隐式绕过。
 */
export const PET_IMAGE_SCHEME_PRIVILEGES = [
  {
    scheme: PET_IMAGE_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
] as const

/** 落盘的持久化结构。 */
interface PersistedState {
  /** 原图文件名。**永远保留**，它是"撤销抠图"的依据。 */
  readonly fileName: string | null
  /** 原图的 MIME。 */
  readonly mime: string | null
  readonly clip: PetImageClip
  /** 抠图产物的文件名（PNG）；没有则为 null。 */
  readonly cutoutFileName: string | null
  /** 当前显示的是抠图还是原图。 */
  readonly showCutout: boolean
}

/** 空状态。 */
const EMPTY_STATE: PersistedState = {
  fileName: null,
  mime: null,
  clip: 'none',
  cutoutFileName: null,
  showCutout: false,
}

/**
 * 宠物图片的存储。
 *
 * 目录布局（都在 `app.getPath('userData')` 下）：
 *
 * ```
 * userData/
 * ├─ pet-image.json          # 状态：当前文件名、MIME、裁剪方式
 * └─ pet-images/
 *    └─ pet-<时间戳>-<随机>.<ext>   # 每次导入的副本
 * ```
 *
 * 每次导入都落一个**新文件名**而不是覆盖同一个文件：这样正在被 `<img>`
 * 持有的旧文件不会被写坏（Windows 上正在被读取的文件无法覆盖），
 * 也天然拿到了缓存破坏所需的版本号。旧文件在复制成功之后删除。
 */
export class PetImageStore {
  readonly #directory: string
  readonly #storePath: string
  #state: PersistedState = EMPTY_STATE
  /** 每次换图自增，只用于让 `<img src>` 变化，从而触发重新加载。 */
  #version = 0

  constructor() {
    const userData = app.getPath('userData')
    this.#directory = join(userData, 'pet-images')
    this.#storePath = join(userData, 'pet-image.json')
  }

  /** 受管目录的绝对路径，供诊断与测试使用。 */
  get directory(): string {
    return this.#directory
  }

  /**
   * 从磁盘读回状态。
   *
   * 启动时调用一次。状态文件损坏、或图片文件已被用户手工删除时，
   * 都退回"没有自定义图片"，而不是让宠物显示一个破图。
   *
   * @returns 恢复后的视图。
   */
  async load(): Promise<PetImageView> {
    this.#state = await this.#readPersisted()
    if (this.#state.fileName) {
      const path = this.#resolveCurrentPath()
      // 路径非法或文件已消失：清掉，回到内置宠物。
      if (!path || !existsSync(path)) this.#state = { ...this.#state, fileName: null, mime: null }
    }
    return this.getView()
  }

  /** 当前状态视图。 */
  getView(): PetImageView {
    const hasImage = this.#state.fileName !== null
    return {
      hasImage,
      // 版本号进查询串：换图后 URL 变化，绕过 Chromium 的图片缓存。
      url: hasImage ? `${PET_IMAGE_SCHEME}://current/?v=${this.#version}` : null,
      fileName: this.#state.fileName,
      clip: this.#state.clip,
      hasCutout: this.#cutoutPath() !== undefined,
      showingCutout: this.#isShowingCutout(),
    }
  }

  /**
   * 弹出系统文件选择框，并把选中的图片复制进受管目录。
   *
   * @param parent - 父窗口；提供时对话框会以模态方式挂靠在宠物窗口上。
   * @returns 三态结果。用户取消是正常路径，不是错误。
   */
  async select(parent?: BrowserWindow): Promise<PetImageSelectResult> {
    const options: OpenDialogOptions = {
      title: '选择宠物图片',
      buttonLabel: '用作宠物',
      properties: ['openFile'],
      filters: [
        { name: '图片', extensions: [...PET_IMAGE_LIMITS.extensions] },
        { name: '所有文件', extensions: ['*'] },
      ],
    }

    // 传父窗口 → 对话框成为该窗口的模态子窗，不会跑到窗口后面去。
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)

    const source = result.filePaths[0]
    if (result.canceled || !source) return { status: 'cancelled' }

    return this.importFromPath(source)
  }

  /** 清除自定义图片，回到内置的 CSS 宠物。 */
  async clear(): Promise<PetImageView> {
    const previous = this.#ownedPaths()
    this.#state = { ...this.#state, fileName: null, mime: null, cutoutFileName: null, showCutout: false }
    this.#version += 1
    await this.#persist()
    // 删文件是"尽力而为"：删除失败不该让清除操作失败。
    for (const path of previous) await rm(path, { force: true }).catch(() => undefined)
    return this.getView()
  }

  /**
   * 切换裁剪方式。
   *
   * @param clip - 新的裁剪方式。
   * @returns 更新后的视图。
   */
  async setClip(clip: PetImageClip): Promise<PetImageView> {
    if (this.#state.clip !== clip) {
      this.#state = { ...this.#state, clip }
      await this.#persist()
    }
    return this.getView()
  }

  /**
   * 在「抠图」与「原图」之间切换。
   *
   * 原图永远保留，所以这是无损的：抠坏了随时切回去。
   *
   * @param show - `true` 显示抠图版本；`false` 显示原图。
   * @returns 更新后的视图。
   */
  async setShowCutout(show: boolean): Promise<PetImageView> {
    // 没有抠图产物时不能切到"显示抠图"，否则会返回一个必定 404 的 URL。
    const next = show && this.#cutoutPath() !== undefined
    if (next !== this.#state.showCutout) {
      this.#state = { ...this.#state, showCutout: next }
      // 版本号必须递增：URL 变了，`<img>` 才会真的重新加载另一个文件。
      this.#version += 1
      await this.#persist()
    }
    return this.getView()
  }

  /**
   * 解析当前图片的真实路径。
   *
   * @returns 绝对路径；无图或路径非法时返回 `undefined`。
   */
  resolveCurrentPath(): string | undefined {
    return this.#resolveCurrentPath()
  }

  /** 当前图片的 MIME；无图时为 `undefined`。 */
  get currentMime(): string | undefined {
    // 抠图产物恒定是 PNG，原图的 MIME 不能拿来用。
    if (this.#isShowingCutout()) return 'image/png'
    return this.#state.mime ?? undefined
  }

  /* ---------------------------------------------------------------- *
   * 导入
   * ---------------------------------------------------------------- */

  /**
   * 从一个已知路径导入图片。
   *
   * 从 {@link select} 里拆出来是为了让"校验 → 复制 → 抠图 → 提交"这条链
   * 可以脱离文件选择框被测试（选择框是模态的，自动化测试点不到）。
   * 以后要做拖放导入，也是接到这个入口上。
   *
   * @param source - 源文件绝对路径。
   * @returns 三态结果。
   */
  async importFromPath(source: string): Promise<PetImageSelectResult> {
    // --- 体积与类型校验 ---
    let size: number
    try {
      const stats = await stat(source)
      if (!stats.isFile()) {
        return reject('unreadable', '选中的不是一个文件。')
      }
      size = stats.size
    } catch {
      return reject('unreadable', '读取不到这个文件，可能已被移动或没有权限。')
    }

    if (size > PET_IMAGE_LIMITS.maxBytes) {
      return reject(
        'too-large',
        `图片有 ${(size / (1024 * 1024)).toFixed(1)}MB，超过 ${formatBytes(PET_IMAGE_LIMITS.maxBytes)} 上限。` +
          `建议压到 ${PET_IMAGE_LIMITS.recommendedSize}×${PET_IMAGE_LIMITS.recommendedSize} 以内。`,
      )
    }

    let signature: ImageSignature | undefined
    try {
      const handle = await open(source, 'r')
      try {
        const header = new Uint8Array(HEADER_BYTES)
        const { bytesRead } = await handle.read(header, 0, HEADER_BYTES, 0)
        signature = sniffImageType(header.subarray(0, bytesRead))
      } finally {
        await handle.close()
      }
    } catch {
      return reject('unreadable', '读取文件头失败，文件可能已损坏。')
    }

    if (!signature) {
      return reject(
        'unsupported-format',
        `只支持 ${PET_IMAGE_LIMITS.extensions.join(' / ')}，这个文件的格式识别不出来。` +
          '（判定依据是文件内容而非扩展名）',
      )
    }

    // --- 复制 ---
    const fileName = `pet-${Date.now()}-${randomUUID().slice(0, 8)}.${signature.extension}`
    const target = join(this.#directory, fileName)
    try {
      await mkdir(this.#directory, { recursive: true })
      await copyFile(source, target)
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      return reject('copy-failed', `复制图片失败：${detail}`)
    }

    // --- 抠图 ---
    // 在提交状态之前做：抠图失败时状态照常提交，只是没有抠图产物。
    // 原图永远保留，所以这一步是可逆的。
    const { fileName: cutoutFileName, outcome } = await this.#createCutout(target, signature)

    // --- 提交状态 ---
    // 先复制后删除：万一源文件就是上一次导入的那张，也不会先删掉再读。
    const previous = this.#ownedPaths()
    this.#state = {
      fileName,
      mime: signature.mime,
      clip: this.#state.clip,
      cutoutFileName,
      // 有抠图产物就默认用它——用户选了"导入时自动抠图"。
      showCutout: cutoutFileName !== null,
    }
    this.#version += 1
    await this.#persist()

    for (const path of previous) {
      if (path === target) continue
      await rm(path, { force: true }).catch(() => undefined)
    }

    return { status: 'selected', view: this.getView(), matting: outcome }
  }

  /**
   * 解析并校验当前文件路径。
   *
   * 真正的守卫在 {@link resolveManagedImagePath}——它被单独放在一个
   * 不依赖 Electron 的模块里，因此安全判断可以脱离 Electron 被测试。
   */
  #resolveCurrentPath(): string | undefined {
    if (this.#state.showCutout) {
      const cutout = this.#cutoutPath()
      // 抠图文件被手工删掉时回落到原图，而不是显示一个破图。
      if (cutout) return cutout
    }
    return resolveManagedImagePath(this.#directory, this.#state.fileName)
  }

  /** 抠图产物的绝对路径；没有、或文件已不存在时返回 `undefined`。 */
  #cutoutPath(): string | undefined {
    if (!this.#state.cutoutFileName) return undefined
    const path = resolveManagedImagePath(this.#directory, this.#state.cutoutFileName)
    if (!path || !existsSync(path)) return undefined
    return path
  }

  /** 当前是否真的在显示抠图版本。 */
  #isShowingCutout(): boolean {
    return this.#state.showCutout && this.#cutoutPath() !== undefined
  }

  /** 当前持有的全部文件路径（换图或清除时要一起删掉）。 */
  #ownedPaths(): string[] {
    const paths: string[] = []
    const original = resolveManagedImagePath(this.#directory, this.#state.fileName)
    if (original) paths.push(original)
    const cutout = resolveManagedImagePath(this.#directory, this.#state.cutoutFileName)
    if (cutout) paths.push(cutout)
    return paths
  }

  /**
   * 生成抠图产物。
   *
   * 失败不是错误路径：抠不出来就当作"没有抠图"，原图照常生效。
   * 唯一不可接受的是把图弄坏，所以算法内部有两道安全阀（见 pet-matting.ts）。
   *
   * @param sourcePath - 已复制进受管目录的原图。
   * @param signature - 文件头识别结果。
   * @returns 抠图文件名（失败为 null）与结果分类。
   */
  async #createCutout(
    sourcePath: string,
    signature: ImageSignature,
  ): Promise<{ fileName: string | null; outcome: MattingOutcomeKind }> {
    // GIF 抠图只能取到第一帧，会把动图变成静态图——宁可不动。
    if (signature.extension === 'gif') return { fileName: null, outcome: 'unsupported' }

    try {
      const image = nativeImage.createFromPath(sourcePath)
      if (image.isEmpty()) return { fileName: null, outcome: 'unsupported' }

      const { width, height } = image.getSize()
      const bitmap = image.toBitmap()
      if (bitmap.length < width * height * 4) return { fileName: null, outcome: 'unsupported' }

      const started = Date.now()
      const { bitmap: result, stats } = removeBackground({
        data: new Uint8Array(bitmap.buffer, bitmap.byteOffset, width * height * 4),
        width,
        height,
      })
      const elapsed = Date.now() - started

      if (stats.failure) {
        const outcome: MattingOutcomeKind =
          stats.failure === 'ate-the-subject' ? 'gave-up' : 'no-background'
        console.log(
          `[dsh-token-pet] 抠图跳过（${stats.failure}）：` +
            `清除比例 ${(stats.removedRatio * 100).toFixed(1)}%，用时 ${elapsed}ms`,
        )
        return { fileName: null, outcome }
      }

      const encoded = nativeImage
        .createFromBitmap(
          Buffer.from(result.data.buffer, result.data.byteOffset, width * height * 4),
          { width, height },
        )
        .toPNG()

      const fileName = `cutout-${Date.now()}-${randomUUID().slice(0, 8)}.png`
      await writeFile(join(this.#directory, fileName), encoded)

      console.log(
        `[dsh-token-pet] 抠图完成：清除 ${(stats.removedRatio * 100).toFixed(1)}% 背景，` +
          `保留 ${stats.keptComponents} 块主体，${width}×${height}，用时 ${elapsed}ms`,
      )
      return { fileName, outcome: 'applied' }
    } catch (cause) {
      // 解码失败、编码失败、磁盘写入失败都走这里：退回原图即可。
      console.warn(`[dsh-token-pet] 抠图失败，保留原图：${String(cause)}`)
      return { fileName: null, outcome: 'unsupported' }
    }
  }

  /** 读取落盘状态，任何异常都退回空状态。 */
  async #readPersisted(): Promise<PersistedState> {
    try {
      const raw = await readFile(this.#storePath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null) return EMPTY_STATE
      const record = parsed as Record<string, unknown>
      return {
        fileName: typeof record.fileName === 'string' ? record.fileName : null,
        mime: typeof record.mime === 'string' ? record.mime : null,
        // 只认这两个字面量，其余一律回落，避免脏数据流进 CSS 属性。
        clip: record.clip === 'circle' ? 'circle' : 'none',
        cutoutFileName: typeof record.cutoutFileName === 'string' ? record.cutoutFileName : null,
        showCutout: record.showCutout === true,
      }
    } catch {
      return EMPTY_STATE
    }
  }

  /** 写回状态。 */
  async #persist(): Promise<void> {
    try {
      await mkdir(app.getPath('userData'), { recursive: true })
      await writeFile(this.#storePath, JSON.stringify(this.#state, null, 2), 'utf8')
    } catch (cause) {
      // 持久化失败不该阻断本次换图：图片已经在内存状态里生效了，
      // 只是下次启动会回到上一张。记一条日志即可。
      console.warn(`[dsh-token-pet] 写入 pet-image.json 失败：${String(cause)}`)
    }
  }
}

/** 构造一条拒绝结果。 */
function reject(reason: PetImageRejectReason, message: string): PetImageSelectResult {
  return { status: 'rejected', reason, message }
}

/**
 * 自定义协议的处理函数。
 *
 * 无论请求 URL 长什么样（host、path、query 全部忽略），都只投递
 * **当前**那一张图片。这是刻意的：不做任何输入解析，就没有输入可被滥用。
 *
 * @param store - 图片存储。
 * @returns 可直接交给 `protocol.handle` 的处理函数。
 */
export function createPetImageProtocolHandler(
  store: PetImageStore,
): (request: Request) => Promise<Response> {
  return async (): Promise<Response> => {
    const path = store.resolveCurrentPath()
    const mime = store.currentMime
    if (!path) return new Response(null, { status: 404 })

    try {
      const data = await readFile(path)
      return new Response(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), {
        status: 200,
        headers: {
          'Content-Type': mime ?? 'application/octet-stream',
          // 换图靠 URL 里的 ?v= 破缓存，所以这里可以放心禁用缓存，
          // 免得磁盘上的旧文件被 Chromium 记住。
          'Cache-Control': 'no-store',
        },
      })
    } catch {
      // 文件在读取前被删掉了（用户手工清理、或上一张正在被替换）。
      return new Response(null, { status: 404 })
    }
  }
}
