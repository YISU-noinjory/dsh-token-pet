/**
 * 抠掉背景、只留主体（纯逻辑，不依赖 Electron）。
 *
 * ## 为什么不用 AI 模型
 *
 * 人像分割需要约 40MB 的模型 + ONNX/WASM 运行时，首次还要联网下载。
 * 而桌面宠物的图片绝大多数是**纯色或浅渐变背景的角色图**，这类图用
 * 颜色泛洪就能处理得足够好，且瞬时、离线、零依赖。
 *
 * ## 算法
 *
 * 1. 取四边像素的平均色作为**背景参考色**；
 * 2. 从四边做泛洪填充，颜色接近参考色的连通区域判为背景；
 * 3. 对剩下的像素做连通块标记，**只保留最大的主体**（以及不小于它 5%
 *    的附属块，避免把分离的手、道具误删）；
 * 4. 边界一圈按"与背景色的接近程度"给半透明，消除硬切边的锯齿。
 *
 * ## 两道安全阀
 *
 * 泛洪是启发式的，遇到复杂背景会失败。失败本身不可怕，**可怕的是把主体
 * 抠没了还当成成功**，所以这里有两道闸：
 *
 * - 清除比例 < 4%：说明没找到背景（例如图片本身就是抠好的），不做处理；
 * - 清除比例 > 88%：说明把主体也吃掉了，**放弃并保留原图**。
 *
 * 这两道闸让"效果不好"退化成"没效果"，而不是"图片被毁"。
 */

/** 裸像素位图。`data` 是 **BGRA**、每像素 4 字节，与 Electron 的 `nativeImage.toBitmap()` 一致。 */
export interface Bitmap {
  readonly data: Uint8Array
  readonly width: number
  readonly height: number
}

/** 抠图参数。 */
export interface MattingOptions {
  /**
   * 与背景参考色的最大允许差异（0–255）。
   *
   * 含义是「三个通道之差的均方根」。46 大致相当于每个通道可以偏 46，
   * 足以吃下浅渐变的背景，又不至于把浅色的衣服一起吃掉。
   */
  tolerance?: number
}

/** 失败原因。 */
export type MattingFailure =
  /** 几乎没清除掉什么：本来就没有背景，或背景与主体难以区分。 */
  | 'not-enough-background'
  /** 清除得太多：主体被一起清掉了，必须放弃。 */
  | 'ate-the-subject'
  /** 图片本身已有大量透明像素，不需要抠。 */
  | 'already-transparent'
  /** 尺寸非法或数据长度对不上。 */
  | 'invalid-bitmap'

/** 结果统计，用于日志与调试。 */
export interface MattingStats {
  /** 被清除的像素比例（0–1）。 */
  removedRatio: number
  /** 保留下来的连通块数量。 */
  keptComponents: number
  /** 实际使用的容差。 */
  usedTolerance: number
  /** 失败原因；成功时为 `undefined`。 */
  failure?: MattingFailure
}

/** 抠图结果。失败时 `bitmap` 就是传入的原图。 */
export interface MattingOutcome {
  readonly bitmap: Bitmap
  readonly stats: MattingStats
}

/** 默认容差。见 {@link MattingOptions.tolerance} 的说明。 */
const DEFAULT_TOLERANCE = 46

/** 清除比例低于此值视为"没找到背景"。 */
const MIN_REMOVED_RATIO = 0.04

/**
 * 清除比例高于此值视为"把主体一起吃掉了"。
 *
 * 定在 96% 而不是更保守的 88%：桌面宠物图里人物常常只占画面的 10–20%，
 * 背景占 85% 以上是**完全正常**的。上限压太低会让大量正常图片被判失败、
 * 抠都不抠。而真正抠过头的情况（主体被吃掉）清除比例会逼近 100%，
 * 96% 足以把它们拦住。
 */
const MAX_REMOVED_RATIO = 0.96

