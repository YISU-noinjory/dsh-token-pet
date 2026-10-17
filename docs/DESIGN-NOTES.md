# dsh-token-pet

一个 Q 弹的桌面宠物，实时显示你的 DeepSeek API Token 余额。

技术栈：**TypeScript + Electron + DSH Plugin SDK（Cordis）**。

---

## 1. 文件结构

```
dsh-token-pet/
├─ package.json
├─ cordis.patch.yml               # DSH bundle 补丁：向 profile 插入 token-pet 行
├─ tsconfig.json                  # 全量类型检查（不含 src/dsh）
├─ tsconfig.main.json             # 主进程 + 数据层 → CommonJS
├─ tsconfig.dsh.json              # DSH 插件入口的类型检查
├─ vite.config.ts                 # 渲染进程打包
├─ vite.preload.config.ts         # preload 打包（必须单文件 CJS）
├─ vite.dsh.config.ts             # DSH 插件打包（必须单文件 ESM）
└─ src/
   ├─ shared/                     # 三边共享，只放纯类型与纯函数
   │  ├─ types.ts                 # 余额领域模型、状态机、运动帧
   │  ├─ ipc.ts                   # IPC 频道常量 + PetBridge 契约
   │  └─ config.ts                # 默认设置、情绪推导、金额格式化
   │
   ├─ main/                       # ① 主进程：窗口与世界
   │  ├─ index.ts                 # 应用生命周期、子系统装配、菜单、协议与显示器变化
   │  ├─ pet-window.ts            # 透明/无边框/置顶窗口、命中穿透控制、显示与隐藏
   │  ├─ window-physics.ts        # 拖拽跟随、甩抛惯性、重力、撞墙反弹、回位、召回
   │  ├─ pet-image.ts             # 自定义图片：选择、校验、复制、持久化、协议投递
   │  ├─ pet-image-files.ts       # 纯函数：格式魔数识别 + 受管路径守卫
   │  ├─ tray.ts                  # 托盘图标与菜单（唯一常驻可见入口）
   │  ├─ tray-icon.ts             # 内嵌的托盘图标资源
   │  └─ ipc-handlers.ts          # IPC 注册与载荷校验
   │
   ├─ preload/
   │  └─ index.ts                 # contextBridge 暴露白名单 API
   │
   ├─ data/                       # ③ 数据层
   │  ├─ credentials.ts           # API Key 解析链（显式 → env → .env → DSH）
   │  ├─ balance-client.ts        # /user/balance 客户端与响应解析
   │  └─ balance-poller.ts        # 轮询调度、退避、状态机
   │
   ├─ renderer/                   # ② 渲染进程：形变与展示
   │  ├─ index.html
   │  ├─ style.css
   │  ├─ main.ts                  # 装配、事件分发、命中测试
   │  ├─ pet/
   │  │  ├─ physics.ts            # 弹簧积分器、体积守恒、速度采样
   │  │  └─ pet.ts                # 宠物实体：把物理状态翻译成形变
   │  └─ ui/
   │     ├─ balance-badge.ts      # 余额徽章渲染
   │     └─ pet-image-picker.ts   # 自定义图片的按钮、图片替换与错误气泡
   │
   └─ dsh/
      └─ plugin.ts                # DSH 插件入口：注册 pet_balance 工具
```

### 三条边界

| 边界 | 谁负责 | 为什么这样切 |
| --- | --- | --- |
| 窗口**在哪** | 主进程 `window-physics.ts` | 只有主进程拿得到 `screen` 的工作区（多显示器、任务栏高度），且只有它能改窗口位置 |
| 宠物**长什么样** | 渲染进程 `pet.ts` | 形变需要跟手，跨进程会慢一帧 |
| 余额**是多少** | 数据层 `data/*` | 与显示解耦，Electron 与 DSH 插件共用同一份实现 |

---

## 2. 快速开始

```bash
npm install                 # 需要网络下载 Electron 二进制
npm run build
npm start
```

配置 API Key（二选一）：

```bash
# 方式 A：环境变量
setx DEEPSEEK_API_KEY "sk-xxxxxxxx"

# 方式 B：项目根目录的 .env
echo DEEPSEEK_API_KEY=sk-xxxxxxxx > .env
```

可选：项目根目录放 `pet.config.json` 覆盖默认设置。

```json
{
  "pollIntervalMs": 60000,
  "windowSize": 220,
  "alwaysOnTop": true,
  "clickThrough": false,
  "lowBalanceThreshold": 5,
  "warnBalanceThreshold": 20
}
```

> `pet.config.json` 里**刻意不支持**写 API Key：密钥属于机密，应该走环境变量或系统钥匙串，
> 而不是一个很容易被提交进版本库的 JSON 文件。

### 交互

