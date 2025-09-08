# ngrok 初期設定スクリプト（Windows PowerShell）
param()

function Fail($msg) { Write-Host $msg -ForegroundColor Red; exit 1 }

# ngrok コマンド確認
if (-not (Get-Command ngrok -ErrorAction SilentlyContinue)) {
  Write-Host "ngrok が見つかりません。以下からダウンロードして PATH へ追加してください:" -ForegroundColor Yellow
  Write-Host "https://ngrok.com/download"
  Write-Host "ダウンロード後、ngrok.exe をインストールし、再度このコマンドを実行してください: npm run ngrok:setup"
  exit 1
}

Write-Host "ngrok の Authtoken を貼り付けて Enter を押してください（https://dashboard.ngrok.com/get-started/your-authtoken）:" -ForegroundColor Cyan
$token = Read-Host "Authtoken"
if ([string]::IsNullOrWhiteSpace($token)) { Fail "トークンが空です。やり直してください。" }

try {
  & ngrok config add-authtoken $token | Out-Null
  Write-Host "ngrok のトークン登録が完了しました。" -ForegroundColor Green
} catch {
  Fail "トークン登録に失敗しました。エラーメッセージ: $_"
}

Write-Host "次へ: npm run tunnel を実行すると、ngrok とアプリが起動します。" -ForegroundColor Green

