# dsh-token-pet 启动诊断脚本
#
# 为什么需要它：桌宠没有任务栏入口也没有 DevTools，启动失败默认是静默的。
# 更麻烦的是 PowerShell 对原生命令的重定向（`*>`）经管道实现，
# Chromium 的 stderr 经常整个丢掉，于是你只得到一个"看起来什么都没有"的日志。
#
# 这个脚本用三层递进把问题逼出来：
#   第一步  只验证 electron.exe 二进制本身（走 ELECTRON_RUN_AS_NODE，不碰 Chromium）
#   第二步  正常启动，用 cmd 的句柄级重定向抓全部输出与真实退出码
#   第三步  带兼容开关再启动一次（--no-sandbox --disable-gpu --disable-crash-reporter）
#           用来区分"Chromium 沙箱被拦"、"GPU 合成有问题"、"崩溃处理器起不来"
#
# 用法（在你自己的 PowerShell 或 CMD 窗口里，不要在受限宿主里跑）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\diagnose.ps1

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Section([string]$title) {
  Write-Host ''
  Write-Host "===== $title ====="
}

$electronExe = Join-Path $root 'node_modules\electron\dist\electron.exe'

Section '环境'
Write-Host ("PowerShell   : {0}" -f $PSVersionTable.PSVersion)
Write-Host ("工作目录     : {0}" -f (Get-Location))
Write-Host ("64 位进程    : {0}" -f [Environment]::Is64BitProcess)
try {
  Write-Host ("node         : {0}" -f (& node --version 2>&1))
} catch {
  Write-Host 'node         : 不可用'
}
Write-Host ("会话名       : {0}" -f $env:SESSIONNAME)
# 注意：这里不能用 `?.`——那是 PowerShell 7 的语法，5.1 会直接解析失败。
$isRemoteSession = $false
if ($env:SESSIONNAME) { $isRemoteSession = $env:SESSIONNAME.StartsWith('RDP') }
Write-Host ("远程桌面     : {0}" -f $isRemoteSession)
Write-Host ("OS           : {0}" -f (Get-CimInstance Win32_OperatingSystem).Caption)

Section '父进程链'
Write-Host '如果这条链里出现 dsh / 沙箱代理 / 远程会话宿主，'
Write-Host 'Electron 会因为无法派生 Chromium 的子进程而静默退出。'
# 注意：不能用 $pid —— 它是 PowerShell 的只读自动变量。
$cursor = $PID
for ($depth = 0; $depth -lt 6; $depth++) {
  $info = Get-CimInstance Win32_Process -Filter "ProcessId=$cursor" -ErrorAction SilentlyContinue
  if (-not $info) { break }
  Write-Host ("  {0}{1}  (pid {2})" -f ('  ' * $depth), $info.Name, $info.ProcessId)
  if (-not $info.ParentProcessId -or $info.ParentProcessId -eq 0) { break }
  $cursor = $info.ParentProcessId
}

Section '构建产物'
$artifacts = @(
  'dist\main\index.js',
  'dist\preload\index.js',
  'dist\renderer\index.html',
  'dist\dsh\plugin.mjs',
  'node_modules\electron\dist\electron.exe'
)
foreach ($relative in $artifacts) {
  Write-Host ("{0,-42} {1}" -f $relative, (Test-Path (Join-Path $root $relative)))
}

if (-not (Test-Path $electronExe)) {
  Write-Host ''
  Write-Host '找不到 electron.exe，先执行 npm install 与 npm run build。'
  exit 1
}

