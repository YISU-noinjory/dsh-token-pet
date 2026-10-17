#Requires -Version 5.1
<#
.SYNOPSIS
    dsh-token-pet 开源发布前的隐私与安全自检。

.DESCRIPTION
    自动扫描仓库，报告三类风险：
      1. 硬编码的 API Key（src/、scripts/、dist/ 里的 sk- 开头字符串）
      2. 本机绝对路径泄露（用户名、用户目录、仓库自身路径）
      3. .gitignore 是否真的拦住了密钥、日志与构建产物

    只做"报告"，不改任何文件——自动修改仓库是有风险的，宁可让人看一眼再动手。

.PARAMETER Root
    仓库根目录。默认取脚本所在目录的上一级。

.PARAMETER SkipDist
    跳过 dist/（构建产物）。默认会扫，因为 dist/ 虽然被 gitignore，
    但一旦有人用 -f 强推就会进版本库。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\security-check.ps1

.EXAMPLE
    pwsh -File scripts/security-check.ps1 -SkipDist
#>
[CmdletBinding()]
param(
    [string]$Root,
    [switch]$SkipDist
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# 基础设置
# ---------------------------------------------------------------------------

if (-not $Root) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $Root = Split-Path -Parent $scriptDir
}
if (-not (Test-Path -LiteralPath $Root)) {
    Write-Host "找不到仓库根目录: $Root" -ForegroundColor Red
    exit 2
}
$Root = (Resolve-Path -LiteralPath $Root).Path

# 这个脚本自己会包含 "[A-Z]:\Users\" 之类的正则字面量，扫自己必然误报。
$SelfPath = $MyInvocation.MyCommand.Path

$script:FailureCount = 0
$script:WarningCount = 0

function Write-Section([string]$Title) {
    Write-Host ''
    Write-Host "── $Title " -ForegroundColor Cyan -NoNewline
    Write-Host ('─' * [Math]::Max(0, 60 - $Title.Length)) -ForegroundColor DarkCyan
}

function Write-Pass([string]$Message) {
    Write-Host '  [PASS] ' -ForegroundColor Green -NoNewline
    Write-Host $Message
}

function Write-Fail([string]$Message) {
    $script:FailureCount++
    Write-Host '  [FAIL] ' -ForegroundColor Red -NoNewline
    Write-Host $Message
}

function Write-Warn([string]$Message) {
    $script:WarningCount++
    Write-Host '  [WARN] ' -ForegroundColor Yellow -NoNewline
    Write-Host $Message
}

function Write-Info([string]$Message) {
    Write-Host "         $Message" -ForegroundColor DarkGray
}

# 会被当作文本扫描的扩展名。
$TextExtensions = @(
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.json', '.yml', '.yaml', '.md', '.html', '.css',
    '.ps1', '.psm1', '.txt', '.env', '.example', '.patch'
)

# ---------------------------------------------------------------------------
# 收集要扫描的文件
# ---------------------------------------------------------------------------

Write-Section '扫描范围'

$scanRoots = @('src', 'scripts')
if (-not $SkipDist) { $scanRoots += 'dist' }

$files = New-Object System.Collections.ArrayList

foreach ($name in $scanRoots) {
    $dir = Join-Path $Root $name
    if (-not (Test-Path -LiteralPath $dir)) { continue }
    $found = Get-ChildItem -LiteralPath $dir -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { ($TextExtensions -contains $_.Extension.ToLowerInvariant()) -and ($_.Length -lt 4MB) }
    foreach ($f in $found) { [void]$files.Add($f) }
}

# 根目录的零散文件（不受上面的目录限制）
$rootFiles = @(
    'README.md', 'package.json', 'cordis.patch.yml', 'electron-builder.yml',
    '.env.example', '.gitignore', 'vite.config.ts', 'vite.dsh.config.ts',
    'vite.preload.config.ts', 'tsconfig.json', 'tsconfig.main.json', 'tsconfig.dsh.json'
)
foreach ($name in $rootFiles) {
    $path = Join-Path $Root $name
    if (Test-Path -LiteralPath $path) { [void]$files.Add((Get-Item -LiteralPath $path)) }
}

# 去掉脚本自己
$scanFiles = @($files | Where-Object { $_.FullName -ne $SelfPath })

Write-Host ("  根目录   : {0}" -f $Root)
Write-Host ("  目录     : {0}" -f ($scanRoots -join ', '))
Write-Host ("  文件数量 : {0}" -f $scanFiles.Count)
if ($SkipDist) { Write-Info '已按要求跳过 dist/' }

