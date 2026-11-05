$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$runtimeDir = Join-Path $repoRoot 'web-data\mobile-test'
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$cloudflaredExe = Join-Path $env:APPDATA 'xdg.config\.wrangler\cloudflared\2026.10.3\cloudflared.exe'
$cloudflaredConfig = Join-Path $env:USERPROFILE '.cloudflared\config.yml'
$tunnelPidFile = Join-Path $runtimeDir 'permanent-tunnel.pid.json'

function Test-LocalHealth([int] $port) {
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/health" -UseBasicParsing -TimeoutSec 3
    return $response.StatusCode -eq 200
  } catch { return $false }
}

function Ensure-LocalService([int] $port, [string] $entrypoint, [string] $logName) {
  $child = $null
  for ($attempt = 0; $attempt -lt 24; $attempt++) {
    if (Test-LocalHealth $port) { return }
    if ($null -eq $child -or $child.HasExited) {
      $child = Start-Process -FilePath $nodeExe -ArgumentList @($entrypoint) `
        -WorkingDirectory $repoRoot -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $runtimeDir "$logName.out.log") `
        -RedirectStandardError (Join-Path $runtimeDir "$logName.err.log") -PassThru
    }
    Start-Sleep -Seconds 5
  }
  throw "BillMitra on port $port did not become ready."
}

Ensure-LocalService 3017 'web-data/mobile-test/start-server.cjs' 'permanent-server'
Ensure-LocalService 3019 'scripts/mobile-preview-proxy.cjs' 'permanent-proxy'

if (-not (Test-Path -LiteralPath $cloudflaredConfig)) { throw 'Named tunnel configuration is missing.' }
if (-not (Test-Path -LiteralPath $cloudflaredExe)) { throw 'cloudflared.exe is missing.' }
$tunnelRunning = $false
if (Test-Path -LiteralPath $tunnelPidFile) {
  try {
    $record = Get-Content -LiteralPath $tunnelPidFile -Raw | ConvertFrom-Json
    $existing = Get-Process -Id ([int] $record.pid) -ErrorAction Stop
    $tunnelRunning = $existing.Path -eq $cloudflaredExe -and
      $existing.StartTime.ToUniversalTime().Ticks -eq [long] $record.startedTicks
  } catch { $tunnelRunning = $false }
}

if (-not $tunnelRunning) {
  $tunnel = Start-Process -FilePath $cloudflaredExe `
    -ArgumentList @('--config', $cloudflaredConfig, 'tunnel', 'run', 'billmitra-mobile') `
    -WorkingDirectory $repoRoot -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $runtimeDir 'permanent-tunnel.out.log') `
    -RedirectStandardError (Join-Path $runtimeDir 'permanent-tunnel.err.log') -PassThru
  @{ pid = $tunnel.Id; startedTicks = $tunnel.StartTime.ToUniversalTime().Ticks } |
    ConvertTo-Json -Compress | Set-Content -LiteralPath $tunnelPidFile -Encoding ascii
}