| 操作 | 效果 |
| --- | --- |
| 单击 | 压扁 → 回弹（弹簧过冲） |
| 按住拖拽 | 跟手；窗口位移，精灵滞后，被"拉"出形变；拖到屏幕边缘会被边界挡住 |
| 轻轻放下 | 停在原地，并成为新的「家」——不会坠落，4 秒后也不会被弹回原处 |
| 快速甩出 | 沿甩出方向拉长，落地弹跳，速度衰减后停稳，停留 4s 后弹回「家」 |
| 双击 | 弹回初始位置 |
| 悬停宠物 | 顶部浮出工具栏：**换图** / **默认** |
| 右键宠物 | 原生菜单：导入或更换图片 / 显示抠图 / 圆形裁剪 / 恢复默认宠物 / 刷新余额 / 置顶 / 鼠标穿透 / 退出 |
| 右键托盘图标 | 显示或隐藏宠物 / 把宠物叫回来 / 立即刷新余额 / 置顶 / 鼠标穿透 / 退出 |
| 双击托盘图标 | 把宠物叫回**指针所在显示器**的中央 |
| **在宠物上滚动滚轮** | 放大 / 缩小（150–420px），尺寸会被记住 |
| 悬停徽章 | tooltip 显示币种明细、数据来源与读数时间 |

宠物周围的透明区域**不会挡住底下的应用**：渲染进程用 `elementFromPoint`
做命中测试，主进程据此动态切换 `setIgnoreMouseEvents`。

### 托盘图标

宠物窗口没有边框、没有任务栏入口，也可能被别的全屏窗口盖住。托盘（[tray.ts](src/main/tray.ts)）
是它**唯一的常驻可见入口**——用来把宠物叫回来、隐藏它、或者明确退出，
不必再去任务管理器。

几个设计点：

- **召回居中到「指针所在显示器」**而不是主显示器：多屏时用户的眼睛在哪块屏上，
  就希望宠物出现在哪块屏上。用 `moveTo` 直接落位，不做弹簧动画——按这个菜单项
  是要立刻看到宠物，不是看它表演一段飞行。
- **隐藏不等于退出**：`hide()` 不销毁窗口，所以 `window-all-closed` 不会触发、
  进程继续活着、余额照常轮询。这也是"隐藏宠物"和"退出"的区别。
- **菜单每次状态变化后重建**：第一项的文案（显示/隐藏）和两个勾选项都取决于当前状态，
  而 Windows 的托盘菜单是 `setStaticContextMenu` 式的静态对象。重建用 `setImmediate`
  推迟到当前事件派发之后，避免在菜单自己的回调里改动正在派发的菜单。
- **图标内嵌为 base64**（[tray-icon.ts](src/main/tray-icon.ts)）：主进程由 `tsc` 编译到
  `dist/main`，外置图片需要额外一步拷贝并处理路径差异。32×32 的图只有 1.4KB，
  内嵌后直接消掉"资源没被复制过去"这一整类失败模式。

### 显示器变化

拔掉显示器、改分辨率或改缩放比例之后，窗口可能停在**已经不存在的坐标**上——
表现就是"宠物不见了"，而进程和窗口其实都还在。`index.ts` 监听
`display-metrics-changed` / `display-added` / `display-removed` 做两件兜底：

1. `physics.ensureOnScreen()` 把窗口收拢回最近的可见工作区（不需要指定哪块屏：
   `getDisplayNearestPoint` 会返回离它最近的那块）；
2. 如果原来的「家」已经不在任何屏幕上，就把锚点改到当前位置——否则
   "停稳后自动归位"会把宠物送回一个看不见的坐标。

---

## 3. 各模块要点

### 3.1 主进程：透明置顶窗口

关键配置与原因（`src/main/pet-window.ts`）：

- `transparent + backgroundColor: '#00000000'`：真透明，否则 Windows 上是一块黑底。
- `hasShadow: false`：透明窗口保留系统阴影会露出矩形边界。
- `frame: false + resizable: false`：透明窗口的缩放边框在 Windows 上有绘制残影。
- `skipTaskbar: true`：桌宠不该占任务栏位置。
- `backgroundThrottling: false`：**必须**。窗口失焦时 Chromium 把 rAF 降到 1Hz，呼吸动画会直接卡死。
- `setAlwaysOnTop(true, 'screen-saver')`：用 `'floating'` 会被全屏应用盖住。

#### 移动窗口必须用 `setBounds`，不能用 `setPosition`

这不是风格问题，而是一个实测确认的平台陷阱。

在 **125% 缩放的 Windows** 上，透明无边框窗口每调用约两次 `setPosition`，窗口
就会自己长大约 1px——DPI 往返（DIP → 物理 → DIP）的取整误差被累积到了
**尺寸**上，而且**不会缩回去**。实测：

```
创建后            223x223      （请求 220）
setPosition × 60  283x283      （涨了 60px）
setBounds  × 60   220x220      （精确，不漂移）
```

物理引擎拖拽时以 125Hz 调用移动，所以**每拖一次窗口就长大几十像素并永久保留**。
用户看到的现象是「拖得越久，余额徽章和工具栏离宠物越远」：徽章钉在窗口底边、
工具栏钉在顶边，而宠物始终在窗口里居中，窗口一大，上下两边就同时分开。反复
拖拽会不断累积，最后宠物变成一个大透明窗口中央的小点。

所以 `pet-window.ts` 里保存了固定的 `#size`，每次移动都显式写回：

```ts
this.#window.setBounds({ x, y, width: this.#size, height: this.#size })
```