/** 附属连通块的保留门槛：不小于最大块的这个比例。 */
const KEEP_RATIO_OF_LARGEST = 0.05

/** 附属连通块的绝对保留门槛：不小于整图像素的这个比例（去掉噪点与碎屑）。 */
const KEEP_RATIO_OF_IMAGE = 0.0005

/** 根号 3，用于把三通道距离折算成"平均每通道差"。 */
const SQRT3 = Math.sqrt(3)

/** 背景参考色。 */
interface Reference {
  readonly b: number
  readonly g: number
  readonly r: number
}

/**
 * 抠掉背景，只保留主体。
 *
 * @param bitmap - 输入位图（BGRA）。
 * @param options - 参数。
 * @returns 处理后的位图与统计。失败时返回原图，并把原因写在 `stats.failure`。
 */
export function removeBackground(bitmap: Bitmap, options: MattingOptions = {}): MattingOutcome {
  const { width, height, data } = bitmap
  const total = width * height
  const tolerance = clamp(options.tolerance ?? DEFAULT_TOLERANCE, 1, 255)

  const invalid: MattingStats = {
    removedRatio: 0,
    keptComponents: 0,
    usedTolerance: tolerance,
    failure: 'invalid-bitmap',
  }
  if (width < 3 || height < 3 || data.length < total * 4) {
    return { bitmap, stats: invalid }
  }

  // --- 1. 背景参考色 ---
  const reference = sampleBorderColor(data, width, height)

  // 图片四边本来就有相当比例是透明的 → 它已经是抠好的图，再抠只会伤到主体。
  const borderAlpha = sampleBorderAlpha(data, width, height)
  if (borderAlpha < 0.72) {
    return {
      bitmap,
      stats: { removedRatio: 0, keptComponents: 0, usedTolerance: tolerance, failure: 'already-transparent' },
    }
  }

  // --- 2. 从四边泛洪填充 ---
  const background = new Uint8Array(total)
  floodFromBorders(data, width, height, reference, tolerance, background)

  let removedCount = 0
  for (let index = 0; index < total; index += 1) removedCount += background[index] === 1 ? 1 : 0
  const removedRatio = removedCount / total

  if (removedRatio < MIN_REMOVED_RATIO) {
    return {
      bitmap,
      stats: { removedRatio, keptComponents: 0, usedTolerance: tolerance, failure: 'not-enough-background' },
    }
  }
  if (removedRatio > MAX_REMOVED_RATIO) {
    return {
      bitmap,
      stats: { removedRatio, keptComponents: 0, usedTolerance: tolerance, failure: 'ate-the-subject' },
    }
  }

  // --- 3. 连通块：只保留主体 ---
  const { labels, sizes } = labelComponents(data, width, height, background)
  const largest = sizes.reduce((max, size) => (size > max ? size : max), 0)
  const threshold = Math.max(largest * KEEP_RATIO_OF_LARGEST, total * KEEP_RATIO_OF_IMAGE)
  const keepComponent = sizes.map((size) => size >= threshold)
  let keptComponents = 0
  for (const kept of keepComponent) keptComponents += kept ? 1 : 0

  // --- 4. 写 alpha，并对边界做羽化 ---
  const output = new Uint8Array(data)
  for (let index = 0; index < total; index += 1) {
    const offset = index * 4
    const component = at(labels, index)
    const kept = at(background, index) === 0 && component >= 0 && at(keepComponent, component) === true

    if (!kept) {
      // 透明像素的颜色也一并清零：留着只会让 PNG 变大，还可能在某些
      // 合成路径里渗出彩色光晕。
      output[offset] = 0
      output[offset + 1] = 0
      output[offset + 2] = 0
      output[offset + 3] = 0
      continue
    }

    let alpha = 255
    if (touchesRemoved(data, width, height, background, labels, keepComponent, index)) {
      // 边界像素：与背景色的差落在「刚好被泛洪放过」到「明显是主体」之间时，
      // 它是抗锯齿产生的过渡像素，给它半透明。
      //
      // 羽化带必须**在容差之上**：低于容差的像素早被泛洪标成背景了，
      // 把带宽放在容差之下不会命中任何像素（这个分支等于没写）。
      const distance = channelDistance(data, offset, reference)
      const low = tolerance
      const high = tolerance * 1.9
      alpha = Math.round(255 * clampScale((distance - low) / (high - low)))
      // 几乎等于背景色的那些像素直接去掉，否则轮廓会留下一圈脏边。
      if (alpha < 24) alpha = 0
    }

    if (alpha === 255) continue

    output[offset + 3] = alpha
    if (alpha === 0) {
      output[offset] = 0
      output[offset + 1] = 0
      output[offset + 2] = 0
    } else {
      // Skia 的位图是**预乘 alpha** 的，半透明像素的颜色必须先乘上 alpha，
      // 否则合成时会偏亮。
      const scale = alpha / 255
      output[offset] = Math.round(at(data, offset) * scale)
      output[offset + 1] = Math.round(at(data, offset + 1) * scale)
      output[offset + 2] = Math.round(at(data, offset + 2) * scale)
    }
  }

  return {
    bitmap: { data: output, width, height },
    stats: { removedRatio, keptComponents, usedTolerance: tolerance },
  }
}

