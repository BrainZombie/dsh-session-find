# 安装 / 卸载 dsh-session-find（免 pnpm：junction + cordis.patch.yml 追加）
#
#   powershell -ExecutionPolicy Bypass -File .\install.ps1            # 干跑，只打印计划
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Apply     # 真装
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Rollback  # 卸掉
#
# 只碰两处：profiles/<profile>/node_modules 下的 junction、profile 的 cordis.patch.yml。
# 不写 package.json、不跑 pnpm、不动 dsh.profile.bundles。

param(
    [string]$Profile = 'web',
    [switch]$Apply,
    [switch]$Rollback
)

$ErrorActionPreference = 'Stop'
$source = Split-Path -Parent $MyInvocation.MyCommand.Path
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileDir = Join-Path $dshHome "profiles\$Profile"
$pluginDir = Join-Path $profileDir 'node_modules\dsh-session-find'
$patchFile = Join-Path $profileDir 'cordis.patch.yml'
$marker = '# >>> dsh-session-find'

if (-not (Test-Path $profileDir)) { throw "profile 不存在：$profileDir" }

function Show-Plan {
    Write-Host "源目录    : $source"
    Write-Host "profile   : $profileDir"
    Write-Host "junction  : $pluginDir"
    Write-Host "patch     : $patchFile"
    $exists = Test-Path $pluginDir
    $patched = (Test-Path $patchFile) -and ((Get-Content $patchFile -Raw) -like "*$marker*")
    Write-Host "当前状态  : junction=$(if ($exists) {'存在'} else {'无'}) / patch=$(if ($patched) {'已写入'} else {'未写入'})"
}

if ($Rollback) {
    Show-Plan
    if (Test-Path $pluginDir) {
        $item = Get-Item $pluginDir -Force
        if ($item.LinkType -eq 'Junction' -or $item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            [IO.Directory]::Delete($pluginDir, $false)
            Write-Host '已删除 junction'
        } else {
            Write-Warning "$pluginDir 不是 junction，跳过（请人工确认）"
        }
    }
    if (Test-Path $patchFile) {
        $content = Get-Content $patchFile -Raw
        $pattern = "(?ms)^\r?\n?# >>> dsh-session-find.*?# <<< dsh-session-find\r?\n?"
        $next = [regex]::Replace($content, $pattern, '')
        if ($next -ne $content) {
            Copy-Item $patchFile "$patchFile.bak-session-find-rollback" -Force
            Set-Content -Path $patchFile -Value $next -NoNewline -Encoding utf8
            Write-Host '已从 cordis.patch.yml 摘除配置段'
        }
    }
    Write-Host '回滚完成（重启宿主后生效）'
    exit 0
}

Show-Plan
if (-not $Apply) {
    Write-Host "`n这是干跑。加 -Apply 真正写入。"
    exit 0
}

if (-not (Test-Path $pluginDir)) {
    New-Item -ItemType Junction -Path $pluginDir -Target $source | Out-Null
    Write-Host "已建立 junction → $source"
} else {
    Write-Host 'junction 已存在，跳过'
}

if (-not ((Get-Content $patchFile -Raw) -like "*$marker*")) {
    Copy-Item $patchFile "$patchFile.bak-session-find-$(Get-Date -Format yyyyMMdd-HHmmss)" -Force
    $block = @"

$marker >>> 由 dsh-session-find 安装脚本追加；Rollback 会整段摘除
- insert:
    - id: session-find
      name: dsh-session-find
      config:
        indexPath: ''
        redact: false
        extraRedactPatterns: []
        includeArchived: true
        maxResults: 40
        snippetChars: 240
        autoSync: true
# <<< dsh-session-find
"@
    Add-Content -Path $patchFile -Value $block -Encoding utf8
    Write-Host '已追加配置段'
} else {
    Write-Host '配置段已存在，跳过'
}

Write-Host "`n完成。重启宿主后生效：session_find / session_show / session_index 三个工具。"
