param(
  [Parameter(Mandatory = $true)][string]$LlbotConfigPath,
  [string]$TestApiPath
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)

$projectConfig = Get-Content -LiteralPath 'config.json' -Raw | ConvertFrom-Json
if ($projectConfig.modelName -eq 'PENDING_MODEL_CONFIGURATION' -or $projectConfig.modelUrl -match '/unconfigured$') {
  throw '请先填写实际 modelUrl 和 modelName'
}
if (-not $env:ALWAYSBACK_MODEL_API_KEY) {
  if (-not $TestApiPath) { throw '请设置 ALWAYSBACK_MODEL_API_KEY 或传入 -TestApiPath' }
  $apiLines = Get-Content -LiteralPath $TestApiPath
  $apiKeyLine = $apiLines | Where-Object { $_ -match '^\s*APIkey\s*=' } | Select-Object -First 1
  if (-not $apiKeyLine -or $apiKeyLine -notmatch '^\s*APIkey\s*=\s*["'']([^"'']+)["'']\s*$') {
    throw 'TestAPI.txt 未包含有效 APIkey 字段'
  }
  $env:ALWAYSBACK_MODEL_API_KEY = $Matches[1]
}

$state = Get-Content -LiteralPath 'data/state.json' -Raw | ConvertFrom-Json
if (-not $state.persona.active -or -not $state.relationship) {
  throw '请先完成角色卡和初始关系设定'
}

$llbot = Get-Content -LiteralPath $LlbotConfigPath -Raw | ConvertFrom-Json
$onebotUri = [uri]$projectConfig.onebotUrl
$entry = $llbot.ob11.connect | Where-Object {
  $_.type -eq 'ws' -and $_.enable -and $_.host -eq $onebotUri.Host -and $_.port -eq $onebotUri.Port
} | Select-Object -First 1
if (-not $entry) { throw 'LLBot 配置中未找到与 onebotUrl 匹配的正向 WebSocket 连接' }
$env:ALWAYSBACK_ONEBOT_TOKEN = $entry.token

node src/cli.mjs probe onebot
if ($LASTEXITCODE -ne 0) { throw 'OneBot 连接检查失败' }
node src/cli.mjs probe model
if ($LASTEXITCODE -ne 0) { throw '模型连接检查失败' }
node src/cli.mjs serve
