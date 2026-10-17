import { defineConfig } from 'vite'

/**
 * preload 构建配置。
 *
 * 为什么 preload 要打包，而主进程只用 tsc：
 * 沙箱化的 preload（`sandbox: true`）里可用的 `require` 只支持 `electron`
 * 与少数内置模块，**不能 require 同项目的其他文件**。而 preload 需要
 * `../shared/ipc` 里的频道常量。用 tsc 编译会在运行时直接抛
 * "module not found"，所以这里用 Vite 把 preload 及其依赖压成一个 CJS 文件。
 *
 * 输出格式必须是 CJS：沙箱 preload 不支持 ESM。
 */
export default defineConfig({
  build: {
    outDir: 'dist/preload',
    emptyOutDir: true,
    target: 'node20',
    // 保留可读输出：preload 体积很小，压缩只会让线上排查变难。
    minify: false,
    sourcemap: true,
    lib: {
      entry: 'src/preload/index.ts',
      formats: ['cjs'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      // electron 由运行时提供，不能打进产物。
      external: ['electron'],
    },
  },
})
