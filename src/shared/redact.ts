/**
 * 日志与错误信息里的密钥脱敏（纯函数，不依赖 Electron，可单独测试）。
 *
 * ## 为什么必须有
 *
 * 日志天生会被贴出去——用户报 issue 时第一件事就是复制日志。指望
 * 「贴之前自己检查一遍」是不可靠的，所以**在写之前**就打码。
 *
 * 覆盖三类实际会出现在日志里的形态：
 *  1. `sk-` 开头的模型 API Key（DeepSeek / OpenAI 同款前缀）；
 *  2. `Authorization: Bearer <token>` 里的令牌；
 *  3. `DEEPSEEK_API_KEY=...`、`api_key: ...` 这类键值对里的值。
 *
 * ## 为什么保留前 4 位
 *
 * 保留 `sk-` 与随后 4 位是为了**可诊断**：用户能自己确认"用的是哪一把 Key"，
 * 又不至于把 Key 交出去。反过来，打码后的星号是固定长度，不保留原文长度——
 * 否则可以从长度反推密钥的熵。
 */

/** 打码后的填充字符。固定长度，刻意不反映原文长度。 */
const MASK = '********'

/**
 * 对文本做密钥脱敏。
 *
 * @param text - 原始文本。
 * @returns 脱敏后的文本。不含任何密钥时原样返回。
 */
export function redactSecrets(text: string): string {
  return (
    text
      // 1. sk- 开头的密钥：保留前缀与随后 4 位，其余打码。
      //    长度下限 4 是为了避免把 "sk-abc" 这种无关字符串也当成密钥处理。
      .replace(/\bsk-[A-Za-z0-9_-]{4,}/g, (match) => `sk-${match.slice(3, 7)}${MASK}`)
      // 2. Bearer 令牌。
      .replace(/(\bBearer\s+)[\w.~+/-]{8,}=*/gi, (_match, prefix: string) => `${prefix}${MASK}`)
      // 3. 环境变量 / 配置项里的密钥值。
      //    名字里带 API_KEY / authorization / token / secret / password 的都算。
      //
      //    有两处容易写错，都是实测撞出来的：
      //    - JSON / YAML 里名字可能被引号包着（`"api_key": "..."`），
      //      闭合引号夹在名字和冒号之间，必须单独吃掉一个 `(["']?)`；
      //    - 不能把 `Authorization: Bearer xxx` 里的 `Bearer` 当成密钥值
      //      一起打掉——那会连协议名都看不见，反而更难判断。用负向先行排除。
      .replace(
        /\b([A-Za-z0-9_]*API[_-]?KEY|api[_-]?key|authorization|access[_-]?token|client[_-]?secret|password)\b(["']?)(\s*[:=]\s*)(["']?)(?!Bearer\b)[^\s"',]{6,}/gi,
        (_match, name: string, closeQuote: string, separator: string, openQuote: string) =>
          `${name}${closeQuote}${separator}${openQuote}${MASK}`,
      )
  )
}

/**
 * 脱敏一个可能任意类型的值，用于拼错误信息。
 *
 * @param value - 任意值（通常是 catch 到的 `unknown`）。
 * @returns 脱敏后的文本。
 */
export function redactValue(value: unknown): string {
  const text = value instanceof Error ? `${value.name}: ${value.message}` : String(value)
  return redactSecrets(text)
}
