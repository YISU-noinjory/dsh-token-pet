# dsh-token-pet 崩溃信息收集
#
# 用途：Electron 在启动阶段以 0x80000003 (STATUS_BREAKPOINT) 静默退出时，
# 那个退出码在 Chromium 里对应一次 CHECK 失败，也就是 __debugbreak()。
# 这类崩溃**不会**打印到 stdout，但 Windows 会记录下来，而且记录里有
# 出错的模块名 —— 那才是定位问题的钥匙。
#
# 这个脚本收集四类证据：
#   1. 应用程序事件日志里与 electron 相关的崩溃/错误记录（含出错模块）
#   2. Windows 错误报告 (WER) 的归档报告
#   3. Electron 安装产物的完整性（缺文件也会导致启动即崩）
#   4. 经典的进程级 DLL 注入点（AppInit_DLLs）
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\collect-crash-info.ps1

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot

function Section([string]$title) {
  Write-Host ''
  Write-Host "===== $title ====="
}

Section '环境'
Write-Host ("PowerShell : {0}" -f $PSVersionTable.PSVersion)
# 有些受限环境会拒绝 WMI 查询，取不到就跳过，不要让整段输出中断。
$osCaption = '(取不到)'
try {
  $osCaption = (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).Caption
} catch {
  $osCaption = "(取不到：$($_.Exception.Message))"
}
Write-Host ("OS         : {0}" -f $osCaption)
Write-Host ("用户       : {0}" -f $env:USERNAME)
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Write-Host ("管理员     : {0}" -f $isAdmin)
if (-not $isAdmin) {
  Write-Host '提示：非管理员能读应用程序日志，但读不到部分安全软件相关记录。'
}

# ---------------------------------------------------------------------------
Section '1. 应用程序事件日志中的 electron 记录'
Write-Host '（这些记录里有「出错模块」和「异常代码」，是最关键的线索）'
# Application Error = 1000，Windows Error Reporting = 1001，.NET Runtime = 1026
$events = @()
try {
  $events = Get-WinEvent -FilterHashtable @{
    LogName   = 'Application'
    StartTime = (Get-Date).AddDays(-7)
  } -ErrorAction SilentlyContinue |
    Where-Object { $_.Message -match 'electron' } |
    Select-Object -First 8
} catch {
  Write-Host ("  读取事件日志失败：{0}" -f $_.Exception.Message)
}

if (@($events).Count -eq 0) {
  Write-Host '  最近 7 天没有与 electron 相关的应用程序事件。'
  Write-Host '  （这也说明崩溃可能发生在更底层，没走到会被 WER 记录的程度）'
} else {
  foreach ($event in $events) {
    Write-Host ''
    Write-Host ("  --- {0}  Id={1}  {2}" -f $event.TimeCreated, $event.Id, $event.ProviderName)
    # 事件消息里的关键行：出错模块、异常代码、模块路径
    ($event.Message -split "`r?`n") | Where-Object { $_ -match '\S' } | Select-Object -First 12 | ForEach-Object {
      Write-Host ("      {0}" -f $_.Trim())
    }
  }
}

