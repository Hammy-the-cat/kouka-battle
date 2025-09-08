# 校歌バトル・教室対抗（kouka-battle)

ブラウザのマイクで「相対音量（RMS/Peak）」「安定性（振幅の揺らぎ）」「ピッチ誤差」を測定し、PIN で同じ大会に参加した各教室のスコアをリアルタイム表示します。

## セットアップ / 起動
```bash
npm install
npm start
# -> http://localhost:3000 を開く
```

HTTPS で配信する場合（スマホのマイク許可で推奨）
1. `kouka_battle/cert/` に `server.key` と `server.crt` を配置（例: mkcert で作成）
2. 環境変数 `HTTPS=1` を付けて起動
```bash
# 例（Linux/macOS）
HTTPS=1 npm start
# 例（PowerShell）
$env:HTTPS="1"; npm start
```

## 使い方（最短）
1. 主催者が「大会を作る」を押し、表示される PIN を各教室に共有
2. 各教室は PIN と教室名を入力して入室し、「静音キャリブ」を実施して「準備OK」
3. 主催者がラウンド名と秒数を設定して「ラウンド開始」を押すと、数秒後に同時スタート
4. 計測が終わると、自動でランキングが更新されます

## 主な仕様
- WebSocket によるリアルタイム同期（`/ws`）
- ラウンドはサーバ時刻基準で一斉スタート（遅延差を軽減）
- スコア設計
  - Loud: 最大40点（RMS/Peak の noiseFloor からの相対値で算出）
  - Unity: 最大25点（フレーム間の振幅変動の小ささを簡易指標化）
  - Pitch: 最大25点（A3=220Hz からのピッチ誤差。±50¢で満点近く）
  - Adj: 最大 -10点（クリップ率に応じた減点）
- 人数正規化: 合計点は人数でスケール（`public/app.js` を参照）

### 参加用QR / リンク共有
- ホストが部屋を作成すると、ロビーに「参加用リンク」と「QRコード」が表示されます
- QR は Google Chart API を使用（インターネット接続が必要）
- 参加URLは `https://<ホスト>/join?pin=XXXXXX` の形式

### ngrok（無料枠前提）
1) 初回設定
- https://ngrok.com/download から ngrok をダウンロードし PATH に通す
- `npm run ngrok:setup` を実行し、Authtoken を登録

2) 起動
- `npm run tunnel`
- コンソールに表示される `https://xxxxx.ngrok-free.app` を主催/参加端末で開く
- スクリプトが自動で `PUBLIC_BASE_URL` を注入するため、QR/リンクは ngrok URL になります
- 停止: サーバは `Ctrl+C`、ngrok は別ウィンドウ/タスクマネージャーで停止

### Cloudflare Tunnel（アカウント不要・簡易）
1) インストール
- winget: `winget install Cloudflare.cloudflared`
- choco:  `choco install cloudflared -y`

2) 起動
- `npm run tunnel:cf`
- 表示される `https://xxxxx.trycloudflare.com` を主催/参加端末で開く
- スクリプトが自動で `PUBLIC_BASE_URL` を注入するため、QR/リンクは Cloudflare ドメインで表示
- 停止: `Ctrl+C`（サーバ終了時に cloudflared も停止）

## 留意点 / 拡張
- ブラウザの AGC/NS/Echo の挙動は端末依存。静音キャリブで環境に合わせて補正してください
- ガイド音は A3 のサイン波に加え、各教室でローカル MP3/WAV を選んで再生可能（主催者パネル）
- 歌詞表示やトーナメント集計などは拡張で対応可能

## トラブルシュート
- スマホでマイク許可が出ない場合は HTTPS でアクセスしているか確認
- 接続が切れた場合、クライアントは自動再接続と状態復元（参加情報の再送）を試みます。復旧しない場合はリロード
