/**
 * 每日赛博抽签：选卦 + 调用 DeepSeek 生成幽默运势。
 *
 * ## 为什么 AI 调用在主进程
 *
 * API Key 只在主进程里可取（`CredentialChain` 读环境变量 / `.env`）。
 * 如果在渲染进程直接 `fetch`，Key 就必须穿过 IPC 落到页面上，
 * 而页面是 `file://` 源、又开着 devtools——那等于把密钥挂在窗口上。
 *
 * ## 为什么 AI 失败不算失败
 *
 * 抽签本身（选卦）是纯本地的，永远会成功。AI 只是"解读"这一层装饰：
 * 没 Key、断网、限流时应该**照常展示卦象**，配一句本地兜底文案 + 一行原因，
 * 而不是弹一个错误、让用户以为功能坏了。
 */

import type { FortuneReading } from '../shared/types'
import type { Hexagram } from '../shared/hexagrams'
import { pickRandomHexagram } from '../shared/hexagrams'
import { redactValue } from '../shared/redact'
import type { BalanceChainLike } from '../data/credentials'

/** DeepSeek 对话补全接口。 */
export const CHAT_ENDPOINT = 'https://api.deepseek.com/chat/completions'

/** 使用的模型。 */
export const CHAT_MODEL = 'deepseek-chat'

/** 默认超时（ms）。解读是锦上添花，不值得让用户等太久。 */
const DEFAULT_TIMEOUT_MS = 20_000

/**
 * 解读文字的长度上限。
 *
 * Prompt 里已经要求 100 字以内，模型偶尔会超。这里再兜一道：
 * 卡片高度是固定的，超长文字会被裁掉，不如自己截断加省略号。
 */
const MAX_INTERPRETATION_CHARS = 160

/**
 * AI 不可用时的兜底文案。
 *
 * 写得像"赛博算命先生"而不是像报错——功能没坏，只是今天这位先生网络不好。
 */
const FALLBACK_LINES: readonly string[] = [
  '卦象已出，只是赛博先生今日掉线。宜少改需求、多喝水，代码自会通过。',
  'AI 正在重启它的赛博玄学模块，卦象先收下：今日稳住心态，比什么都强。',
  '签筒通了，Wi-Fi 没通。卦象为真，解读随缘——先提交，再想别的。',
  '今日之卦已现，算命先生正在排队。趁这段时间，把那个 TODO 写了吧。',
]

/** 构造参数。 */
export interface FortuneOracleOptions {
  /** 凭据链，与余额轮询共用同一套解析顺序。 */
  readonly credentials: BalanceChainLike
  /** 对话接口地址；默认 DeepSeek 官方，可用环境变量指向本地 mock 服务。 */
  readonly endpoint?: string
  /** 注入 fetch，便于测试。 */
  readonly fetchImpl?: typeof fetch
  /** 超时（ms）。 */
  readonly timeoutMs?: number
}

/** 抽签器。 */
export class FortuneOracle {
  readonly #credentials: BalanceChainLike
  readonly #endpoint: string
  readonly #fetch: typeof fetch
  readonly #timeoutMs: number

