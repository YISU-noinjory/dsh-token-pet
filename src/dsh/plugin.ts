/**
 * DSH 插件入口（Cordis 插件）。
 *
 * ## 为什么这个文件长这样
 *
 * DSH 的插件是 Cordis 插件，形态是四项固定导出：
 * `name` / `inject` / `Config` / `apply`。宿主按 `inject` 声明的服务名
 * 决定何时加载本插件，`Config` 由 `schemastery` 声明（宿主据此生成
 * JSON Schema 并在 `--dump-config` 中展示），`apply` 只在依赖就绪后调用。
 *
 * ## 与 Electron 侧的关系
 *
 * 关键设计是**共用数据层**：本插件直接 import `src/data/*`，
 * 而不是另写一份 `fetch` 调用。于是
 *
 *  - 接口地址、字段名映射、错误分类、退避策略只有一份实现；
 *  - DeepSeek 改了字段名时，两边会在同一个地方一起坏掉，
 *    而不是"宠物好了、工具还错着"这种更难发现的状态。
 *
 * 本插件不负责显示宠物——宠物是 Electron 进程，由 `src/main/*` 启动。
 * 这里负责的是让**宿主与模型**也能读到同一个余额，
 * 例如用户直接问「我 DeepSeek 还剩多少钱」。
 *
 * ## 编译依赖
 *
 * 本文件依赖以下 peer 依赖，它们随 DSH 一起分发：
 *   @deepseek-ai/cordis、@deepseek-ai/dsh-tools、@deepseek-ai/dsh-llm、
 *   @deepseek-ai/dsh-credentials、@deepseek-ai/schemastery
 * 未安装时本文件无法通过类型检查，因此被排除在默认的 tsconfig 之外，
 * 见 `tsconfig.dsh.json`。
 */

import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { formatAmount, parseAmount } from '../shared/config'
import { BalanceClient } from '../data/balance-client'
import type { BalanceChainLike, ResolvedApiKey } from '../data/credentials'
import type { BalanceSnapshot } from '../shared/types'

/* ------------------------------------------------------------------ *
 * Cordis 插件元数据
 * ------------------------------------------------------------------ */

/** 插件名，同时是配置树里的键名。 */
export const name = 'token-pet'

/**
 * 依赖的服务。
 *
 * `tools` 用于注册模型可调用的工具；`credentials` 用于解析 API Key。
 * 声明在此处而不是在 `apply` 里做运行时判断，是为了让宿主的
 * 加载顺序求解器知道本插件必须排在它们之后。
 */
export const inject = ['tools', 'credentials'] as const

/** 宿主可配置项。 */
export const Config = z.object({
  /** 缓存有效期（ms）。模型可能连续追问，没必要每次都打接口。 */
  toolCacheTtlMs: z.number().default(30_000),
  /** 是否注册 `pet_balance` 工具。关掉后插件只保留服务能力。 */
  registerTool: z.boolean().default(true),
})

/**
 * 解析后的配置类型。
 *
 * 手写而不从 {@link Config} 推导：schemastery 的类型层只导出
 * `Schema<S, T, Mode>` 这个别名和默认导出的构造器值，
 * **没有** `z.infer<typeof Config>` 这样的工具类型（那是 zod 的用法）。
 * 手写的代价是两边可能漂移，所以字段顺序与默认值必须与上面一致。
 */
export interface PluginConfig {
  /** 缓存有效期（ms）。 */
  readonly toolCacheTtlMs: number
  /** 是否注册 `pet_balance` 工具。 */
  readonly registerTool: boolean
}

/* ------------------------------------------------------------------ *
 * 插件实现
 * ------------------------------------------------------------------ */

/**
 * 安装插件。
 *
 * @param ctx - 宿主上下文，`tools` / `credentials` 已按 `inject` 就绪。
 * @param config - 经 schemastery 校验后的配置。
 */
