/**
 * 把主进程的控制台输出同时写一份到 UTF-8 日志文件，并在落盘前**脱敏**。
 *
 * ## 为什么需要文件日志
 *
 * Node 往 stdout 写的是 UTF-8，而 Windows 的 cmd.exe 默认代码页是 GBK（936），
 * 于是中文日志在控制台里全是乱码：
 *
 *     [dsh-token-pet] 姝ｅ湪鍚姩鈥?
 *
 * 平时这只是难看；但排查问题时它会直接**卡住定位**——需要读的那行数字在
 * 控制台里根本认不出来。解法不是去改用户的代码页（`chcp 65001` 只影响当前
 * 那个终端，换个窗口就没了），而是让应用自己再写一份文件：编码由我们决定。
 *
 * ## 为什么用包装 console 而不是到处传 logger
 *
 * 主进程的日志散在物理引擎、轮询器、图片存储等多处，逐个改成注入式 logger
 * 收益很小、改动很大。这里只要在启动最早期包装一次，之后所有
 * `console.log/warn/error`（包括依赖内部的）都会自动经过同一条脱敏管线。
 *
 * ## 为什么脱敏放在这一层
 *
 * 日志天生会被贴出去——用户报 issue 时第一件事就是复制日志。指望"贴之前
 * 自己检查一遍"是不可靠的，所以**在写之前**就打码。包装 console 让这条规则
 * 成为唯一入口：任何走 console 的输出（包括第三方库打的）都会被过滤，
 * 不存在"某条路径忘了脱敏"。
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { redactSecrets } from '../shared/redact'

/** 日志文件名，位于 `app.getPath('userData')` 下。 */
const LOG_FILE_NAME = 'pet.log'

/**
 * 开始把控制台输出镜像到文件。
 *
 * 每次启动会覆盖旧文件并在开头写一行时间戳，避免文件无限增长、
 * 也让"这份日志是哪一次运行的"一目了然。
 *
 * @returns 日志文件的绝对路径。
 */
export function teeConsoleToFile(): string {
  const directory = app.getPath('userData')
  const file = join(directory, LOG_FILE_NAME)

  try {
    mkdirSync(directory, { recursive: true })
    writeFileSync(file, `=== 启动于 ${new Date().toLocaleString()} ===\n`, 'utf8')
  } catch {
    // 连日志文件都建不出来时，退回"只有控制台"的行为，不影响应用运行。
    return file
  }

  const originals = { log: console.log, warn: console.warn, error: console.error }

  /**
   * 包一层：先照常打到控制台，再追加进文件。
   *
   * 两处都脱敏。控制台看起来是"临时的"，但用户报 issue 时经常直接截屏或
   * 复制终端输出，所以它同样是泄露面，不能只在文件那一侧过滤。
   */
  const wrap =
    (level: string, original: (...args: unknown[]) => void) =>
    (...args: unknown[]): void => {
      original(...args.map(redactArgument))

      try {
        // 文件：整行序列化后再脱敏，这样对象内部藏的密钥也会被过滤。
        const line = args
          .map((value) => (typeof value === 'string' ? value : inspect(value)))
          .join(' ')
        appendFileSync(file, `[${level}] ${redactSecrets(line)}\n`, 'utf8')
      } catch {
        // 写日志失败绝不能让业务逻辑受影响。
      }
    }

  console.log = wrap('info', originals.log)
  console.warn = wrap('warn', originals.warn)
  console.error = wrap('error', originals.error)

  return file
}

/**
 * 为控制台准备一个已脱敏的参数。
 *
 * 字符串直接脱敏。对象则**先序列化、比对脱敏前后的差异**：
 *
 * - 内容安全时返回**原对象**，devtools 里仍可展开——这是日常调试最需要的；
 * - 内容含密钥时返回**脱敏后的字符串**，牺牲可展开性换掉泄露风险。
 *
 * 只做"一律序列化"会毁掉调试体验，只做"一律透传"则会漏——实测中
 * `console.log('失败', { apiKey: 'sk-…' })` 的对象内部密钥就是这么漏出去的。
 *
 * @param value - 原始参数。
 * @returns 可安全交给控制台的参数。
 */
function redactArgument(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value)
  if (value === null || typeof value !== 'object') return value

  const serialized = inspect(value)
  const redacted = redactSecrets(serialized)
  return redacted === serialized ? value : redacted
}

/**
 * 把任意值转成一行可读文本。
 *
 * 不用 `JSON.stringify`：Error 会被序列化成 `{}`，丢掉最需要的堆栈。
 *
 * @param value - 任意值。
 * @returns 可读文本。
 */
function inspect(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ''}`
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
