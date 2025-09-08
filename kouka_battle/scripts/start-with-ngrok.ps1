# ngrok トンネルとアプリを同時に起動するスクリプト
param()

function Fail($msg) { Write-Host $msg -ForegroundColor Red; exit 1 }

# ngrok コマンド確認
if (-not (Get-Command ngrok -ErrorAction SilentlyContinue)) {
  Fail "ngrok が見つかりません。先に 'npm run ngrok:setup' を実行してください。"
}

Write-Host "ngrok を起動します…" -ForegroundColor Cyan
$ngrokProc = Start-Process -FilePath ngrok -ArgumentList @('http','3000') -PassThru
Start-Sleep -Seconds 2

# 4040 API が立ち上がるまで待機し、https URL を取得
$publicUrl = $null
for ($i=0; $i -lt 20; $i++) {
  try {
    $json = Invoke-RestMethod -Uri 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 2
    $https = ($json.tunnels | Where-Object { $_.public_url -like 'https*' } | Select-Object -First 1)
    if ($https) { $publicUrl = $https.public_url; break }
  } catch {}
  Start-Sleep -Milliseconds 600
}
if (-not $publicUrl) {
  try { Stop-Process -Id $ngrokProc.Id -Force } catch {}
  Fail "ngrok の公開URLが取得できませんでした。" 
}

Write-Host ("公開URL: {0}" -f $publicUrl) -ForegroundColor Green
Write-Host "このURLで主催画面を開くと、QR/リンクが ngrok ドメインで表示されます。" -ForegroundColor Green

# アプリ起動（PUBLIC_BASE_URL を注入）
Write-Host "アプリを起動します… (PUBLIC_BASE_URL を設定)" -ForegroundColor Cyan
$env:PUBLIC_BASE_URL = $publicUrl
Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Path) | Out-Null
Set-Location ..\ | Out-Null

# node を直接実行（終了で両方止めたい場合は Ctrl+C、ngrok は別プロセス）
& node server.js

# 終了時に ngrok を停止
try { Stop-Process -Id $ngrokProc.Id -Force } catch {}

