# ⚡ Lightning Monitor (GitHub Pages 版)

Blitzortung.org のリアルタイム落雷データを地図上に表示する **ブラウザ単体で動く** Web アプリです。
Electron 版（`../lightning-monitor`）をベースに、Node バックエンドなしで GitHub Pages 上だけで完結するよう作り直しています。

## このフォルダの中身（GitHub Pages にアップロードするファイル）

| ファイル | 役割 |
|---|---|
| `index.html` | エントリーポイント（UI） |
| `browser-api.js` | Electron の `electronAPI`（WebSocket受信 / 逆ジオコーディング）をブラウザの `WebSocket`・`fetch` で再現するシム |
| `renderer.js` | アプリ本体ロジック（Electron 版と同一・無改変） |
| `style.css` | スタイル（Electron 版と同一） |
| `.nojekyll` | GitHub Pages の Jekyll 処理を無効化 |

> Leaflet（地図ライブラリ）は CDN（unpkg）から読み込むため同梱不要です。

## API 受信について

- **落雷データ**: `wss://ws*.blitzortung.org` へブラウザから直接 WebSocket 接続します。
  WebSocket は CORS の対象外なので静的ホスティングでもそのまま受信できます。
  GitHub Pages は HTTPS なので `wss://`（セキュア）で接続し、混在コンテンツの問題は出ません。
- **地名（逆ジオコーディング）**: `https://nominatim.openstreetmap.org` へ `fetch` で直接アクセスします。
  Nominatim は CORS 許可済み。利用規約（1 リクエスト/秒）はシム側でキュー直列化して順守しています。

ローカル検証では受信・解析・地名取得すべて正常動作を確認済みです。

開できます。

```

## 利用規約について

- 本アプリは個人・非商用目的でのみ使用してください。
- Blitzortung.org のデータは商用利用禁止です。
- Nominatim は 1 リクエスト/秒の制限を遵守しています。