export function apply(ctx: Context, config: PluginConfig): void {
  const client = new BalanceClient()
  const credentials = hostCredentialChain(ctx)

  /** 最近一次成功读数与它的时刻，用于工具层的短时缓存。 */
  let cached: { snapshot: BalanceSnapshot; at: number } | undefined

  /**
   * 读取余额，命中缓存则直接返回。
   *
   * @param force - 忽略缓存（供"刷新"参数使用）。
   * @returns 成功时返回快照；失败时抛出携带分类信息的错误。
   */
  async function readBalance(force: boolean): Promise<BalanceSnapshot> {
    const now = Date.now()
    if (!force && cached && now - cached.at < config.toolCacheTtlMs) {
      return cached.snapshot
    }

    const credential = await credentials.resolve()
    if (!credential) {
      throw new Error(
        '未配置 DEEPSEEK_API_KEY。请通过 DSH 的凭证设置配置，或设置同名环境变量。',
      )
    }

    const result = await client.fetchBalance(credential.apiKey)
    if (!result.ok) {
      // 把分类错误码带上，便于调用方（模型或用户）区分"该换 Key"与"该等一会儿"。
      throw new Error(`查询余额失败（${result.error.code}）：${result.error.message}`)
    }

    cached = { snapshot: result.snapshot, at: now }
    return result.snapshot
  }

  if (config.registerTool) {
    const balanceTool = defineTool({
      name: 'pet_balance',
      description:
        '查询当前 DeepSeek API 账户的余额（充值余额与赠送余额）。' +
        '当用户询问"还剩多少钱 / 额度 / 余额"时使用。',
      parameters: {
        refresh: {
          type: 'boolean',
          description: 'true 表示跳过缓存强制重新查询；默认使用 30 秒内的缓存结果。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            isAvailable: { type: 'boolean', description: '账户当前是否可用。' },
            currency: { type: 'string', description: '主钱包币种，CNY 或 USD。' },
            totalBalance: { type: 'string', description: '总余额，十进制字符串。' },
            grantedBalance: { type: 'string', description: '赠送余额。' },
            toppedUpBalance: { type: 'string', description: '充值余额。' },
            fetchedAt: { type: 'number', description: '读数时刻的 epoch 毫秒。' },
          },
        },
        render: (_args, value): ContentBlock[] => {
          // 字段在 schema 里都是可选的（除 additionalProperties 外无 required），
          // 所以这里逐个兜底，而不是直接插值。
          const currency = value.currency === 'USD' ? 'USD' : 'CNY'
          const total = value.totalBalance ?? '0'
          const lines = [
            `DeepSeek 余额：${formatAmount(total, currency)}`,
            `充值 ${value.toppedUpBalance ?? '0'} / 赠送 ${value.grantedBalance ?? '0'}`,
          ]
          if (value.isAvailable === false) lines.push('⚠ 账户当前不可用')
          // 余额为 0 时额外提示，这是用户最需要立刻知道的情况。
          if (parseAmount(total) <= 0) lines.push('余额已耗尽，请及时充值。')
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      // 只读接口，可以被并发调用而不产生副作用。
      isConcurrencySafe: () => true,
      execute: async (args) => {
        const snapshot = await readBalance(args.refresh === true)
        const wallet = snapshot.wallets[0]
        return {
          isAvailable: snapshot.isAvailable,
          currency: wallet?.currency ?? 'CNY',
          totalBalance: wallet?.totalBalance ?? '0',
          grantedBalance: wallet?.grantedBalance ?? '0',
          toppedUpBalance: wallet?.toppedUpBalance ?? '0',
          fetchedAt: snapshot.fetchedAt,
        }
      },
    })

    // register 返回反注册函数；交给 ctx 的生命周期管理，
    // 这样插件被卸载或热重载时不会留下悬挂的工具定义。
    ctx.effect(() => ctx.tools.register(balanceTool))
  }
}

/* ------------------------------------------------------------------ *
 * 凭证适配
 * ------------------------------------------------------------------ */

/**
 * 把宿主的凭证服务包装成本项目数据层认识的窄接口。
 *
 * 这样 `BalancePoller` / `BalanceClient` 完全不需要知道自己是跑在
 * Electron 里还是跑在 DSH 宿主里。
 *
 * `resolve` 每次调用都重新查询，而不是缓存结果：
 * 宿主的凭证服务自身就是"每次操作重新解析"的语义，
 * 缓存会让我们持有过期密钥，用户换了 Key 之后要重启才生效。
 *
 * @param ctx - 宿主上下文。
 * @returns 凭证解析链。
 */
function hostCredentialChain(ctx: Context): BalanceChainLike {
  return {
    async resolve(): Promise<ResolvedApiKey | undefined> {
      const resolved = await ctx.credentials.resolve(credentialRef('DEEPSEEK_API_KEY'))
      if (!resolved) return undefined
      // origin 标记为 'dsh'，便于诊断时区分"来自环境变量"与"来自宿主凭证库"。
      return { apiKey: resolved.value, origin: 'dsh' }
    },
  }
}
