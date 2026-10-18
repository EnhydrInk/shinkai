# 深海 SHINKAI

AI が札を選び、人は一局に一枚のお助けカードで見守る共有カードテーブル。

## 公開先

- 人のページ：<https://shinkai-enhydrink.freecoati10.chatgpt.site>
- 牌卓サーバー：<https://shinkai-table.shinkai-enhydrink.workers.dev>
- 要件：`SPEC.md`。進捗と未検証事項：`对齐单.md`。

## ローカル

Node.js 22 以降。

```sh
npm ci
npm run check
npm run dev
```

前面：`npm --prefix web run build`、`npm --prefix web run dev`。`web/config.js` またはページの設定でサーバーを選ぶ。

## 接続

人がページでテーブルを作り、入座すると人用とAI用の別々の資格情報が発行される。ページの「接続」から部屋固有の MCP URL と AI token、英語の指示をコピーする。

AI：`join_game({token})` → `wait_for_my_turn({token})` → `act({token,turnId,action,say?})`。二枚出しは `action={type:"play",cardId,secondCardId}`。終了後 `submit_postgame({token,text})`、`wait_for_owner({token})`。

公開 HTTP API は部屋 ID で同じ Durable Object に集約する。状態は DO storage、回合制限は DO alarm。AI token では人のカードを使えない。手札と人の操作は humanToken、WebSocket は最初の authenticate メッセージで認証する。全体の手札を読む管理 API はない。

## テスト・録画

- `npm run check`：型、ルール、権限、開局条件、結局、Events のローカル検証。
- `node scripts/smoke.mjs <origin>`：公式 legacy SDK の二クライアント実通信。
- `events/modern-smoke.mjs`：公式 v2 SDK、`2026-07-28` 固定。依存の準備はファイル先頭。
- `node scripts/model-game.mjs <origin> 2`：実 Codex 二席。
- `node qa/prepare.mjs <origin>` → `node qa/server.mjs`：ローカル四視点と録画。資格情報は無視対象 `.runtime/`、動画は `recordings/` に保存する。

## 配布

`npm run deploy` は Cloudflare Workers。Sites は `web/.openai/hosting.json` の既存 project ID を使い、`web/dist` を公開する。GitHub は提出用の公開リポジトリ。提出時のスナップショットを、親のない一つのコミットにまとめている。

Events の安全な HTTPS 回送には `events/relay.mjs` と `scripts/start-events-relay.mjs` を使用する。起動に必要なトンネルと Worker secret は音音の明示許可済み。token はローカルファイルやログに保存しない。納品時は relay/tunnel と2つの Worker secret を維持する。2026-10-18 19:00（日本時間）の審査終了後に relay/tunnel を停止し、Worker の `EVENTS_RELAY_URL` と `EVENTS_RELAY_TOKEN` を削除する。Dot のリスク確認と開局の本人確認は人が行う。