创建后也立刻用 `setBounds` 校正一次初始尺寸，把那个 223 拉回 220。

实测修复前后（拖拽 8 步，每步 45px）：

| | 静止 | 拖拽中 | 松手后 |
| --- | --- | --- | --- |
| 修复前 窗口尺寸 | 223×223 | 232×232 | 232×232（不恢复） |
| 修复后 窗口尺寸 | 220×220 | 220×220 | 220×220 |
| 修复前 上下间隙 | 97.5 / 95.6 | 100.5 / 101.4 | 102 / 99.9 |
| 修复后 上下间隙 | 95.9 / 94.0 | 94.6 / 95.4 | 96 / 93.9 |

### 3.2 窗口物理：甩抛与反弹

`window-physics.ts` 是一个不依赖 Electron 的模拟器（几何与光标通过回调注入，可单测）。

- **拖拽跟随**用 `screen.getCursorScreenPoint()`，而不是渲染进程的 `MouseEvent.screenX`。
  后者是 CSS 像素，在多显示器不同缩放比下与 `setPosition` 的 DIP 坐标系不一定同源，
  会造成宠物随显示器漂移，且只在特定硬件上复现。
- **拖拽要约束边界**。窗口位置 = 光标 − 抓取偏移，抓取点越靠近宠物左上角，
  窗口就越贴近光标；光标顶到屏幕边缘时窗口会有一大截被推到屏幕外，
  用户看到的就是"宠物滑出去了"。自由飞行本来就有边界反弹，只有拖拽这条路漏了。
  边界取**所有显示器工作区的并集**而不是单块屏：用"窗口所在的那块显示器"会把窗口
  夹在 A 屏右边缘、中心永远够不到边界，**跨屏拖拽直接卡死**；并集则允许窗口在相邻
  显示器之间自由移动，同时挡住最外侧的越界。
- **积分**按实际耗时拆成 ≤ 1/240s 的子步（半隐式欧拉），并对 dt 限幅 0.1s，
  防止系统休眠唤醒后宠物瞬移出屏幕。
- **反弹**基于光标所在显示器的 `workArea`，左右墙不损失能量，地面额外施加摩擦，
  否则宠物会在地面上永远滑下去。
- **停稳后自动归位**：速度低于阈值 → 原地停留 4s → 弹簧拉回锚点。
- **松手时区分「放下」与「甩出」**（阈值 400px/s）。低于阈值视为**有意放置**：
  宠物停在原地，并把落点设为新的「家」。高于阈值才是甩抛，交给物理去飞、去弹。
  不区分这两者会产生一个很反直觉的行为——用户轻轻把宠物挪个位置、松手，
  它也会立刻自由落体摔到屏幕底部，**无论放得多小心都一样**。
  把落点设为新家同样必要：否则 4 秒后"停稳自动归位"会把它弹回原处，
  用户会觉得"我明明放好了它自己又跑了"。

### 3.3 渲染进程：Q 弹从哪来

Q 弹**不是关键帧动画**，而是"精灵与窗口之间的速度差"：

1. 主进程每帧推送 `MotionFrame{position, delta, velocity}`；
2. `pet.ts` 把 `delta` 反向加到滞后弹簧上（窗口动了，精灵还没跟上）；
3. 弹簧把滞后量拉回 0，于是产生"追上来"的回弹；
4. 滞后量同时驱动倾斜角，速度驱动沿运动轴的拉伸。

形变遵守**体积守恒**：`scaleX` 由 `scaleY` 的**当前值**推出（不是目标值），
否则两个轴会错开到位，压缩看起来是"错位"的而不是"被压扁"的。

撞击用**冲量**而不是改目标值：冲量作用于速度，弹簧会先压过头再弹回来——
这正是"砸在地上"的观感；直接改 target 只会得到一个平滑位移，毫无冲击力。

静止时跳过 DOM 写入（弹簧收敛后每帧 transform 完全相同），避免白耗电。

#### 余额徽章与工具栏必须跟着精灵一起走

它们相对**窗口**绝对定位，而精灵有自己的滞后偏移。拖拽时窗口快速移动，
滞后弹簧会被推到上限（26px）并**在整个拖拽过程中保持在那里**——所以这不是
一闪而过的偏差，而是持续可见的错位。实测（DevTools 协议量的真实几何）：

| | 上间隙（宠物顶 − 工具栏底） | 下间隙（徽章顶 − 宠物底） |
| --- | --- | --- |
| 静止 | +19.5px | +17.6px |
| 精灵滞后 26px，**不跟随** | +45.5px | **−8.4px**（精灵压在徽章上） |
| 精灵滞后 26px，**跟随** | +19.5px（不变） | +17.6px（不变） |

做法是 `pet.ts` 每帧把滞后量写进舞台的 CSS 变量，徽章/工具栏/气泡的
`transform` 里加上它们：

```css
transform: translate(calc(-50% + var(--pet-lag-x, 0px)), var(--pet-lag-y, 0px));
```

`-50%` 是自身的水平居中，必须与滞后量**相加**，不能拆成两条 `transform`——后者会互相覆盖。

