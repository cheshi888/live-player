# start.ps1 — Windows 一键启动
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$env:PORT = if ($env:PORT) { $env:PORT } else { '8090' }

# 若已有实例在跑则复用(幂等)
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:$($env:PORT)/api/status" -UseBasicParsing -TimeoutSec 3
  if ($r.StatusCode -eq 200) {
    Write-Host "已有实例在运行: http://localhost:$($env:PORT)/"
    exit 0
  }
} catch {}

# 后台启动
$p = Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $PSScriptRoot `
  -RedirectStandardOutput "$PSScriptRoot\server.log" -RedirectStandardError "$PSScriptRoot\server.err.log" `
  -PassThru -WindowStyle Hidden
Write-Host "已启动 (pid $($p.Id)), 日志: $PSScriptRoot\server.log"

# 健康检查
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$($env:PORT)/api/status" -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) {
      Write-Host "✓ 服务健康: http://localhost:$($env:PORT)/"
      exit 0
    }
  } catch {}
}
Write-Host "✗ 30s 内未健康, 查看 server.log / server.err.log"
exit 1
