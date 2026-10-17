/**
 * API Key 的解析链。
 *
 * 设计要点：余额接口需要的是**用户自己的 API Key**，而 DSH 宿主里的
 * 「账号登录态」是另一条独立的凭证通道（Platform token）。
 * 两者不能互相代替，所以这里定义成一条可插拔的解析链，
 * 由 DSH 插件在宿主内注册自己的实现。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 一次成功的凭证解析。 */
export interface ResolvedApiKey {
  /** Key 本身。此值绝不可进入日志或 IPC 载荷。 */
  readonly apiKey: string
  /** 来源标识，仅用于诊断与 UI 提示（例如「来自环境变量」）。 */
  readonly origin: CredentialOrigin
}

/** 凭证来源。 */
export type CredentialOrigin =
  /** 调用方显式传入（测试或 `pet.config.json`）。 */
  | 'explicit'
  /** 进程环境变量 `DEEPSEEK_API_KEY`。 */
  | 'env'
  /** 工作目录下的 `.env` 文件。 */
  | 'dotenv'
  /** 由 DSH 宿主的 credentials 服务提供。 */
  | 'dsh'

/**
 * 单个凭证来源。
 *
 * 返回 `undefined` 表示「这一环没有」，让解析链继续往下走；
 * 抛异常表示「这一环出错了」，解析链会中止——因为把
 * 「Key 读不出来（磁盘故障）」当成「没有 Key」会导致用户
 * 收到误导性的「未配置 API Key」提示。
 */
export interface CredentialProvider {
  readonly origin: CredentialOrigin
  resolve(): Promise<string | undefined>
}

/** 环境变量名。与 DeepSeek 官方 SDK 保持一致。 */
export const API_KEY_ENV = 'DEEPSEEK_API_KEY'

/** 从进程环境变量读取。 */
export function envCredential(
  env: NodeJS.ProcessEnv = process.env,
): CredentialProvider {
  return {
    origin: 'env',
    async resolve() {
      const value = env[API_KEY_ENV]?.trim()
      return value ? value : undefined
    },
  }
}

/**
 * 从 `.env` 文件读取。
 *
 * 刻意只实现最小解析（`KEY=VALUE`、`#` 注释、可选的引号），
 * 不引入 dotenv 依赖：本项目只需要一个键，
 * 而 dotenv 的完整行为（变量展开、多文件层叠）在这里是负担。
 *
 * @param directory - 查找目录，通常是工作目录。
 */
export function dotenvCredential(directory: string): CredentialProvider {
  return {
    origin: 'dotenv',
    async resolve() {
      let content: string
      try {
        content = await readFile(join(directory, '.env'), 'utf8')
      } catch {
        // 文件不存在是正常情况，不是错误。
        return undefined
      }
      return parseDotenv(content)[API_KEY_ENV]
    },
  }
}

/**
 * 解析 `.env` 文本。
 *
 * @param content - 文件内容。
 * @returns 键值对；无法识别的行被忽略。
 */
function parseDotenv(content: string): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {}
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2')
    result[key] = value
  }
  return result
}

/**
 * 解析链的最小接口。
 *
 * {@link BalancePoller} 只依赖这个窄接口而不是 {@link CredentialChain} 具体类：
 * 测试可以塞一个返回固定值的假对象，DSH 宿主也可以注入自己的实现
 * （例如直接向宿主的 credentials 服务要 Key）而无需改动调度器。
 */
export interface BalanceChainLike {
  resolve(): Promise<ResolvedApiKey | undefined>
}

/** 按顺序尝试多个来源，返回第一个命中的结果。 */
export class CredentialChain implements BalanceChainLike {
  readonly #providers: readonly CredentialProvider[]

  constructor(providers: readonly CredentialProvider[]) {
    this.#providers = providers
  }

  /**
   * 依次解析，直到某一环给出值。
   *
   * 并发不适用：后面几环可能有副作用（读盘、走 IPC），
   * 且顺序本身表达了优先级，必须短路。
   *
   * @returns 命中的凭证；全部落空时为 `undefined`。
   */
  async resolve(): Promise<ResolvedApiKey | undefined> {
    for (const provider of this.#providers) {
      const value = await provider.resolve()
      if (value) return { apiKey: value, origin: provider.origin }
    }
    return undefined
  }

  /** 构造默认解析链：显式 → 环境变量 → `.env`。 */
  static default(directory: string, explicitKey?: string): CredentialChain {
    const providers: CredentialProvider[] = []
    if (explicitKey?.trim()) {
      const key = explicitKey.trim()
      providers.push({ origin: 'explicit', resolve: async () => key })
    }
    providers.push(envCredential(), dotenvCredential(directory))
    return new CredentialChain(providers)
  }
}