只跟随平移、不跟随缩放与旋转：文字被拉伸或旋转会很难看，而平移是拖拽中
唯一持续的那个分量。倾斜（≤14°）与拉伸（≤21%）因此仍会有轻微的瞬时错位，
但它们只在你快速拖动时出现、停下即消失。

#### 滚轮缩放：单一真相是「窗口尺寸」

在宠物上滚动滚轮可以把它放大或缩小（150–420px）。精灵的视觉大小**不单独存一份**，
而是完全由窗口边长推出来：

```
--pet-scale = 窗口边长 / PET_DESIGN_SIZE
```

滚轮只负责请求一个新的窗口边长 → 主进程改窗口 → 渲染进程收到 `resize` →
更新 CSS 变量 → 精灵跟着变。比例只有一个来源，所以不会出现"窗口变了精灵没变"
这种两边不一致。

几个具体的选择：

- **按比例步进（每格 5%）而不是固定像素**：在 150px 和 400px 时，一格的
  "手感变化量"才一致。固定 20px 在小尺寸下显得粗暴、在大尺寸下显得迟钝。
- **缩放做在内层 `.pet-inner`，不是 `.pet-body`**。后者每帧被 JS 重写 transform，
  会被覆盖；而且它的 `transform-origin` 是**底部**（挤压要贴着地面），
  从底部缩放会让宠物朝上长而不是原地变大。
- **窗口保持中心不动地缩放**（`pet-window.ts` 的 `setSize`）。若钉住左上角，
  每次放大都朝右下角长出去，反复缩放后宠物会一点点挪到屏幕边缘。
- **缩放后要让物理引擎重新对齐**（`refreshGeometry`）：它缓存了窗口尺寸用于
  边界夹取，还持有自己的浮点位置和"上一帧位置"。不同步会有两个后果——
  夹取按旧尺寸算（大尺寸时能越界），以及下一帧算出一大截 `delta`，
  精灵会被滞后量猛地拉一下。
- **透明四角不响应**：只在指针真的压在宠物本体上时缩放。虽然命中测试通常
  已把窗口设为穿透，但拖拽期间整块窗口都是可交互的，那时四个角也会收到滚轮。

尺寸会写进 `userData/pet-settings.json`（**不是** `pet.config.json`——后者是
应用根目录里的配置，打包成 asar 后只读，而且不该把随手调出来的数值写进配置）。
滚轮一次滚动会连发十几二十次补丁，写盘用 400ms 防抖，退出前再补一次刷盘。

优先级：`默认值 < pet.config.json < pet-settings.json`。运行期状态排最后，
因为它是用户最近一次明确操作的结果，否则调完尺寸重启又变回去，会让人以为功能坏了。

### 3.4 数据层：轮询策略

调度按错误的**可重试性**分流，而不是无脑重试：

| 错误分类 | 策略 |
| --- | --- |
| `network` / `server` | 指数退避 + ±20% 抖动，上限 5 分钟 |
| `rate-limited` | 优先遵循服务端 `Retry-After`，否则退避 |
| `unauthorized` / `no-credential` / `malformed` | 慢速重试（停在退避上限），等待用户修配置 |

「慢速重试」而非「停止」：用户补上 `.env` 或换 Key 后宠物应该自己恢复，不需要重启。

其它要点：

- 金额一律保留服务端返回的**十进制字符串**，不做 `Number` 转换（会破坏精度）。
- 失败时保留 `staleSnapshot`，UI 降级为"灰显 + 标注读数时间"，而不是清空。
- 状态用可辨识联合表达 `refreshing`（刷新中且旧值可用），而不是 `{data, loading, error}` 三件套。
- 凭证每次请求前重新解析，换 Key 无需重启。

### 3.5 安全

- 渲染进程 `contextIsolation: true` + `sandbox: true` + `nodeIntegration: false`。
- preload **不暴露 `ipcRenderer` 本身**，只暴露固定方法；频道名全部来自常量，
  杜绝"主进程改了名、preload 还用旧字符串"的静默失效。
- 所有 IPC 入参白名单校验：释放速度会被限幅（一个 `Infinity` 能让窗口飞出屏幕且找不回来）；
  设置补丁逐字段过滤，不用 `Object.assign`。
- CSP `default-src 'none'`，余额数字即使被注入也无法执行脚本。
- 总览视图 `npm run typecheck` 与 DSH 插件分别配置，插件的 peer 依赖不污染主工程。

### 3.6 自定义宠物图片

支持 PNG / JPG / JPEG / GIF / WebP。入口有两个：悬停宠物后顶部浮出的**换图**按钮，
以及右键菜单的**导入宠物图片…**——两者调用的是主进程里同一份实现。

**流程**：`dialog.showOpenDialog` → 校验 → 复制到 `userData/pet-images/` →
**自动抠图** → 写入 `userData/pet-image.json` → 通过自定义协议投递给渲染进程。

#### 导入时自动抠图，只留主体

导入的图片会**自动去掉背景**，只保留人物主体。原图永远保留，右键菜单的
**显示抠图（去掉背景）** 可以随时在两者之间切换——抠坏了切回去就行。

**为什么不用 AI 模型**：人像分割要 ~40MB 模型 + ONNX/WASM 运行时、首次还要联网，
而桌宠图片绝大多数是**纯色或浅渐变背景的角色图**，颜色泛洪已经够好，且瞬时、离线、零依赖。

