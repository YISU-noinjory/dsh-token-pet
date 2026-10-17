// 最小 Electron 应用 —— 用来区分「Electron 本身起不来」和「我们的应用有问题」。
//
// 这个文件不加载项目里的任何代码，只做三件事：写日志、等 app ready、建一个空窗口。
// 因此它是判断故障层次的基准线：
//
//   最小应用也起不来  → 问题在 Electron / 系统层，与本项目代码无关
//   最小应用能起来    → 问题在本项目的代码或资源里
//
// 用法（用项目里那份 electron.exe）：
//   node_modules\electron\dist\electron.exe scripts\minimal-app.js
//
// 结果日志写在 %TEMP%\electron-minimal.log，逐行记录执行到哪一步，
// 所以即使进程秒退也能看出停在哪。

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const logPath = path.join(os.tmpdir(), 'electron-minimal.log')
fs.writeFileSync(logPath, `=== 最小 Electron 应用 ===\n`)
const mark = (text) => fs.appendFileSync(logPath, `${text}\n`)

mark(`electron ${process.versions.electron} / node ${process.versions.node}`)
mark('1. 主脚本已加载')

process.on('uncaughtException', (error) => mark(`uncaughtException: ${error.message}`))

const { app, BrowserWindow } = require('electron')
mark('2. require("electron") 成功')

mark('3. 即将调用 app.whenReady()')
app.whenReady().then(() => {
  mark('4. app ready 已兑现')
  const win = new BrowserWindow({ width: 240, height: 240, show: false })
  mark('5. 窗口已创建')
  win.destroy()
  mark('6. 全部成功 —— Electron 本身没问题')
  app.quit()
})
mark('3b. whenReady() 已调用（等待中）')

console.log(`日志：${logPath}`)
