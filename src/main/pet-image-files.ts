/**
 * 自定义宠物图片的两组纯函数：格式识别与受管路径解析。
 *
 * ## 为什么单独一个模块
 *
 * 这两件事都是**安全边界**上的判断：
 *  - 格式识别决定"用户选的文件能不能被当成图片用"；
 *  - 路径解析决定"待读取的文件名会不会跳出受管目录"。
 *
 * 放在 `pet-image.ts` 里它们会因为模块顶部的 `import { app } from 'electron'`
 * 而无法脱离 Electron 运行，也就无法单独测试。安全判断恰恰是最需要
 * 能被独立验证的部分，所以这里刻意不引入任何 Electron 依赖——
 * 只有 `node:path`，纯到可以在裸 Node 里直接跑。
 */

import { basename, resolve, sep } from 'node:path'

/** 读取多少字节的文件头就够判定这四种格式。 */
export const HEADER_BYTES = 12

/** 一张图片的格式签名。 */
export interface ImageSignature {
  /** 用于 HTTP `Content-Type`。 */
  readonly mime: string
  /** 规范化扩展名（不含点），`.jpeg` 会被收成 `jpg`。 */
  readonly extension: string
}

/**
 * 用文件头魔数判定图片格式。
 *
 * **不能只看扩展名**：把 `malware.exe` 改名成 `cat.png` 是最省事的伪装。
 * 扩展名只在文件选择框里做初筛（那只是个建议），真正的判定在这里。
 * 换句话说，这个函数的返回值才是"这是不是图片"的唯一依据。
 *
 * @param header - 文件开头的若干字节（建议至少 {@link HEADER_BYTES} 字节）。
 * @returns 识别出的格式；不认识时返回 `undefined`。
 */
export function sniffImageType(header: Uint8Array): ImageSignature | undefined {
  // PNG：固定 8 字节魔数，带 \r\n 与 EOF 控制字符，几乎不可能误判。
  if (matches(header, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mime: 'image/png', extension: 'png' }
  }
  // JPEG：SOI 标记。三字节足以与其它格式区分。
  if (matches(header, 0, [0xff, 0xd8, 0xff])) {
    return { mime: 'image/jpeg', extension: 'jpg' }
  }
  // GIF87a / GIF89a 共用 'GIF8' 前缀。
  if (matches(header, 0, [0x47, 0x49, 0x46, 0x38])) {
    return { mime: 'image/gif', extension: 'gif' }
  }
  // WebP 是 RIFF 容器：'RIFF' + 4 字节长度 + 'WEBP'。
  // 只查 'RIFF' 不够——WAV、AVI 也是 RIFF，必须连 'WEBP' 一起查。
  if (matches(header, 0, [0x52, 0x49, 0x46, 0x46]) && matches(header, 8, [0x57, 0x45, 0x42, 0x50])) {
    return { mime: 'image/webp', extension: 'webp' }
  }
  return undefined
}

/** 判断 `header` 从 `offset` 起是否与 `signature` 逐一相等。 */
function matches(header: Uint8Array, offset: number, signature: readonly number[]): boolean {
  if (header.length < offset + signature.length) return false
  for (let index = 0; index < signature.length; index += 1) {
    if (header[offset + index] !== signature[index]) return false
  }
  return true
}

/**
 * 把受管目录里的一个文件名解析成绝对路径，并确认它没有跑出目录。
 *
 * ## 为什么要防
 *
 * 文件名来自 `userData/pet-image.json`——一个磁盘上的明文 JSON。
 * 它平时由本应用写入，但用户、同步工具或任何本地进程都可以改它。
 * 如果直接 `join(directory, fileName)` 后就去读，那么
 * `fileName = "../../../../Windows/System32/config/SAM"` 会让
 * 自定义协议把系统文件当成"宠物图片"投递出去。
 *
 * ## 两道检查都保留的理由
 *
 * 1. `basename(fileName) === fileName`：只接受**纯文件名**。
 *    含任何路径分隔符（`/` 或 `\`）、是绝对路径、或是 `sub/x.png`，
 *    全部直接拒绝。这条检查最直观，也覆盖了绝大多数攻击形态。
 *
 * 2. 前缀比较：即使第 1 条被某种路径写法绕过（例如 Windows 上
 *    以盘符开头的怪形式），解析后的绝对路径仍必须落在受管目录内。
 *
 * 第 1 条能拦住 `..` 吗？`basename('..')` 就是 `'..'`，能通过——
 * 但它紧接着会被第 2 条拦下（`resolve(base, '..')` 是父目录，
 * 不以 `base + sep` 开头）。这正是保留两道检查的价值。
 *
 * 注：Windows 路径大小写不敏感，但 `directory` 与 `candidate` 都由
 * 同一个 `base` 经 `resolve` 得出，前缀大小写天然一致，不会误判。
 *
 * @param directory - 受管目录的绝对路径。
 * @param fileName - 待解析的文件名，来自持久化状态。
 * @returns 合法的绝对路径；无文件名或路径非法时返回 `undefined`。
 */
export function resolveManagedImagePath(
  directory: string,
  fileName: string | null,
): string | undefined {
  if (!fileName) return undefined
  if (basename(fileName) !== fileName) return undefined

  const base = resolve(directory)
  const candidate = resolve(base, fileName)
  if (!candidate.startsWith(base + sep)) return undefined
  return candidate
}