# ---------------------------------------------------------------------------
# 1. 硬编码 API Key
# ---------------------------------------------------------------------------

Write-Section '1. 硬编码 API Key'

# sk- 后面至少 16 位才算"像真 Key"。
$keyPattern = '\bsk-[A-Za-z0-9_\-]{16,}\b'

# 占位符不算泄露：全 x、your_...、example、placeholder、<...> 之类。
function Test-Placeholder([string]$Value) {
    $body = $Value.Substring(3)  # 去掉 'sk-'
    if ($body -match '^[xX]+$') { return $true }
    if ($body -match '^(your|example|placeholder|test|demo|fake|dummy)') { return $true }
    if ($body -match '<|>|\{|\}') { return $true }
    return $false
}

$keyHits = 0
$realKeyHits = 0

foreach ($file in $scanFiles) {
    $matches = Select-String -LiteralPath $file.FullName -Pattern $keyPattern -AllMatches -ErrorAction SilentlyContinue
    foreach ($m in $matches) {
        foreach ($hit in $m.Matches) {
            $keyHits++
            if (Test-Placeholder $hit.Value) {
                Write-Info ("占位符（忽略）: {0}:{1}" -f $file.Name, $m.LineNumber)
                continue
            }
            $realKeyHits++
            Write-Fail ("疑似真实 Key: {0}:{1}  值 {2}…" -f $file.Name, $m.LineNumber, $hit.Value.Substring(0, [Math]::Min(7, $hit.Value.Length)))
        }
    }
}

if ($realKeyHits -eq 0) {
    Write-Pass '没有发现硬编码的真实 Key'
    if ($keyHits -gt 0) { Write-Info ("共 {0} 处 sk- 形态的字符串，均为占位符" -f $keyHits) }
}

# ---------------------------------------------------------------------------
# 2. 本机绝对路径
# ---------------------------------------------------------------------------

Write-Section '2. 本机绝对路径泄露'

$pathPatterns = New-Object System.Collections.ArrayList

# 2a. 通用 Windows 用户目录形式
[void]$pathPatterns.Add(@{
    Name    = 'Windows 用户目录'
    Pattern = '[A-Za-z]:\\Users\\[^\\\s"'']+'
})

# 2b. 仓库自身的绝对路径（有两种分隔符写法）
$rootRegex = [regex]::Escape($Root)
$rootSlashRegex = [regex]::Escape(($Root -replace '\\', '/'))
[void]$pathPatterns.Add(@{
    Name    = '仓库自身的绝对路径'
    Pattern = "($rootRegex|$rootSlashRegex)"
})

# 2c. 当前用户名（长度 >= 4 且不是常见词时才检查，避免误报）
$userName = $env:USERNAME
$genericNames = @('admin', 'user', 'test', 'guest', 'runner', 'ubuntu', 'vscode', 'owner', 'default')
if ($userName -and $userName.Length -ge 4 -and ($genericNames -notcontains $userName.ToLowerInvariant())) {
    [void]$pathPatterns.Add(@{
        Name    = "本机用户名 ($userName)"
        Pattern = [regex]::Escape($userName)
    })
}

$pathHits = 0
foreach ($file in $scanFiles) {
    foreach ($p in $pathPatterns) {
        $matches = Select-String -LiteralPath $file.FullName -Pattern $p.Pattern -AllMatches -ErrorAction SilentlyContinue
        foreach ($m in $matches) {
            $pathHits++
            $preview = $m.Line.Trim()
            if ($preview.Length -gt 90) { $preview = $preview.Substring(0, 90) + '…' }
            Write-Fail ("{0}: {1}:{2}" -f $p.Name, $file.Name, $m.LineNumber)
            Write-Info ("  {0}" -f $preview)
        }
    }
}

if ($pathHits -eq 0) { Write-Pass '没有发现本机绝对路径或用户名' }

# ---------------------------------------------------------------------------
# 3. .gitignore 是否真的拦住了敏感文件
# ---------------------------------------------------------------------------

Write-Section '3. .gitignore 拦截检查'

$isGitRepo = Test-Path -LiteralPath (Join-Path $Root '.git')
$gitignorePath = Join-Path $Root '.gitignore'

