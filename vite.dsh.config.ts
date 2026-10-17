import { defineConfig } from 'vite'

/**
 * DSH 插件入口的构建配置。
 *
 * ## 为什么也走打包（而不是像主进程那样只用 tsc）
 *
 * 三个理由，每一个单独都足以决定用打包器：
 *
 * 1. **必须是 ESM 单文件。** DSH 的 Cordis 加载器用 `import()` 加载 bundle 行，
 *    而本仓库根 `package.json` 没有 `"type": "module"`，tsc 产出的 `.js`
 *    会被 Node 当成 CommonJS。打包成 `.mjs` 可以明确表达 ESM，
 *    不必在 dist 里再塞一个 `package.json`（那会被 `emptyOutDir` 清掉）。
 *
 * 2. **必须自带共享模块。** 插件要用 `src/shared/config.ts` 的情绪推导与金额格式化，
 *    以及 `src/data/balance-client.ts` 的余额客户端。它们由主进程的 tsc
 *    编译成 CommonJS 放在 `dist/shared` 与 `dist/data`，ESM 入口再跨目录去引
 *    CJS 产物既脆弱又难排查。打包把它们内联进来，产物自洽。
 *
 * 3. **`@deepseek-ai/*` 必须保持外部依赖。** 绝不能内联 `dsh-tools` / `dsh-llm`：
 *    那些包里用 `instanceof HarnessError` 之类的跨模块身份判断，
 *    内联会产生第二份类，导致宿主侧的 `instanceof` 静默失败。
 *    外部化之后由 Node 从 `node_modules` 解析，与宿主共享同一份模块实例。
 */
export default defineConfig({
  build: {
    outDir: 'dist/dsh',
    emptyOutDir: true,
    // 宿主是 Node（Electron 与 dsh CLI 都在 Node 20+ 上跑）。
    target: 'node20',
    // 保持可读：插件很小，压缩只会让线上排查变难。
    minify: false,
    sourcemap: true,
    lib: {
      entry: 'src/dsh/plugin.ts',
      formats: ['es'],
      // `.mjs` 而不是 `.js`：见上文第 1 点。
      fileName: () => 'plugin.mjs',
    },
    rollupOptions: {
      // 只外部化 DSH 包与 node 内置模块；相对导入的 shared/ 与 data/ 会被内联。
      external: [/^@deepseek-ai\//, /^node:/],
    },
  },
})
