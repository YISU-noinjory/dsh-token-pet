/**
 * 运行环境探测：当前环境能不能支撑 Chromium 的多进程架构。
 *
 * ## 为什么需要它
 *
 * Electron 在 Windows 上跑不起来时，症状是「进程秒退、没有任何输出」，
 * 极易被误判成杀软拦截或 Electron 版本问题。真正的原因通常在更底层：
 *
 *   Chromium 的浏览器进程要和 GPU 进程、网络服务、渲染进程通信，
 *   在 Windows 上这条通道是**命名管道**（Mojo 的传输层）。
 *   命名管道一旦连不上，浏览器进程在 app.whenReady() 里就会崩溃，
 *   而这发生在任何业务代码之前。
 *
 * 这个脚本只做底层能力测试，不启动 Electron，所以又快又能给出确定答案。
 *
 * 用法：
 *   node scripts\probe-ipc.cjs
 */

'use strict'

const net = require('node:net')
const { spawn } = require('node:child_process')

/** 每一项的结论。 */
const results = []

/**
 * 记录一项探测结果。
 *
 * @param {string} name - 探测项名称。
 * @param {boolean} ok - 是否通过。
 * @param {string} detail - 细节说明。
 */
function record(name, ok, detail) {
  results.push({ name, ok, detail })
}

/**
 * 命名管道完整收发一轮。
 *
 * 只测「建服务端」是不够的：`server.listen()` 是异步的，
 * 建不起来时抛的是 error 事件而不是异常，很容易误判为通过。
 * 必须真的连一次并收到数据，才算这条通道可用。
 *
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
function probeNamedPipe() {
  return new Promise((resolve) => {
    const pipePath = `\\\\.\\pipe\\dsh-pet-probe-${process.pid}`
    const server = net.createServer((socket) => {
      socket.end('pong')
    })

    const finish = (ok, detail) => {
      try {
        server.close()
      } catch {
        // 关不掉不影响结论。
      }
      resolve({ ok, detail })
    }

    server.on('error', (cause) => finish(false, `建服务端失败 ${cause.code || cause.message}`))

    server.listen(pipePath, () => {
      const client = net.connect(pipePath)
      client.on('data', (data) => finish(data.toString() === 'pong', `收到 ${data.toString()}`))
      client.on('error', (cause) => finish(false, `连接失败 ${cause.code || cause.message}`))
    })
  })
}

/**
 * 子进程 + 管道 stdio。
 *
 * 这是 Chromium 与其子进程通信的同类操作，也是诊断脚本早期版本
 * 抓不到 stderr 的原因——PowerShell 的原生命令重定向走的就是这条路。
 *
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
function probePipedSpawn() {
  return new Promise((resolve) => {
    try {
      const child = spawn(process.execPath, ['-e', 'console.log("child-alive")'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      child.stdout.on('data', (chunk) => {
        out += chunk
      })
      child.on('error', (cause) => resolve({ ok: false, detail: `spawn 失败 ${cause.code || cause.message}` }))
      child.on('close', (code) =>
        resolve({ ok: out.includes('child-alive'), detail: `exit=${code} 输出=${out.trim() || '(空)'}` }),
      )
    } catch (cause) {
      resolve({ ok: false, detail: `spawn 抛出 ${cause.code || cause.message}` })
    }
  })
}

/**
 * 对照组：子进程 + stdio:ignore。
 *
 * 如果这一项通过而管道那项失败，就说明"进程创建"本身没问题，
 * 被拦的只是管道——这正是沙箱类限制的特征，而不是杀软拦可执行文件。
 *
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
function probeIgnoredSpawn() {
  return new Promise((resolve) => {
    try {
      const child = spawn(process.execPath, ['-e', 'process.exit(7)'], { stdio: 'ignore' })
      child.on('error', (cause) => resolve({ ok: false, detail: `spawn 失败 ${cause.code || cause.message}` }))
      child.on('close', (code) => resolve({ ok: code === 7, detail: `exit=${code}（期望 7）` }))
    } catch (cause) {
      resolve({ ok: false, detail: `spawn 抛出 ${cause.code || cause.message}` })
    }
  })
}

async function main() {
  const pipe = await probeNamedPipe()
  record('命名管道：建服务端并完整收发一轮', pipe.ok, pipe.detail)

  const piped = await probePipedSpawn()
  record('子进程：spawn + 管道 stdio', piped.ok, piped.detail)

  const ignored = await probeIgnoredSpawn()
  record('子进程：spawn + stdio:ignore（对照组）', ignored.ok, ignored.detail)

  console.log('')
  for (const item of results) {
    console.log(`  ${item.ok ? 'PASS' : 'FAIL'}  ${item.name}`)
    console.log(`        ${item.detail}`)
  }

  const pipeOk = pipe.ok && piped.ok
  console.log('')
  console.log('='.repeat(72))
  if (pipeOk) {
    console.log('结论：命名管道可用。')
    console.log('      当前环境能够支撑 Chromium 的多进程架构。')
    console.log('      如果 Electron 仍然起不来，问题不在环境，把诊断脚本的输出发出来。')
    process.exitCode = 0
  } else {
    console.log('结论：命名管道不可用 —— 这就是 Electron 起不来的根因。')
    console.log('')
    console.log('      Chromium 的浏览器进程必须通过命名管道与 GPU / 网络服务 /')
    console.log('      渲染进程通信。这条通道被拦，浏览器进程会在 app.whenReady()')
    console.log('      里崩溃，且发生在任何业务代码之前。')
    console.log('')
    console.log('      **任何 Electron 启动参数或版本都无法绕过它**，因为这不是')
    console.log('      Electron 的可选功能，而是 Chromium 在 Windows 上的 IPC 传输层。')
    console.log('')
    console.log('      能解决问题的方向只有一个：换一个没有这层限制的环境来运行。')
    console.log('      常见来源：受限令牌 / 低完整性级别的沙箱（如 DSH 的命令沙箱）、')
    console.log('      AppContainer 类隔离、以及带命名管道防护的 EDR。')
    if (ignored.ok && !piped.ok) {
      console.log('')
      console.log('      注意：对照组（stdio:ignore）通过而管道那项失败，说明进程创建')
      console.log('      本身没被拦，被拦的只是管道通道 —— 这排除了"杀软拦可执行文件"。')
    }
    process.exitCode = 1
  }
}

main()
