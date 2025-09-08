# Cloudflare Tunnel (cloudflared) で公開して起動するスクリプト
param()

function Fail($msg) { Write-Host $msg -ForegroundColor Red; exit 1 }

if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
  Write-Host "cloudflared が見つかりません。以下のいずれかでインストールしてください:" -ForegroundColor Yellow
  Write-Host " winget:  winget install Cloudflare.cloudflared"
  Write-Host " choco :  choco install cloudflared -y"
  Fail "インストール後に 'npm run tunnel:cf' を再実行してください。"
}

# 出力ログファイル
$logsDir = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..\\logs'
if (-not (Test-Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir | Out-Null }
$logFile = Join-Path $logsDir 'cloudflared.log'
if (Test-Path $logFile) { Remove-Item $logFile -Force }

Write-Host "cloudflared を起動します…" -ForegroundColor Cyan
$cfArgs = @('tunnel','--url','http://localhost:3000','--logfile', $logFile,'--no-autoupdate')
$cf = Start-Process -FilePath cloudflared -ArgumentList $cfArgs -PassThru

# 公開URLをログから検出
$publicUrl = $null
for ($i=0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 500
  if (-not (Test-Path $logFile)) { continue }
  try {
    $content = Get-Content -LiteralPath $logFile -ErrorAction SilentlyContinue
    foreach ($line in $content) {
      if ($line -match 'https://[a-z0-9\-]+\.trycloudflare\.com') { $publicUrl = $Matches[0]; break }
    }
    if ($publicUrl) { break }
  } catch {}
}
if (-not $publicUrl) {
  try { Stop-Process -Id $cf.Id -Force } catch {}
  Fail "公開URLが検出できませんでした。"
}

Write-Host ("公開URL: {0}" -f $publicUrl) -ForegroundColor Green
Write-Host "このURLで主催画面を開くと、QR/リンクが Cloudflare ドメインで表示されます。" -ForegroundColor Green

# アプリ起動（PUBLIC_BASE_URL を注入）
Write-Host "アプリを起動します… (PUBLIC_BASE_URL を設定)" -ForegroundColor Cyan
$env:PUBLIC_BASE_URL = $publicUrl

Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Path) | Out-Null
Set-Location ..\ | Out-Null

& node server.js

# 終了時に cloudflared を停止
try { Stop-Process -Id $cf.Id -Force } catch {}