算法（[pet-matting.ts](src/main/pet-matting.ts)，不依赖 Electron，可单独测试）：

1. 取四边像素的平均色作为背景参考色；
2. 从四边泛洪填充，颜色接近参考色的连通区域判为背景；
3. 对剩余像素做连通块标记，**只保留最大主体**（以及不小于它 5% 的附属块，
   避免把分离的手或道具误删；小于整图 0.05% 的碎屑一律清掉）；
4. 边界一圈按"与背景色的接近程度"给半透明，消除硬切边的锯齿。

**两道安全阀比算法本身更重要**。泛洪是启发式的，遇到复杂背景必然失败；
失败不可怕，**可怕的是把主体抠没了还当成成功**：

| 情况 | 判据 | 处理 |
| --- | --- | --- |
| 没找到背景（图已抠好 / 全是主体） | 清除比例 < 4% | 不做处理，保留原图 |
| 把主体一起吃掉了 | 清除比例 > 96% | 放弃，保留原图 |
| 四边本来就大面积透明 | 边框不透明率 < 72% | 不做处理 |

上限定在 96% 而不是更保守的 88%：桌宠图里人物常常只占画面 10–20%，
背景占 85% 以上完全正常，门槛压太低会让大量正常图片被判失败、抠都不抠。
（这个数字是被测试逼出来的——最初写 88%，两个"正常小主体"的用例直接被判失败。）

几个实现细节：

- **BGRA 裸像素、在主进程算**，不走 canvas。渲染进程的图片经自定义协议加载，
  放进 canvas 再 `getImageData` 会因跨源而污染。主进程用 `nativeImage.toBitmap()`
  拿到的就是裸 BGRA，`createFromBitmap().toPNG()` 编码回去，全程没有跨源问题。
- **半透明像素必须预乘 alpha**。Skia 的位图是预乘格式，直接写非预乘颜色会让
  边缘在合成时偏亮。
- **GIF 跳过抠图**：`nativeImage` 只能解出第一帧，抠完会把动图变成静态图，
  宁可不动。
- **抠图失败不阻断导入**：状态照常提交，只是没有抠图产物；界面用气泡说明原因
  （"没找到可去除的背景" / "背景与主体太接近，为避免误删已保留原图"），
  否则功能看起来就是坏的。

`importFromPath` 是从 `select` 里拆出来的公开入口：选择框是模态的、自动化点不到，
拆开后"校验 → 复制 → 抠图 → 提交"整条链可以脱离它被端到端测试。

#### 渲染进程拿不到文件路径

直觉做法是把绝对路径交给渲染进程再拼 `<img src="file:///C:/...">`。这条路在本项目里走不通：

1. **`file://` 页面引用 `file://` 子资源不可靠。** 生产环境用 `loadFile` 加载
   `dist/renderer/index.html`，页面本身就是 `file://` 源，再引另一个 `file://` 资源，
   行为随平台与 Electron 版本漂移。要让它稳定就得关掉 `webSecurity`，
   那是拿整个应用的安全性换一个 `src`。
2. **绝对路径是多余的信息面。** 它一旦进了 DOM，就会出现在 devtools、
   截图、以及任何渲染进程被注入后的读取面上。

所以主进程注册了自定义协议 `pet-image:`，URL 恒为 `pet-image://current/?v=N`
（`v` 只是换图后的缓存破坏标记）。**协议处理函数永远只投递"当前图片"，
请求 URL 的任何部分都不参与文件选择**——路径穿越在这个设计里不是被过滤掉了，
而是根本没有攻击面。

#### 校验用文件头魔数，不看扩展名

把 `malware.exe` 改名成 `cat.png` 是最省事的伪装，所以判定依据是**文件内容**：

- PNG `89 50 4E 47 0D 0A 1A 0A`；JPEG `FF D8 FF`；GIF `47 49 46 38`；
  WebP 需要 `RIFF` **加上** 偏移 8 处的 `WEBP`（只查 `RIFF` 会把 WAV/AVI 也放进来）。
- 体积上限 20MB。这个值放得下合理的动图，又能在误选几百 MB 素材时立刻拦下——
  这张图每帧都在参与 Q弹形变，不该让解码拖垮合成器。

格式识别与路径守卫放在 [pet-image-files.ts](src/main/pet-image-files.ts)——
一个**不依赖 Electron** 的纯函数模块，因此可以脱离 Electron 单独测试
（12 项：四种真实格式识别、改名伪装拒绝、WAV 拒绝、路径穿越与绝对路径拒绝）。

#### Q弹与图片的分层

```
.pet-body   ← JS 写 transform（滞后 / 挤压 / 倾斜）
  .pet-inner  ← CSS keyframes 做呼吸
    .pet-photo  ← 只负责 object-fit: contain，不参与任何变换
```

图片在最内层，所以"Q弹作用于外层容器"是**结构上保证**的，而不是靠约定。
`object-fit: contain` 保持宽高比完整显示；用 `cover` 会在非正方形图片上裁掉头脚，
用 `fill` 会让 Q弹的 scale 叠加出难看的比例失真。

