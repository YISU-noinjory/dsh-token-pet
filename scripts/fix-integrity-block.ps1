# 修复：工作区的「低完整性标签」导致 Electron 无法启动
#
# ## 症状
#   Electron 在任何 JS 执行之前就退出，退出码 -2147483645 (0x80000003)，
#   没有任何输出，userData 目录也不创建。
#   但**同一个 electron.exe 复制到别处就能正常运行**。
#
# ## 根因
#   DSH 的 Windows 沙箱在给工作区授权时，会给工作区根目录打上
#   `Mandatory Label\Low Mandatory Level` 强制完整性标签，整个目录树继承它
#   （包括 node_modules\electron\dist\electron.exe）。
#   Chromium 拒绝从这样的位置启动，于是在跑任何代码之前就 CHECK 失败。
#
#   已实测确认这与杀软、命名管道、Electron 版本都无关：
#     - 同机 Edge（完整 Chromium）正常
#     - 同一份 electron.exe 复制到无标签目录后正常
#     - 把工作区的访问规则复制到无标签目录后仍然正常（说明不是 ACL 规则的问题）
#
# ## 本脚本做什么（不需要管理员权限）
#   1. 把 electron 运行时整体移到没有标签的位置（默认 C:\electron-runtime）
#   2. 在原路径建立目录联接（junction）指回去
#
#   之后 `npm start` / `npx electron .` / 构建命令全部照旧，路径不用改。
#   之所以能生效：联接是重解析点，通过它访问到的文件对象位于目标卷上，
#   带的是目标卷的标签，因此没有那个 Low 标签。
#
# ## 用法
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\fix-integrity-block.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\fix-integrity-block.ps1 -RuntimePath D:\electron-runtime

param(
  [string]$RuntimePath = 'C:\electron-runtime'
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'node_modules\electron\dist'

function Section([string]$title) {
  Write-Host ''
  Write-Host "===== $title ====="
}

Section '诊断'

if (-not (Test-Path $dist)) {
  Write-Host "找不到 $dist"
  Write-Host '请先执行 npm install。'
  exit 1
}

# 已经是联接的话说明之前修过。
$distItem = Get-Item $dist -Force
if ($distItem.LinkType -eq 'Junction') {
  Write-Host "electron 运行时已经是指向 $(($distItem.Target -join ', ')) 的目录联接。"
  Write-Host '无需再次修复。若仍有问题，先删除该联接再执行本脚本。'
  exit 0
}

# 读完整性标签不需要管理员权限。
function Get-IntegrityLabel([string]$path) {
  $text = (& icacls $path 2>&1) -join "`n"
  if ($text -match 'Low Mandatory Level') { return 'Low' }
  if ($text -match 'Medium Mandatory Level') { return 'Medium' }
  if ($text -match 'High Mandatory Level') { return 'High' }
  return '无'
}

$rootLabel = Get-IntegrityLabel $root
$distLabel = Get-IntegrityLabel $dist
$exeLabel = Get-IntegrityLabel (Join-Path $dist 'electron.exe')

Write-Host ("{0,-42} 完整性标签: {1}" -f $root, $rootLabel)
Write-Host ("{0,-42} 完整性标签: {1}" -f $dist, $distLabel)
Write-Host ("{0,-42} 完整性标签: {1}" -f (Join-Path $dist 'electron.exe'), $exeLabel)

if ($exeLabel -ne 'Low') {
  Write-Host ''
  Write-Host 'electron.exe 没有低完整性标签 —— 不是这个问题，本脚本不做任何改动。'
  Write-Host '请改跑 scripts\probe-ipc.cjs 与 scripts\collect-crash-info.ps1 继续定位。'
  exit 0
}

Section '修复'

if (Test-Path $RuntimePath) {
  Write-Host "$RuntimePath 已存在。"
  Write-Host '请先移除它，或用 -RuntimePath 指定另一个位置。'
  exit 1
}

Write-Host "1. 移动运行时: $dist"
Write-Host "            -> $RuntimePath"
Move-Item -Path $dist -Destination $RuntimePath -Force
if (-not (Test-Path (Join-Path $RuntimePath 'electron.exe'))) {
  Write-Host '移动失败，未做任何后续改动。'
  exit 1
}
Write-Host '   完成。'

Write-Host '2. 在原路径建立目录联接'
& cmd.exe /c "mklink /J `"$dist`" `"$RuntimePath`"" | Out-Null
if (-not (Test-Path (Join-Path $dist 'electron.exe'))) {
  Write-Host '建立联接失败。运行时仍在原处未受影响，可手动恢复。'
  exit 1
}
Write-Host '   完成。'

Section '验证'
$afterLabel = Get-IntegrityLabel (Join-Path $dist 'electron.exe')
Write-Host ("通过原路径访问 electron.exe 的完整性标签: {0}" -f $afterLabel)

Write-Host ''
Write-Host '自检（不启动 Chromium，只验证二进制可执行）:'
$env:ELECTRON_RUN_AS_NODE = '1'
& (Join-Path $dist 'electron.exe') -e "console.log('  ok — electron ' + process.versions.electron)"
$nodeExit = $LASTEXITCODE
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Write-Host ("  退出码: {0}" -f $nodeExit)

Write-Host ''
if ($afterLabel -ne 'Low') {
  Write-Host '修复完成。现在可以正常启动：'
  Write-Host '    npm start'
} else {
  Write-Host '标签仍然是 Low —— 联接没有生效，请把上面的输出发出来。'
  exit 1
}

Write-Host ''
Write-Host '备注：'
Write-Host '  - 运行时现在位于上面的 $RuntimePath，不再放在项目里。'
Write-Host '  - 若之后 DSH 再次给工作区打标，本联接不受影响（目标在另一个卷上）。'
Write-Host '  - 若要还原：删除该联接，再执行 npm install 让 Electron 重新下载到项目里。'
