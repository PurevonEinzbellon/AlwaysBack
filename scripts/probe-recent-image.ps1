param(
  [Parameter(Mandatory = $true)][string]$LlbotConfigPath,
  [string]$TestApiPath
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)

if (-not $env:ALWAYSBACK_MODEL_API_KEY) {
  if (-not $TestApiPath) { throw '请设置 ALWAYSBACK_MODEL_API_KEY 或传入 -TestApiPath' }
  $apiKeyLine = Get-Content -LiteralPath $TestApiPath | Where-Object { $_ -match '^\s*APIkey\s*=' } | Select-Object -First 1
  if (-not $apiKeyLine -or $apiKeyLine -notmatch '^\s*APIkey\s*=\s*["'']([^"'']+)["'']\s*$') {
    throw '密钥文件未包含有效 APIkey 字段'
  }
  $env:ALWAYSBACK_MODEL_API_KEY = $Matches[1]
}
$projectConfig = Get-Content -LiteralPath 'config.json' -Raw | ConvertFrom-Json
$llbot = Get-Content -LiteralPath $LlbotConfigPath -Raw | ConvertFrom-Json
$onebotUri = [uri]$projectConfig.onebotUrl
$entry = $llbot.ob11.connect | Where-Object {
  $_.type -eq 'ws' -and $_.enable -and $_.host -eq $onebotUri.Host -and $_.port -eq $onebotUri.Port
} | Select-Object -First 1
if (-not $entry) { throw 'LLBot 配置中未找到与 onebotUrl 匹配的正向 WebSocket 连接' }
$env:ALWAYSBACK_ONEBOT_TOKEN = $entry.token
node scripts/probe-recent-image.mjs