/* ------------------------------------------------------------------ *
 * 内部工具
 * ------------------------------------------------------------------ */

/**
 * 读一个下标元素，类型收窄为非空。
 *
 * `noUncheckedIndexedAccess` 会把每个下标访问都变成 `T | undefined`。这个
 * 算法的所有下标都由显式边界算出来，逐处写 `?? 0` 只会把几百行像素循环
 * 淹没在噪声里，所以把收窄集中在这一个函数、只付一次代价。
 *
 * @param array - 任何可按下标取值的序列（像素缓冲、掩码、布尔表）。
 * @param index - 调用方已保证合法的下标。
 */
function at<T>(array: ArrayLike<T>, index: number): T {
  return array[index] as T
}

/** 把数值夹到闭区间内。 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** 把 0–1 之外的输入夹回 0–1。 */
function clampScale(value: number): number {
  return Math.min(Math.max(value, 0), 1)
}

/** 取某个像素与参考色的"平均每通道差"。 */
function channelDistance(data: Uint8Array, offset: number, reference: Reference): number {
  const db = at(data, offset) - reference.b
  const dg = at(data, offset + 1) - reference.g
  const dr = at(data, offset + 2) - reference.r
  return Math.sqrt(db * db + dg * dg + dr * dr) / SQRT3
}

/** 统计四边像素的平均色（跳过全透明的像素）。 */
function sampleBorderColor(data: Uint8Array, width: number, height: number): Reference {
  let b = 0
  let g = 0
  let r = 0
  let count = 0

  const sample = (x: number, y: number): void => {
    const offset = (y * width + x) * 4
    if (at(data, offset + 3) < 16) return
    b += at(data, offset)
    g += at(data, offset + 1)
    r += at(data, offset + 2)
    count += 1
  }

  for (let x = 0; x < width; x += 1) {
    sample(x, 0)
    sample(x, height - 1)
  }
  for (let y = 1; y < height - 1; y += 1) {
    sample(0, y)
    sample(width - 1, y)
  }

  if (count === 0) return { b: 0, g: 0, r: 0 }
  return { b: Math.round(b / count), g: Math.round(g / count), r: Math.round(r / count) }
}

/** 四边像素中不透明的比例。 */
function sampleBorderAlpha(data: Uint8Array, width: number, height: number): number {
  let opaque = 0
  let count = 0
  const check = (x: number, y: number): void => {
    const offset = (y * width + x) * 4
    count += 1
    if (at(data, offset + 3) >= 16) opaque += 1
  }
  for (let x = 0; x < width; x += 1) {
    check(x, 0)
    check(x, height - 1)
  }
  for (let y = 1; y < height - 1; y += 1) {
    check(0, y)
    check(width - 1, y)
  }
  return count === 0 ? 0 : opaque / count
}

