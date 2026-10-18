# build/ —— 打包资源目录

这个目录**不会**被打进安装包，只在 `electron-builder` 构建时使用
（见 `electron-builder.yml` 的 `directories.buildResources`）。

## icon.ico（应用与任务栏图标）

`electron-builder.yml` 里写的是 `build/icon.ico`。放好这个文件即可换掉默认的
Electron 图标；**没有它也能打包成功**，只是会用 Electron 的默认图标并给出一条警告。

**格式要求**

| 项 | 要求 |
| --- | --- |
| 容器格式 | `.ico`（不是 png 改后缀） |
| 尺寸 | 必须包含 **256×256**；建议同时带 16 / 32 / 48 / 64 / 128 / 256 |
| 文件名 | 必须是 `icon.ico`，必须放在本目录 |

多尺寸很重要：16×16 用在托盘和标题栏、48×48 用在资源管理器、256×256 用在大图标视图。
只放一张 256 的话，缩小后细线条会糊成一团。

**怎么生成**

- 在线：把一张正方形 PNG 传到 icoconvert.com，勾选多个尺寸导出
- ImageMagick：

  ```powershell
  magick pet.png -define icon:auto-resize=256,128,64,48,32,16 icon.ico
  ```

- 原图建议 1024×1024 的 PNG，**先抠成透明背景**（本项目的「导入宠物图片」
  会自动抠图，可以把结果另存出来当素材）

**注意托盘图标是另一回事**

系统托盘那个 32×32 的小图标**不读这个文件**——它是内嵌在
`src/main/tray-icon.ts` 里的 base64，好处是打包后绝不会"找不到图标"。
想换它需要把新图标转成 base64 替换那个常量。
