param([Parameter(Mandatory = $true)][string]$LlbotConfigPath)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
$llbot = Get-Content -LiteralPath $LlbotConfigPath -Raw | ConvertFrom-Json
$projectConfig = Get-Content -LiteralPath 'config.json' -Raw | ConvertFrom-Json
$onebotUri = [uri]$projectConfig.onebotUrl
$entry = $llbot.ob11.connect | Where-Object {
  $_.type -eq 'ws' -and $_.enable -and $_.host -eq $onebotUri.Host -and $_.port -eq $onebotUri.Port
} | Select-Object -First 1
if (-not $entry) { throw 'LLBot 配置中未找到与 onebotUrl 匹配的正向 WebSocket 连接' }
$env:ALWAYSBACK_ONEBOT_TOKEN = $entry.token
node scripts/probe-group-status.mjs
