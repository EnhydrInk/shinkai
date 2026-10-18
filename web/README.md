# 人のページ

`npm --prefix web run build` で `web/dist` に依存なしの静的サイトを生成します。`config.js` の `SHINKAI_SERVER` が既定のサーバーです。URL の `server` パラメーター、または画面の「設定」から変更できます。

URL の `room` が房間、`view` がブラウザーの独立した視点です。招待リンクからは `view` を除き、開いたページごとに生成します。座席の資格情報は server + room + view ごとに localStorage に保存します。AI token は URL に含めません。

API は server/worker.ts の human endpoint に対応します。WebSocket は humanToken を最初の authenticate メッセージで送り、state 更新を受信します。切断時は3秒後に再接続します。操作失敗・空状態には再接続、設定、入座のボタンがあります。

`qa-preview.html` は開発専用の四座席 fixture です。build はこのファイルを含めません。確認するときだけ dist へコピーし、http://localhost:5173 で配信してください。`qa-table.png` はこの fixture を実ブラウザーで表示した確認画像です。実際の四AI対局、+4受信、結局の完走は本番サーバーで別途確認が必要です。

表示は320×180 canvasの整数倍です。文字は公式 DotGothic16 をcanvasへ描き、alpha 128以上のピクセルのみ単色で転写しています。カード・キャラクター・扇貝は承認された art の同一素材を使用します。

文字は全UIで原生16px、ボタンは22px高です。名前・残り枚数をテーブル上で確認し、アバターを押すと会話全文を16pxで読めます。接続設定は3ページに分割しています。画像読み込み中の表示と失敗時の再読み込みがあります。
