<div align="center">

# DeepSeek Token Pet

**一个基于 Electron 的 Q 弹桌面宠物，唯一功能是显示你的 DeepSeek 余额。**

用鼠标戳它会压扁回弹，可以拖来拖去、甩出去撞墙反弹，滚轮能放大缩小。
余额低了它会变成一脸担忧的样子——一个会呼吸的余额显示器。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933.svg)](https://nodejs.org)
[![Electron](https://img.shields.io/badge/electron-33-47848F.svg)](https://www.electronjs.org)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D6.svg)](#)

![demo](assets/demo.gif)

</div>

---

## 功能

| | 功能 | 说明 |
| --- | --- | --- |
| 🫧 | **Q 弹物理** | 点击压扁、挤压回弹、甩出后的拉长与倾斜，全部由弹簧积分实时生成，不是关键帧动画 |
| 🖱 | **拖拽与甩抛** | 跟手拖动、松手掉落、撞墙反弹；轻轻放下会留在原地，明显一甩才会飞出去 |
| 💰 | **实时余额** | 轮询 DeepSeek `/user/balance`，余额与情绪联动：充足是蓝色，告急变橙，耗尽变红 |
| 🖼 | **自定义图片** | 导入 PNG / JPG / GIF / WebP，**自动抠掉背景只留主体**，原图可随时切回 |
| 📌 | **系统托盘** | 隐藏/召回宠物、调出到指针所在屏幕、刷新余额、置顶、鼠标穿透、退出 |
| 🎨 | **滚轮缩放** | 在宠物上滚动即可放大缩小（150–420px），尺寸会被记住 |

> 宠物周围的透明区域**不会挡住下面的应用**：渲染进程用 `elementFromPoint`
> 做命中测试，主进程据此动态切换 `setIgnoreMouseEvents`。

---

## 快速开始

### 环境要求

- **Node.js ≥ 20**
- **Windows 10/11**（主要开发与测试平台；macOS / Linux 未验证）

### 安装与运行

```bash
git clone https://github.com/<your-name>/dsh-token-pet.git
cd dsh-token-pet
npm install
```

配置 API Key（二选一，**推荐第一种**）：

**① 系统环境变量**（密钥不落在项目目录里）

```powershell
# PowerShell，仅当前用户，需重开终端生效
[Environment]::SetEnvironmentVariable('DEEPSEEK_API_KEY', 'sk-你的密钥', 'User')
```

```bash
# bash / zsh
export DEEPSEEK_API_KEY=sk-你的密钥
```

**② 项目根目录的 `.env`**

```powershell
Copy-Item .env.example .env   # 然后编辑 .env 填入真实 Key
```

启动：

```bash
npm start
```

`npm start` 会先完整构建再启动。构建产物在 `dist/`，宠物窗口默认出现在屏幕右下角。

首次启动会在控制台看到：

```
[dsh-token-pet] 正在启动…
[dsh-token-pet] 日志文件：<用户数据目录>\pet.log
[dsh-token-pet] 窗口位置 (1276, 652)，尺寸 220×220；主显示器工作区 1536×912 @(0, 0)
[dsh-token-pet] 宠物窗口已显示（did-finish-load）
```

> **控制台里的中文是乱码？** 这是 Windows 命令行的代码页问题（Node 输出 UTF-8，
> cmd 按 GBK 显示），不影响运行。看日志文件即可，它是 UTF-8 的：
>
> ```powershell
> Get-Content "$env:APPDATA\dsh-token-pet\pet.log" -Encoding UTF8
> ```

---

## 配置

优先级：**默认值 < `pet.config.json` < 运行期状态（滚轮调过的尺寸）**

`pet.config.json` 放在项目根目录（打包版放在 exe 同级目录），全部字段可选：

```json
{
  "pollIntervalMs": 60000,
  "windowSize": 220,
  "alwaysOnTop": true,
  "clickThrough": false,
  "lowBalanceThreshold": 5,
  "warnBalanceThreshold": 20,
  "disableHardwareAcceleration": false
}
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `pollIntervalMs` | `60000` | 轮询间隔（毫秒），最小 10000 |
| `windowSize` | `220` | 窗口边长（DIP），滚动滚轮会覆盖它 |
| `alwaysOnTop` | `true` | 始终置顶 |
| `clickThrough` | `false` | 鼠标穿透 |
| `lowBalanceThreshold` | `5` | 低于此值显示"告急"（按人民币计，USD 按 7 折算） |
| `warnBalanceThreshold` | `20` | 低于此值显示"担忧" |
| `disableHardwareAcceleration` | `false` | 显卡驱动异常导致白屏时打开它 |

> API Key **不是配置项**：它属于机密，只从环境变量或 `.env` 读取，
> 不应该出现在一个可能被提交进版本库的 JSON 里。

---

## 使用

| 操作 | 效果 |
| --- | --- |
| 单击宠物 | 压扁 → 回弹 |
| 按住拖拽 | 跟手移动，精灵被"拉"出形变 |
| 轻轻放下 | 停在原地，并成为它的新「家」 |
| 快速甩出 | 沿甩出方向拉长，落地弹跳，停稳后弹回「家」 |
| 在宠物上滚动滚轮 | 放大 / 缩小（150–420px），尺寸会被记住 |
| 悬停宠物 | 顶部浮出工具栏：**换图** / **默认** |
| 右键宠物 | 导入图片 / 显示抠图 / 圆形裁剪 / 恢复默认 / 刷新余额 / 置顶 / 穿透 / 退出 |
| 右键托盘图标 | 显示或隐藏 / 把宠物叫回来 / 刷新余额 / 置顶 / 穿透 / 退出 |
| 双击托盘图标 | 把宠物叫回**指针所在显示器**的中央 |

### 自定义图片与自动抠图

导入图片后会自动去掉背景、只保留主体。算法是**纯本地的颜色泛洪 + 连通块筛选**，
零依赖、离线、瞬时完成（120×120 的图约 13ms）。

- **原图永远保留**，右键菜单的「显示抠图」可以随时切回去
- 抠不出来时不会把图弄坏：清除比例 < 4% 视为"没有背景"，> 96% 视为
  "把主体也吃掉了"，两种情况都**保留原图**并给出提示
- **GIF 跳过抠图**——`nativeImage` 只能解出第一帧，抠完会丢掉动画

> 适用场景是纯色或浅渐变背景的角色图。照片类的复杂背景抠不出来，
> 会保留原图并提示原因。

---

## 常见问题

### 运行后什么都没有出现

按顺序排查：

**① 桌面上的图片文件（`userData/pet.log`）里有没有 `宠物窗口已显示`？**

有 → 窗口存在过，问题在显示或可见性。
没有 → 进程根本没跑到窗口创建。

日志位置：

```powershell
Get-Content "$env:APPDATA\dsh-token-pet\pet.log" -Encoding UTF8
```

**② 是不是有旧实例还在跑？**

单实例锁会让**新启动的进程静默退出**，你操作的仍然是旧进程——如果旧进程是改动前
启动的，看起来就像"新代码没生效"。

```powershell
Get-Process electron -ErrorAction SilentlyContinue | Select-Object Id, MainWindowHandle
```

清理并重启：

```bash
npm run restart
```

**③ 余额显示不出来？**

先确认 Key 真的在当前终端里可见：

```powershell
$env:DEEPSEEK_API_KEY
```

没有输出就是没配好。日志里出现 `no-credential` 就是这个问题。

---

### Windows 下 Electron 秒退，退出码 `-2147483645`（`0x80000003`）

**典型症状**：`npm start` 之后什么都没发生，**没有任何输出**，`userData` 目录
也不创建，退出码是 `0x80000003`（`STATUS_BREAKPOINT`）。但**同一个 `electron.exe`
复制到别的目录就能正常运行**。

**根因：工作区被打上了「低完整性标签」。**

某些安全软件或沙箱工具会给目录打上强制完整性标签：

```powershell
icacls "你的项目目录" | Select-String "Mandatory Label"
```

如果看到 `Mandatory Label\Low Mandatory Level`，那么整个目录树（包括
`node_modules\electron\dist\electron.exe`）都继承了这个标签，而 **Chromium 拒绝从
这样的位置启动**，于是它在执行任何 JS 之前就 CHECK 失败。

用完整性标签可以这样自查：

```powershell
icacls "node_modules\electron\dist\electron.exe" | Select-String "Mandatory Label"
```

**修复：运行内置脚本**（不需要管理员权限）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\fix-integrity-block.ps1
```

脚本做两件事：

1. 把 Electron 运行时整体移到没有标签的位置（默认 `C:\electron-runtime`）
2. 在原路径建立目录联接（junction）指回去

之后 `npm start`、`npx electron .`、构建命令**全部照旧**，路径不用改。

之所以有效：目录联接是重解析点，通过它访问到的文件对象实际位于目标卷上，
带的是目标卷的标签，因此没有那个 Low 标签。

指定其他位置：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\fix-integrity-block.ps1 -RuntimePath D:\electron-runtime
```

> **为什么不是直接改标签？** `icacls /setintegritylevel` 需要 `SeSecurityPrivilege`
> （管理员权限），普通终端会报 Access denied。上面的方案不需要提权。

> **已经被排除的方向**（有实测证据，遇到同类问题不必再试）：杀毒软件拦截、
> Chromium 命名管道、Electron 版本、全局注入（AppInit_DLLs / IFEO）、
> 目录 ACL 规则本身。详见 [docs/DESIGN-NOTES.md](docs/DESIGN-NOTES.md)。

---

### 还有其他问题？

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\diagnose.ps1
```

三步定位：环境与运行时检查 → 最小 Electron 应用 → 真实应用启动，并打印失败时的退出码。

---

## 打包

```bash
npm run pack      # 只生成未压缩目录，快速验证打包结果
npm run dist      # 生成 Windows 安装包，输出到 release/
```

配置见 [`electron-builder.yml`](electron-builder.yml)。两点需要注意：

- 打包前必须已执行 `npm run build`（`npm run dist` 已串好这一步）
- 打包版是 asar 归档，`app.getAppPath()` 不可写，因此 `pet.config.json`
  会从 **exe 同级目录**读取

自定义图标放在 `build/icon.ico`（256×256）。没有时会退回默认的 Electron 图标，
不影响打包成功。

---

## 开发

```bash
npm run typecheck   # 跨进程共享的类型检查
npm run build       # 完整构建（主进程 / preload / 渲染进程 / DSH 插件）
npm run watch       # 只监听主进程的 tsc
```

### 目录结构

```
src/
├─ main/       主进程：窗口、物理引擎、托盘、图片与抠图、IPC
├─ preload/    contextBridge 白名单 API
├─ renderer/   渲染进程：Q弹精灵、余额徽章、工具栏
├─ data/       数据层：凭据链、余额客户端、轮询器
├─ shared/     跨进程共享的类型与纯函数
└─ dsh/        DSH 插件入口（把余额查询注册成一个工具）
```

架构细节、物理参数、以及大量"为什么这么写"的说明在
**[docs/DESIGN-NOTES.md](docs/DESIGN-NOTES.md)**，其中记录了若干实测确认的
平台坑（高 DPI 下窗口尺寸漂移、透明窗口的 `setBounds`、精灵滞后的 HUD 跟随等）。

### 隐私与安全

发布前务必跑一遍自检：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\security-check.ps1
```

它会报告：硬编码密钥、本机绝对路径泄露、`.gitignore` 是否真的拦住了
`.env` / 日志 / 构建产物、以及 git 历史里有没有已被跟踪的敏感文件。
任何 `[FAIL]` 都会让脚本以退出码 1 结束，可以直接接进 CI。

**日志默认脱敏**：所有 `console.*` 输出在写盘前会把 `sk-` 密钥、
`Bearer` 令牌、`*_API_KEY=...` 一类键值对打码（保留 `sk-` 与前 4 位便于自查，
其余替换成固定长度的星号）。控制台与日志文件走同一条管线，所以截图或复制
终端输出也不会泄露完整 Key。

---

## 许可

[MIT](LICENSE)。使用它意味着你会把 API Key 放在本机——请自行保管好，
本项目不会把 Key 发送到 DeepSeek 官方接口以外的任何地方。