  constructor(options: FortuneOracleOptions) {
    this.#credentials = options.credentials
    this.#endpoint = options.endpoint ?? CHAT_ENDPOINT
    this.#fetch = options.fetchImpl ?? fetch
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /**
   * 抽一签。
   *
   * 永远 resolve：AI 出问题时退回兜底文案，把原因放进 `notice`。
   *
   * @returns 卦象与解读。
   */
  async draw(): Promise<FortuneReading> {
    const hexagram = pickRandomHexagram()

    let apiKey: string | undefined
    try {
      const credential = await this.#credentials.resolve()
      apiKey = credential?.apiKey
    } catch (cause) {
      console.warn(`[dsh-token-pet] 抽签读取凭据失败：${redactValue(cause)}`)
    }

    if (!apiKey) {
      return {
        hexagram,
        interpretation: pickFallbackLine(),
        source: 'fallback',
        notice: '未配置 API Key，这是本地兜底文案',
      }
    }

    try {
      const interpretation = await this.#askAi(apiKey, hexagram)
      console.log(`[dsh-token-pet] 抽签：${hexagram.name}，AI 解读 ${interpretation.length} 字`)
      return { hexagram, interpretation, source: 'ai' }
    } catch (cause) {
      // 注意：这里的 cause 可能包含请求细节，必须脱敏后再落日志。
      console.warn(`[dsh-token-pet] 抽签 AI 解读失败，改用兜底文案：${redactValue(cause)}`)
      return {
        hexagram,
        interpretation: pickFallbackLine(),
        source: 'fallback',
        notice: describeFailure(cause),
      }
    }
  }

  /** 调用对话补全接口。 */
  async #askAi(apiKey: string, hexagram: Hexagram): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)

    try {
      const response = await this.#fetch(this.#endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Key 只在这里出现，永远不会回传渲染进程，也不会进入日志（日志会脱敏）。
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: CHAT_MODEL,
          messages: [{ role: 'user', content: buildPrompt(hexagram) }],
          // 高一点才有"算命先生"的味道；0 会让每次解读都一个样。
          temperature: 1.3,
          max_tokens: 400,
          stream: false,
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new Error(`接口返回 HTTP ${response.status}`)
      }

      const payload: unknown = await response.json()
      const content = readMessageContent(payload)
      if (!content) throw new Error('接口返回的内容为空')

      return clampText(content)
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * 构造 Prompt。
 *
 * 逐字按需求给定：身份、卦象、要结合的程序员场景、语气、字数限制。
 * 字数限制写进 prompt 比事后截断更有效——模型会自己收敛长度。
 *
 * @param hexagram - 抽到的卦。
 * @returns 送给模型的用户消息。
 */
export function buildPrompt(hexagram: Hexagram): string {
  return (
    '你是一个精通易经且懂程序员生活的赛博算命先生。' +
    `我今天抽到了【${hexagram.name}，卦辞：${hexagram.judgment}】。` +
    '请结合程序员的日常（写代码、改Bug、开会、摸鱼等），用幽默、鼓励的语气为我解读今天的运势，' +
    '字数限制在 100 字以内。'
  )
}

/**
 * 从接口响应里取出正文。
 *
 * 逐层校验而不是一路可选链：响应来自外部，任何一层都可能不是预期形状，
 * 明确地"取不到就报错"比让 `undefined` 流进界面更容易排查。
 *
 * @param payload - 已解析的 JSON。
 * @returns 正文；结构不符时返回 `undefined`。
 */
function readMessageContent(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return undefined
  const first = choices[0]
  if (typeof first !== 'object' || first === null) return undefined
  const message = (first as { message?: unknown }).message
  if (typeof message !== 'object' || message === null) return undefined
  const content = (message as { content?: unknown }).content
  return typeof content === 'string' ? content : undefined
}

/** 收敛空白并截断到卡片能放下的长度。 */
function clampText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= MAX_INTERPRETATION_CHARS) return normalized
  return `${normalized.slice(0, MAX_INTERPRETATION_CHARS)}…`
}

/** 随机取一句兜底文案。 */
function pickFallbackLine(): string {
  const index = Math.floor(Math.random() * FALLBACK_LINES.length)
  return FALLBACK_LINES[index] ?? FALLBACK_LINES[0] ?? ''
}

/**
 * 把失败原因翻译成一句给用户看的话。
 *
 * 不直接把异常信息抛给用户：里面可能带 URL、状态码等实现细节，
 * 而且"TypeError: Failed to fetch"对用户毫无意义。
 */
function describeFailure(cause: unknown): string {
  if (cause instanceof Error && cause.name === 'AbortError') return 'AI 解读超时，已用本地文案'
  const message = cause instanceof Error ? cause.message : String(cause)
  if (message.includes('401') || message.includes('403')) return 'API Key 无效或额度不足，已用本地文案'
  if (message.includes('429')) return '请求太频繁，已用本地文案'
  if (message.includes('HTTP')) return `AI 服务异常（${message}），已用本地文案`
  return 'AI 暂时无法连接，已用本地文案'
}
