[CmdletBinding()]
param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$pageUrl = 'http://127.0.0.1:8766'
$launcherLog = $null
$launchLock = $null
$ownsLock = $false
$lastReadyIssue = '服务尚未响应。'

function Write-LauncherLog([string]$Message) {
  if ($launcherLog) {
    try { Add-Content -LiteralPath $launcherLog -Value ((Get-Date -Format o) + ' ' + $Message) -Encoding UTF8 }
    catch { Write-Warning '无法写入启动诊断日志。' }
  }
}

function Test-ClassroomReady {
  try {
    $health = Invoke-RestMethod "$pageUrl/api/profiles" -TimeoutSec 1
    if (-not $health.protocols) { throw '配置接口未返回课堂平台信息。' }
    $audioModule = Invoke-WebRequest "$pageUrl/pcm-worklet.js" -UseBasicParsing -TimeoutSec 1
    if ($audioModule.StatusCode -ne 200 -or $audioModule.Headers['Content-Type'] -notmatch '(text|application)/javascript' -or
        $audioModule.Content -notmatch "registerProcessor\('classroom-pcm'") { throw '音频采集模块未能正常加载。' }
    $script:lastReadyIssue = ''
    return $true
  } catch { $script:lastReadyIssue = $_.Exception.Message; return $false }
}

function Get-ClassroomProcessId {
  $listener = Get-NetTCPConnection -LocalPort 8766 -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -eq '127.0.0.1' } | Select-Object -First 1
  if ($listener) { return $listener.OwningProcess }
  return 'unknown'
}

try {
  $logRoot = Join-Path $PSScriptRoot '.startup-logs'
  New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
  $stamp = (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + "-$PID"
  $launcherLog = Join-Path $logRoot "$stamp.launcher.log"
  Write-LauncherLog "REQUEST launcherPid=$PID noBrowser=$NoBrowser"

  # Serialize double-clicks so two launchers cannot both claim a free port.
  $launchLock = New-Object System.Threading.Mutex($false, 'Local\ClassroomApiLab-8766-Launcher')
  try { $ownsLock = $launchLock.WaitOne(20000) }
  catch [System.Threading.AbandonedMutexException] { $ownsLock = $true }
  if (-not $ownsLock) { throw '另一个课堂启动器仍在启动，请稍后再试。' }

  $startupProcess = $null
  if (-not (Test-ClassroomReady)) {
    Write-LauncherLog "NOT_READY $lastReadyIssue"
    $existingProcessId = Get-ClassroomProcessId
    if ($existingProcessId -ne 'unknown') {
      Write-LauncherLog "WAIT_EXISTING serverPid=$existingProcessId"
    } else {
      $runtimePath = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
      if (-not (Test-Path -LiteralPath $runtimePath -PathType Leaf)) { $runtimePath = (Get-Command node -ErrorAction Stop).Source }
      $serverPath = Join-Path $PSScriptRoot 'server.mjs'
      if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) { throw '未找到 server.mjs，请将启动文件保留在项目文件夹中。' }

      $outputLog = Join-Path $logRoot "$stamp.stdout.log"
      $errorLog = Join-Path $logRoot "$stamp.stderr.log"
      $startupProcess = Start-Process -FilePath $runtimePath -ArgumentList @(('"' + $serverPath + '"')) -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput $outputLog -RedirectStandardError $errorLog -PassThru
      Write-LauncherLog "STARTED serverPid=$($startupProcess.Id) runtime=$runtimePath stderr=$errorLog"
    }
  } else {
    Write-LauncherLog "REUSED serverPid=$(Get-ClassroomProcessId)"
  }

  # Check the lazily loaded worklet as well as the API, and allow an early
  # startup failure to surface before opening a page that appears usable.
  $deadline = [DateTime]::UtcNow.AddSeconds(12)
  $stableChecks = 0
  $stableProcessId = $null
  do {
    if ($startupProcess) {
      $startupProcess.Refresh()
      if ($startupProcess.HasExited) { throw "服务启动后已退出（退出码 $($startupProcess.ExitCode)）。启动日志：$errorLog" }
    }
    if (Test-ClassroomReady) {
      $checkedProcessId = Get-ClassroomProcessId
      if ($checkedProcessId -eq 'unknown') { $stableChecks = 0 }
      elseif ($checkedProcessId -eq $stableProcessId) { $stableChecks++ }
      else { $stableProcessId = $checkedProcessId; $stableChecks = 1 }
    } else { $stableChecks = 0 }
    if ($stableChecks -ge 2) { break }
    Start-Sleep -Milliseconds 750
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($stableChecks -lt 2) { throw "服务未能稳定就绪，或 8766 端口被其他程序占用：$lastReadyIssue" }
  if ($startupProcess) {
    $startupProcess.Refresh()
    if ($startupProcess.HasExited) { throw "服务已退出。启动日志：$errorLog" }
  }
  Write-LauncherLog "READY serverPid=$(Get-ClassroomProcessId) api=ok audioModule=ok"
  if (-not $NoBrowser) { Start-Process $pageUrl; Write-LauncherLog 'BROWSER_OPENED' }
} catch {
  Write-LauncherLog "FAILED $($_.Exception.Message)"
  if ($NoBrowser) { throw }
  Write-Host '课堂翻译未能启动，尚未打开网页。' -ForegroundColor Red
  Write-Host $_.Exception.Message
  if ($launcherLog) { Write-Host "启动诊断日志：$launcherLog" }
  [void](Read-Host '按回车关闭此窗口')
  exit 1
} finally {
  if ($ownsLock) { $launchLock.ReleaseMutex() }
  if ($launchLock) { $launchLock.Dispose() }
}