#### 关于素材本身的三个实际约束

| 情况 | 表现 | 建议 |
| --- | --- | --- |
| **JPG** | 没有 alpha 通道，导入后是一块白底矩形 | 用右键菜单的**圆形裁剪**把它变成圆形头像（白底就成了头像底色）；或者改用 PNG |
| **尺寸** | 非 512×512 不会被拒绝，但过大只是徒增解码成本 | 用 512×512 并保持比例。显示区只有 132×132，超出部分不会被看到 |
| **GIF / WebP 动图** | 能导入，Q弹与动图叠加确实有趣 | 大尺寸动图每帧都要解码，而它同时还在参与形变；20MB 上限是硬保护，但仍建议压到 512×512 |

#### 悬停工具栏为什么要自己算显隐

指针从宠物移向按钮时**会离开宠物本体**。如果显隐只用 `.pet-body:hover` 判断，
工具栏会在指针到达按钮之前就消失，按钮永远点不到。

所以显隐由 [main.ts](src/renderer/main.ts) 的指针处理统一驱动，条件是
「指针在宠物上**或已经在工具栏上**」。这个条件能收敛，靠的是
`document.elementFromPoint` 会跳过 `pointer-events: none` 的元素：
工具栏隐藏时不可命中（指针在它上方只命中舞台，于是保持隐藏），
一旦因悬停宠物而显示就变为可命中，指针移过去后条件成立，工具栏不消失。

顺带地，"看不见的工具栏不挡桌面点击"也是免费得到的——不需要额外判断。

### 3.7 DSH 插件入口

`src/dsh/plugin.ts` 是标准 Cordis 插件形态：`name` / `inject` / `Config` / `apply`，
注册一个模型可调用的 `pet_balance` 工具。你在 DSH 里直接问「我 DeepSeek 还剩多少钱」即可。

它**复用 `src/data/*`**，而不是另写一份 `fetch`：

- 接口地址、字段映射、错误分类、退避策略只有一份实现；
- DeepSeek 改字段名时两边一起坏，而不是"宠物好了、工具还错着"。

凭证走宿主服务：`ctx.credentials.resolve(credentialRef('DEEPSEEK_API_KEY'))`，
因此你在 DSH 里配置的 Key 会自动被宠物复用，不必两处各配一次。

#### 安装到 profile

```bash
npm run build:dsh                                  # 产出 dist/dsh/plugin.mjs
dsh plugin --profile <profile> add <项目目录>  # 装进目标 profile
dsh --profile <profile> --dump-config              # 不启动，只验证组合树里出现了 token-pet
```

`--dump-config` 是关键一步：它在**不启动** profile 的前提下打印组合后的插件树，
可以在真正重启 DSH 之前确认插件已经挂上。

#### 为什么插件入口要打包成单个 ESM 文件

三个约束叠在一起，只有打包器能同时满足（见 [vite.dsh.config.ts](vite.dsh.config.ts)）：

1. **必须是 ESM。** Cordis 加载器用 `import()` 加载 bundle 行，而本仓库根
   `package.json` 没有 `"type": "module"`，tsc 产出的 `.js` 会被 Node 当成 CommonJS。
   产物用 `.mjs` 明确表达 ESM，不必在 `dist` 里再塞一个 `package.json`。
2. **必须自带共享模块。** 插件要用 `shared/config` 的情绪推导与金额格式化、
   `data/balance-client` 的余额客户端。这些在 `dist/shared`、`dist/data` 里是 CommonJS，
   ESM 入口跨目录引 CJS 产物既脆弱又难排查；打包内联后产物自洽。
3. **`@deepseek-ai/*` 必须保持外部依赖。** 绝不能内联 `dsh-tools` / `dsh-llm`：
   那些包里用 `instanceof HarnessError` 之类的跨模块身份判断，内联会产生第二份类，
   宿主侧的 `instanceof` 会**静默**失败。外部化后由 Node 从 `node_modules` 解析，
   与宿主共享同一份模块实例。

#### bundle 声明

DSH 只接受**声明了 bundle 的包**：`dsh plugin add` 读不到 bundle 补丁会直接回滚。
本包的声明在 [package.json](package.json) 的 `dsh.bundle.patch`，指向
[cordis.patch.yml](cordis.patch.yml)——那里只有一条 `insert`，往组合树里插一行
`token-pet`，行的 `name` 走 `exports["./dsh-plugin"]`。

#### 改配置

不要改 `cordis.patch.yml`——那是 bundle 自带的默认层，升级本包时会被覆盖。
在 profile 的 `cordis.patch.yml` 里按 `id: token-pet` 覆盖，或用 Web 侧栏的
Plugins 页面切换，两者优先级都在 bundle 层之上：

```yaml
- id: token-pet
  config:
    toolCacheTtlMs: 60000
```

编译依赖 peer 包 `@deepseek-ai/{cordis,dsh-tools,dsh-llm,dsh-credentials,schemastery}`，
版本必须与 DSH 运行时对齐（本机为 cordis `~4.0.4`、schemastery `~3.18.4`、
`dsh-*` 精确 `0.2.0-rc.2`）。DSH 在安装前会用**运行时版本**校验这些区间，
不匹配会拒绝安装且不下载任何东西。`src/dsh` 因此在默认 `typecheck` 里被排除，
需用 `npm run typecheck:dsh` 单独检查。