# ---------------------------------------------------------------------------
Section '2. Windows 错误报告 (WER) 归档'
$werRoots = @(
  (Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\WER\ReportArchive'),
  (Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\WER\ReportQueue'),
  (Join-Path $env:ProgramData 'Microsoft\Windows\WER\ReportArchive')
)
$found = $false
foreach ($werRoot in $werRoots) {
  if (-not (Test-Path $werRoot)) { continue }
  $reports = Get-ChildItem $werRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'electron' } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 3
  foreach ($report in $reports) {
    $found = $true
    Write-Host ("  {0}" -f $report.FullName)
    $reportFile = Join-Path $report.FullName 'Report.wer'
    if (Test-Path $reportFile) {
      Get-Content $reportFile -ErrorAction SilentlyContinue |
        Where-Object { $_ -match '^(Sig\[|DynamicSig\[|AppName|AppPath|FaultingModule|ExceptionCode)' } |
        Select-Object -First 14 |
        ForEach-Object { Write-Host ("      {0}" -f $_.Trim()) }
    }
  }
}
if (-not $found) {
  Write-Host '  没有找到 electron 相关的 WER 报告。'
}

# ---------------------------------------------------------------------------
Section '3. Electron 安装产物完整性'
$dist = Join-Path $root 'node_modules\electron\dist'
if (-not (Test-Path $dist)) {
  Write-Host '  找不到 node_modules\electron\dist —— 先执行 npm install。'
} else {
  # 缺任何一个都可能导致浏览器进程启动即崩（而 RUN_AS_NODE 模式仍能跑，
  # 因为它根本不用这些资源文件）。
  $critical = @(
    'electron.exe',
    'icudtl.dat',
    'resources.pak',
    'chrome_100_percent.pak',
    'chrome_200_percent.pak',
    'v8_context_snapshot.bin',
    'snapshot_blob.bin',
    'ffmpeg.dll',
    'libEGL.dll',
    'libGLESv2.dll',
    'd3dcompiler_47.dll',
    'vk_swiftshader.dll',
    'vulkan-1.dll',
    'version',
    'resources\default_app.asar'
  )
  $missing = @()
  foreach ($name in $critical) {
    $path = Join-Path $dist $name
    $exists = Test-Path $path
    $size = 0
    if ($exists) { $size = (Get-Item $path).Length }
    if (-not $exists -or $size -eq 0) { $missing += $name }
    Write-Host ("  {0,-32} {1}" -f $name, $(if (-not $exists) { '缺失 ❌' } elseif ($size -eq 0) { '0 字节 ❌' } else { "$([math]::Round($size/1KB,0)) KB" }))
  }

  $localeCount = 0
  $localeDir = Join-Path $dist 'locales'
  if (Test-Path $localeDir) { $localeCount = (Get-ChildItem $localeDir -Filter *.pak -ErrorAction SilentlyContinue | Measure-Object).Count }
  Write-Host ("  {0,-32} {1} 个 .pak" -f 'locales\', $localeCount)

  $totalMb = [math]::Round(((Get-ChildItem $dist -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1MB), 1)
  Write-Host ("  {0,-32} {1} MB（正常约 268 MB）" -f '总大小', $totalMb)

  if ($missing.Count -gt 0) {
    Write-Host ''
    Write-Host ('  ❌ 缺失关键文件：{0}' -f ($missing -join ', '))
    Write-Host '     这足以解释"浏览器进程启动即崩、但 RUN_AS_NODE 模式仍能跑"。'
    Write-Host '     处理：删除 node_modules\electron 后重新 npm install。'
  }
  if ($localeCount -eq 0) {
    Write-Host '  ❌ locales 目录为空，同样说明安装不完整。'
  }
}

# ---------------------------------------------------------------------------
Section '4. 进程级 DLL 注入点（AppInit_DLLs）'
# 这里是全局注入 DLL 的经典位置。被注入的第三方 DLL 会进入每个进程，
# 而 Chromium 对这类注入特别敏感，常见表现就是启动即崩且没有输出。
$appInitPaths = @(
  'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Windows',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows NT\CurrentVersion\Windows'
)
foreach ($key in $appInitPaths) {
  if (-not (Test-Path $key)) { continue }
  $props = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
  Write-Host ("  {0}" -f $key)
  Write-Host ("      LoadAppInit_DLLs = {0}" -f $props.LoadAppInit_DLLs)
  $dlls = $props.AppInit_DLLs
  if ([string]::IsNullOrWhiteSpace($dlls)) {
    Write-Host '      AppInit_DLLs    = (空) ✅'
  } else {
    Write-Host ("      AppInit_DLLs    = {0}  ⚠ 有全局注入" -f $dlls)
  }
}

# ---------------------------------------------------------------------------
Section '5. 已知会干扰 Chromium 的第三方安全软件'
$suspicious = @(
  'huorong', 'hips', '360', 'qqpcmgr', 'kingsoft', 'baidu', 'rising',
  'kaspersky', 'avast', 'avira', 'bitdefender', 'eset', 'mcafee',
  'symantec', 'norton', 'sophos', 'crowdstrike', 'sentinelone', 'carbonblack',
  'cylance', 'tamper', 'edr'
)
$services = @()
try {
  $services = @(Get-Service -ErrorAction Stop)
} catch {
  Write-Host ("  枚举服务失败：{0}" -f $_.Exception.Message)
}
$hits = @()
foreach ($pattern in $suspicious) {
  $matched = $services | Where-Object { $_.Name -match $pattern -or $_.DisplayName -match $pattern }
  foreach ($service in $matched) {
    $hits += ("{0} ({1}) — {2}" -f $service.DisplayName, $service.Name, $service.Status)
  }
}
if ($hits.Count -eq 0) {
  Write-Host '  没有匹配到已知的安全软件服务名。'
} else {
  $hits | Sort-Object -Unique | ForEach-Object { Write-Host ("  {0}" -f $_) }
  Write-Host ''
  Write-Host '  说明：火绒已关不代表它的内核驱动也卸载了。驱动层的拦截在服务停止后往往仍然生效，'
  Write-Host '        需要重启或卸载才能完全排除。'
}

Write-Host ''
Write-Host '===== 下一步 ====='
Write-Host '把上面全部输出贴出来。最关键的是第 1 节的「出错模块」与第 3 节的完整性检查：'
Write-Host '  - 第 1 节给出具体是哪个 DLL 崩的 → 能直接定位到是安全软件注入还是 Electron 自身问题'
Write-Host '  - 第 3 节若显示缺失文件 → 重装 Electron 即可解决，与安全设置无关'