/**
 * 从四边泛洪填充，标出背景。
 *
 * 用显式栈而不是递归：一张 4000×4000 的图递归深度会直接爆栈。
 *
 * @param background - 输出掩码，1 表示背景。
 */
function floodFromBorders(
  data: Uint8Array,
  width: number,
  height: number,
  reference: Reference,
  tolerance: number,
  background: Uint8Array,
): void {
  const total = width * height
  const stack = new Int32Array(total)
  let top = 0

  /** 若像素接近背景色且未标记，则入栈。 */
  const visit = (x: number, y: number): void => {
    const index = y * width + x
    if (at(background, index) === 1) return
    if (channelDistance(data, index * 4, reference) > tolerance) return
    background[index] = 1
    stack[top] = index
    top += 1
  }

  for (let x = 0; x < width; x += 1) {
    visit(x, 0)
    visit(x, height - 1)
  }
  for (let y = 1; y < height - 1; y += 1) {
    visit(0, y)
    visit(width - 1, y)
  }

  while (top > 0) {
    top -= 1
    const index = at(stack, top)
    const x = index % width
    const y = (index - x) / width
    if (x > 0) visit(x - 1, y)
    if (x + 1 < width) visit(x + 1, y)
    if (y > 0) visit(x, y - 1)
    if (y + 1 < height) visit(x, y + 1)
  }
}

/**
 * 对非背景像素做连通块标记。
 *
 * @returns `labels` 每像素的连通块编号（-1 表示背景），`sizes` 每块的像素数。
 */
function labelComponents(
  data: Uint8Array,
  width: number,
  height: number,
  background: Uint8Array,
): { labels: Int32Array; sizes: number[] } {
  const total = width * height
  const labels = new Int32Array(total).fill(-1)
  const sizes: number[] = []
  const stack = new Int32Array(total)
  let top = 0

  for (let start = 0; start < total; start += 1) {
    if (background[start] === 1 || labels[start] !== -1) continue

    const label = sizes.length
    let size = 0
    top = 0
    labels[start] = label
    stack[top] = start
    top += 1

    const push = (x: number, y: number): void => {
      const index = y * width + x
      if (at(background, index) === 1 || at(labels, index) !== -1) return
      labels[index] = label
      stack[top] = index
      top += 1
    }

    while (top > 0) {
      top -= 1
      const index = at(stack, top)
      size += 1
      const x = index % width
      const y = (index - x) / width
      if (x > 0) push(x - 1, y)
      if (x + 1 < width) push(x + 1, y)
      if (y > 0) push(x, y - 1)
      if (y + 1 < height) push(x, y + 1)
    }

    sizes.push(size)
  }

  return { labels, sizes }
}

/** 该像素是否紧邻一个将被删除的像素（用于判定边界）。 */
function touchesRemoved(
  data: Uint8Array,
  width: number,
  height: number,
  background: Uint8Array,
  labels: Int32Array,
  keepComponent: readonly boolean[],
  index: number,
): boolean {
  const x = index % width
  const y = (index - x) / width

  const isRemoved = (nx: number, ny: number): boolean => {
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) return true
    const neighbor = ny * width + nx
    if (at(background, neighbor) === 1) return true
    const label = at(labels, neighbor)
    return label < 0 || at(keepComponent, label) !== true
  }

  return (
    isRemoved(x - 1, y) ||
    isRemoved(x + 1, y) ||
    isRemoved(x, y - 1) ||
    isRemoved(x, y + 1) ||
    isRemoved(x - 1, y - 1) ||
    isRemoved(x + 1, y - 1) ||
    isRemoved(x - 1, y + 1) ||
    isRemoved(x + 1, y + 1)
  )
}