---

## 4. 脚本

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 主进程（tsc）→ preload（Vite）→ 渲染进程（Vite）→ DSH 插件（Vite） |
| `npm run build:dsh` | 只重建 DSH 插件入口到 `dist/dsh/plugin.mjs` |
| `npm run typecheck` | 全量类型检查（不含 DSH 插件） |
| `npm run typecheck:dsh` | 仅检查 DSH 插件（需先装 peer 依赖） |
| `npm start` | build 后启动 Electron |
| `npm run watch` | 主进程增量编译 |
| `node scripts\probe-ipc.cjs` | 探测环境能否支撑 Chromium 的多进程架构（不启动 Electron） |
| `powershell -File scripts\diagnose.ps1` | 启动诊断：二进制自检 + 两次启动尝试 + 父进程链 |
| `powershell -File scripts\collect-crash-info.ps1` | 从事件日志/WER 取崩溃模块，并检查安装完整性与注入点 |
| `powershell -File scripts\fix-integrity-block.ps1` | 修复工作区低完整性标签导致的启动失败（不需管理员） |

---

## 5. 故障排查：运行后看不到宠物

桌宠没有任务栏入口、也没有 DevTools，所以失败默认是**静默**的。

### 5.1 先判断环境能不能跑 Chromium

```powershell
node scripts\probe-ipc.cjs
```

这一步**不启动 Electron**，5 秒出结果，测的是根因。Chromium 的浏览器进程必须通过
**命名管道**（Windows 上 Mojo 的传输层）与 GPU / 网络服务 / 渲染进程通信。管道不通，
浏览器进程会在 `app.whenReady()` 里崩溃——而这发生在任何业务代码之前。

| 探测结果 | 含义 |
| --- | --- |
| 三项全 PASS | 环境没问题，往下看 5.2 |
| 命名管道 FAIL（`EPERM`）+ 对照组 PASS | **进程创建没被拦，被拦的是管道通道。** 这是沙箱类限制的特征（受限令牌 / 低完整性级别），不是杀软拦可执行文件 |

**管道不通时，任何 Electron 启动参数或版本都救不回来。** 这不是 Electron 的可选功能，
而是 Chromium 在 Windows 上的 IPC 传输层。已实测确认无效的路子：

- `--no-sandbox`、`--no-zygote`、`--single-process`、`--in-process-gpu`、
  `--disable-gpu-sandbox`、`--disable-crash-reporter`、`--disable-gpu`、
  `--user-data-dir=...`，以及它们的各种组合（共 20 种）
- **降级 Electron**：实测 Electron 22 与 33 在这里表现一致

`--no-sandbox` 是唯一会改变失败形态的参数：它把崩溃点从「任何 JS 之前」推到
「`app.whenReady()` 内部」，但进程仍然访问违例（`0xC0000005`）。换句话说，
它对定位有信息量，对解决问题没有帮助。

同样被证明**无关**的两个猜测：

- **任意代码防护 (ACG)**：`ELECTRON_RUN_AS_NODE` 模式下跑的是 V8，V8 需要 JIT 动态
  生成可执行机器码，正是 ACG 要拦的东西。这一步能通过，ACG 就没开。
- **杀软拦截可执行文件**：那一步用的是**同一个** `electron.exe`。

### 5.2 再跑启动诊断

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\diagnose.ps1
```

它做三件事：验证 `electron.exe` 二进制本身、正常启动一次、再带兼容开关
（`--no-sandbox --disable-gpu --disable-crash-reporter`）启动一次。全部输出与**真实退出码**
都写进 `%TEMP%\dsh-pet-*.txt`。**「父进程链」那一节很关键**——如果链里出现
`node.exe` / `dsh` / 沙箱代理，说明命令跑在了受限宿主里。

> 为什么不直接用 `npx electron . --enable-logging *> pet-log.txt`：
> PowerShell 的原生命令重定向经管道实现，Chromium 的 stderr 经常**整个丢掉**，
> 你会得到一个看起来什么都没有的日志文件。脚本改用 cmd 的句柄级重定向绕开这一点。

### 5.3 对照表

| 控制台表现 | 含义 | 处理 |
| --- | --- | --- |
| `crashpad_client_win.cc ... not connected` | Electron 的崩溃处理器进程起不来，**在任何 JS 执行前就退出** | 进程创建被限制。确认不是在 DSH 终端 / 沙箱 / 远程会话里跑 |
| 退出码 `-2147483645` (`0x80000003`)、无任何输出 | 进程初始化被拦截 | 查杀软 / EDR 白名单；Windows 安全中心 → 应用和浏览器控制 → 漏洞利用防护里针对 `electron.exe` 的「任意代码防护 (ACG)」是否被打开 |
| 完全没有任何输出，进程也不在 | 也可能是上一次实例还占着单实例锁 | 任务管理器结束所有 `electron.exe`；现在这种情况启动时会打印明确警告 |
| 打印了「宠物窗口已显示」但屏幕上看不到 | 窗口在，但被 GPU 合成渲染没了——透明窗口在部分显卡驱动 / 远程桌面下会完全不可见 | 设 `$env:DSH_PET_DISABLE_GPU = "1"` 后重启；或在 `pet.config.json` 写 `"disableHardwareAcceleration": true` |
| 打印了窗口位置，但明显不对 | 多屏 / 缩放比导致坐标异常 | 对照打印出的「主显示器工作区」判断 |
| 出现空白窗口 | 页面加载了但渲染进程出错 | 现在会把 `did-fail-load` / `preload-error` / `render-process-gone` 与 CSP 拦截转发到 stdout |
| `npm start` 在构建阶段报错 | 三步构建没过，`electron .` 根本没执行 | 产物已存在时可直接 `npx electron .` |

确认 Electron 二进制本身能否运行（这条不启动 Chromium）：

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"; npx electron -e "console.log('ok', process.versions.electron)"; $env:ELECTRON_RUN_AS_NODE = $null
```

