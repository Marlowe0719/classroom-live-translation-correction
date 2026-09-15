[CmdletBinding()]
param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$pageUrl = 'http://127.0.0.1:8766'

function Test-ClassroomReady {
  try {
    $health = Invoke-RestMethod "$pageUrl/api/profiles" -TimeoutSec 1
    return [bool]$health.protocols
  } catch { return $false }
}

try {
  if (-not (Test-ClassroomReady)) {
    $runtimePath = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (-not (Test-Path -LiteralPath $runtimePath -PathType Leaf)) { $runtimePath = (Get-Command node -ErrorAction Stop).Source }
    $serverPath = Join-Path $PSScriptRoot 'server.mjs'
    if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) { throw '未找到 server.mjs，请将启动文件保留在项目文件夹中。' }

    $logRoot = Join-Path $PSScriptRoot '.startup-logs'
    New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $outputLog = Join-Path $logRoot "$stamp.stdout.log"
    $errorLog = Join-Path $logRoot "$stamp.stderr.log"
    $startupProcess = Start-Process -FilePath $runtimePath -ArgumentList @(('"' + $serverPath + '"')) -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput $outputLog -RedirectStandardError $errorLog -PassThru

    $deadline = [DateTime]::UtcNow.AddSeconds(12)
    $ready = $false
    do {
      if (Test-ClassroomReady) { $ready = $true; break }
      Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)

    if (-not $ready) {
      $startupProcess.Refresh()
      if ($startupProcess.HasExited) { throw "服务启动后已退出（退出码 $($startupProcess.ExitCode)）。启动日志：$errorLog" }
      throw "服务尚未就绪。稍后可再次双击启动文件。启动日志：$errorLog"
    }
  }
  if (-not $NoBrowser) { Start-Process $pageUrl }
} catch {
  if ($NoBrowser) { throw }
  Write-Host '课堂翻译未能启动，尚未打开网页。' -ForegroundColor Red
  Write-Host $_.Exception.Message
  [void](Read-Host '按回车关闭此窗口')
  exit 1
}
