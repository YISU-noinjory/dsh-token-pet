import { defineConfig } from 'vite'

/**
 * 渲染进程构建配置。
 *
 * 只有渲染进程走打包：它需要 TS → 浏览器可用代码的转换，以及 CSS 与 HTML 的处理。
 * 主进程与 preload 由 `tsc -p tsconfig.main.json` 直接产出 CommonJS，不经过打包器。
 *
 * `base: './'` 是必须的：生产环境用 `file://` 协议加载 dist/renderer/index.html，
 * 绝对路径 `/assets/...` 在 file:// 下会 404。
 */
export default defineConfig({
  root: 'src/renderer',
  base: './',
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    // Electron 内置 Chromium，无需为老浏览器降级。
    target: 'chrome128',
    sourcemap: true,
    rollupOptions: {
      output: {
        // 稳定的文件名便于调试；渲染进程不涉及缓存失效问题。
        entryFileNames: 'main.js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
})