这条能过但应用起不来，说明卡在 Chromium 的浏览器进程阶段。

### 5.4 环境没问题，但 Electron 仍然秒退

如果 `probe-ipc.cjs` 全 PASS（管道可用），但 Electron 依然在**任何 JS 之前**以
`0x80000003` 退出，**先做这个判别实验：把 Electron 运行时复制到别处运行。**

```powershell
# 复制一份到没有特殊权限标记的位置
Copy-Item -Recurse node_modules\electron\dist %TEMP%\electron-probe
%TEMP%\electron-probe\electron.exe scripts\minimal-app.js
```

| 结果 | 结论 |
| --- | --- |
| 复制后**能跑** | **问题出在项目所在目录的权限标记上**，见下面「低完整性标签」 |
| 复制后**也不能跑** | 才继续查系统层（杀软内核驱动、Exploit Protection 等） |

#### 低完整性标签（本项目实际遇到的情况）

DSH 的 Windows 沙箱在给工作区授权时，会给工作区根目录打上
`Mandatory Label\Low Mandatory Level` 强制完整性标签，整个目录树继承它——
包括 `node_modules\electron\dist\electron.exe`。**Chromium 拒绝从这种位置启动。**

自查：

```powershell
icacls . | Select-String "Mandatory Label"
icacls node_modules\electron\dist\electron.exe | Select-String "Mandatory Label"
```

出现 `Low Mandatory Level` 就是它。**不需要管理员权限的修复：**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\fix-integrity-block.ps1
```

它把 Electron 运行时整体移到无标签的位置（默认 `C:\electron-runtime`），
再在原路径建立**目录联接**指回去。之后 `npm start` / `npx electron .` 全部照旧。
原理：联接是重解析点，通过它访问到的文件位于目标卷上，带的是目标卷的标签。

还原：删除该联接，再 `npm install` 让 Electron 重新下载到项目里。

> 有管理员权限时也可以选择就地修复（但 DSH 之后可能重新打标）：
> `icacls "<项目目录>" /setintegritylevel (OI)(CI)Medium /T /C`

#### 已经排除的方向（有实测证据，别再试）

- **降级 Electron 无效。** 实测 Electron 22 与 33 在同一阶段失败；把同一份
  `electron.exe` 换个目录就正常，说明与版本无关。
- **不是命名管道被禁。** `probe-ipc.cjs` 三项全 PASS 即可排除。
- **不是 Windows 安全中心的「任意代码防护 (ACG)」。** `ELECTRON_RUN_AS_NODE` 模式下跑的是
  V8，V8 需要 JIT 动态生成可执行机器码，正是 ACG 要拦的事；这一步能过就说明 ACG 没开。
- **不是全局 DLL 注入。** `collect-crash-info.ps1` 会检查 `AppInit_DLLs` 与 IFEO 挂钩。
- **不是杀软拦截可执行文件。** 同一份 `electron.exe` 在别处能跑，且进程创建本身正常。
- **不是访问规则（ACL）。** 实测把故障目录的访问规则原样复制到正常目录后仍然正常，
  差异只剩完整性标签。

#### 确认崩溃发生在哪个模块

`0x80000003` 是一次 `CHECK` 失败，会在 Windows 事件日志留下 `APPCRASH` 记录，
其中 **P4 是出错模块**、**P7 是异常代码**：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\collect-crash-info.ps1
```

再用最小应用区分「Electron 起不来」与「本项目的应用有问题」：

```powershell
node_modules\electron\dist\electron.exe scripts\minimal-app.js
type %TEMP%\electron-minimal.log
```

日志逐行记录走到哪一步。最小应用也起不来 → 与本项目代码无关。

---

## 6. 已知取舍

- **不打包主进程**：只用 `tsc`，产物可读、断点直接可用。preload 是例外——沙箱化的
  preload 无法 `require` 本地文件，必须打包成单文件 CJS。
- **不用 CSS transition 做形变**：时间轴驱动的动画只能表达"从 A 到 B"，
  而本项目的形变目标每帧都由外部速度决定。
- **不做多宠物 / 皮肤系统**：核心功能保持单一，`Pet` 与 `BalanceBadge` 都是可替换的独立单元。