# ---------------------------------------------------------------------------
# 启动一次 Electron，把 stdout / stderr / 退出码全部收进一个文件。
#
# 为什么绕一层 cmd 而不是直接用 PowerShell 重定向：
#   - PowerShell 的 `*>` 经管道实现，原生命令的 stderr 经常丢；
#   - `Start-Process -PassThru` 配合 `-RedirectStandardOutput` 时 ExitCode 不可靠。
# cmd 的 `>` / `2>&1` 是内核级句柄重定向，两样都不会出问题。
# ---------------------------------------------------------------------------
function Invoke-ElectronLaunch {
  param(
    [string]$Label,
    [string[]]$ExtraArgs = @(),
    [int]$TimeoutMs = 12000
  )

  $outFile = Join-Path $env:TEMP "dsh-pet-$Label.txt"
  $wrapper = Join-Path $env:TEMP "dsh-pet-$Label.cmd"
  Remove-Item $outFile -ErrorAction SilentlyContinue

  # 注意：不能用 $args —— 它也是 PowerShell 的自动变量。
  $launchArgs = @('.', '--enable-logging') + $ExtraArgs
  $argLine = ($launchArgs | ForEach-Object {
    if ($_ -match '\s') { '"' + $_ + '"' } else { $_ }
  }) -join ' '

  Set-Content -Path $wrapper -Encoding ASCII -Value @(
    '@echo off',
    "cd /d `"$root`"",
    "`"$electronExe`" $argLine > `"$outFile`" 2>&1",
    ('echo ===EXITCODE=%ERRORLEVEL%=== >> ' + "`"$outFile`"")
  )

  $process = Start-Process -FilePath $wrapper -PassThru -WindowStyle Hidden
  $exited = $process.WaitForExit($TimeoutMs)

  if (-not $exited) {
    & taskkill /PID $process.Id /T /F 2>&1 | Out-Null
    & taskkill /IM electron.exe /F 2>&1 | Out-Null
    Start-Sleep -Milliseconds 600
  }

  $text = ''
  if (Test-Path $outFile) { $text = Get-Content $outFile -Raw }

  return [pscustomobject]@{
    Label  = $Label
    Args   = $argLine
    Exited = $exited
    Output = $text
  }
}

function Show-LaunchResult($result) {
  Write-Host ("参数: {0}" -f $result.Args)
  if ($result.Exited) {
    Write-Host '结果: 进程已退出'
  } else {
    Write-Host '结果: ★ 存活满超时时间 —— Electron 能正常启动'
  }
  Write-Host '--- 输出 ---'
  if ([string]::IsNullOrWhiteSpace($result.Output)) {
    Write-Host '(完全没有输出)'
  } else {
    Write-Host $result.Output
  }
}

Section '第一步：Electron 二进制自检（不启动 Chromium）'
$env:ELECTRON_RUN_AS_NODE = '1'
& $electronExe -e "console.log('  ok — electron ' + process.versions.electron + ' / node ' + process.versions.node)"
$nodeExit = $LASTEXITCODE
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Write-Host ("退出码: {0}" -f $nodeExit)
if ($nodeExit -ne 0) {
  Write-Host '二进制本身就跑不起来。多半是杀软 / EDR 拦了这个可执行文件，或下载不完整。'
  Write-Host '处理：删除 node_modules\electron 后重新执行 npm install。'
  exit 1
}

Section '第二步：正常启动'
$plain = Invoke-ElectronLaunch -Label 'plain'
Show-LaunchResult $plain

Section '第三步：带兼容开关启动'
Write-Host '（--no-sandbox --disable-gpu --disable-crash-reporter）'
$compat = Invoke-ElectronLaunch -Label 'compat' -ExtraArgs @('--no-sandbox', '--disable-gpu', '--disable-crash-reporter')
Show-LaunchResult $compat

Section '结论'
$userDataExists = Test-Path "$env:APPDATA\dsh-token-pet"
Write-Host ("userData 目录 (%APPDATA%\dsh-token-pet) 是否存在 : {0}" -f $userDataExists)
Write-Host ''
Write-Host '怎么读这个结果：'
Write-Host '  A. 第二步存活             → 应用正常，问题是"显示"：试 $env:DSH_PET_DISABLE_GPU = "1"'
Write-Host '  B. 第二步退出、第三步存活 → Chromium 沙箱或 GPU 被环境拦了，把第三步输出发出来'
Write-Host '  C. 两步都退出、都无输出、退出码 -2147483645 (0x80000003)'
Write-Host '                            → 进程初始化时被拦截。查杀软 / EDR 白名单，以及'
Write-Host '                              Windows 安全中心 → 应用和浏览器控制 → 漏洞利用防护'
Write-Host '                              里针对 electron.exe 的"任意代码防护 (ACG)"是否被打开。'
Write-Host '  D. 两步都退出，但输出里有 did-fail-load / preload-error'
Write-Host '                            → 应用跑起来了，是渲染进程的问题，把那几行发出来。'