# 需要被拦截的条目。第二列是"必须拦"还是"建议拦"。
$required = @(
    @{ Path = '.env';            Level = 'fail'; Why = '真实 API Key' },
    @{ Path = 'pet.log';         Level = 'fail'; Why = '运行日志' },
    @{ Path = 'dist/';           Level = 'fail'; Why = '构建产物' },
    @{ Path = 'node_modules/';   Level = 'fail'; Why = '依赖目录' },
    @{ Path = 'pet.config.json'; Level = 'warn'; Why = '本地配置' },
    @{ Path = 'pet-settings.json'; Level = 'warn'; Why = '运行期状态' }
)

if (-not (Test-Path -LiteralPath $gitignorePath)) {
    Write-Fail '仓库根目录没有 .gitignore'
} else {
    Write-Pass '.gitignore 存在'

    if ($isGitRepo) {
        Write-Info '检测到 git 仓库，使用 git check-ignore 判定（最准确）'
    } else {
        Write-Info '尚未初始化 git 仓库，改用 .gitignore 文本匹配判定'
    }

    # 文本兜底匹配：把 .gitignore 的规则行取出来做简单比对。
    $ignoreLines = @()
    foreach ($line in (Get-Content -LiteralPath $gitignorePath -Encoding UTF8 -ErrorAction SilentlyContinue)) {
        $trimmed = $line.Trim()
        if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }
        $ignoreLines += ($trimmed -replace '^/', '')
    }

    foreach ($item in $required) {
        $target = $item.Path
        $ignored = $false

        if ($isGitRepo) {
            & git -C $Root check-ignore -q -- $target 2>$null
            $ignored = ($LASTEXITCODE -eq 0)
        } else {
            $bare = $target.TrimEnd('/')
            foreach ($rule in $ignoreLines) {
                $r = $rule.TrimEnd('/')
                if ($r -eq $bare -or $r -eq ('*' + $bare) -or $r -eq ("*{0}" -f $target)) {
                    $ignored = $true
                    break
                }
                if ($r -like ('*.' + $bare)) { $ignored = $true; break }
                # 处理 *.log 这种通配
                if ($r.StartsWith('*.') -and $bare.EndsWith($r.Substring(1))) { $ignored = $true; break }
            }
        }

        if ($ignored) {
            Write-Pass ("{0} 已被忽略（{1}）" -f $target, $item.Why)
        } else {
            if ($item.Level -eq 'fail') {
                Write-Fail ("{0} 没有被忽略（{1}）" -f $target, $item.Why)
            } else {
                Write-Warn ("{0} 没有被忽略（{1}）" -f $target, $item.Why)
            }
        }
    }
}

# .env 是否真的存在（存在但被忽略是正确状态）
$envPath = Join-Path $Root '.env'
if (Test-Path -LiteralPath $envPath) {
    Write-Info '.env 存在于工作区 —— 请确认它确实被忽略（见上方结论），且从未提交过'
}

# ---------------------------------------------------------------------------
# 4. 附：git 历史里是否已经有敏感文件
# ---------------------------------------------------------------------------

Write-Section '4. git 历史检查'

if (-not $isGitRepo) {
    Write-Info '尚未初始化 git 仓库，跳过'
} else {
    $tracked = & git -C $Root ls-files 2>$null
    $sensitiveTracked = @()
    foreach ($t in $tracked) {
        $leaf = Split-Path -Leaf $t
        if ($leaf -eq '.env' -or $leaf -like '*.log' -or $leaf -eq 'pet.config.json') {
            $sensitiveTracked += $t
        }
    }
    if ($sensitiveTracked.Count -eq 0) {
        Write-Pass '已跟踪文件里没有 .env / 日志 / 本地配置'
    } else {
        foreach ($s in $sensitiveTracked) {
            Write-Fail ("已被 git 跟踪: {0}" -f $s)
        }
        Write-Info '从索引移除（不删文件）：git rm --cached <文件>'
        Write-Info '若已推送过，必须视为密钥已泄露并立刻在服务端吊销重签'
    }
}

# ---------------------------------------------------------------------------
# 汇总
# ---------------------------------------------------------------------------

Write-Section '汇总'

if ($script:FailureCount -eq 0) {
    Write-Host ("  通过：0 个阻断问题，{0} 个提醒" -f $script:WarningCount) -ForegroundColor Green
    Write-Host '  可以提交了。' -ForegroundColor Green
    Write-Host ''
    exit 0
}

Write-Host ("  阻断问题：{0} 个；提醒：{1} 个" -f $script:FailureCount, $script:WarningCount) -ForegroundColor Red
Write-Host '  请先处理上面标 [FAIL] 的项再提交。' -ForegroundColor Red
Write-Host ''
exit 1
