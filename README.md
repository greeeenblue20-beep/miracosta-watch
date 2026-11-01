# ミラコスタ空室監視

楽天トラベル空室検索API(公式API)で、ミラコスタのハーバービュー(大人4名・1室)の空きを5分ごとに確認し、
新しく空きが出たらスマホへ ntfy で通知する。予約は通知を見て人が行う(公式 or 楽天)。

- 監視対象: `config.json`(期間 12/31〜1/5 の各1泊 + 全期間連泊、部屋名に「ハーバービュー」を含むもの)
- 実行場所: GitHub Actions(5分ごと)。分数無制限にするため**公開リポジトリ**で運用する(キー類は Secrets に入れるので公開されない)
- 同じ空きは1回だけ通知。前回の状態は `state.json` に保存
- API が全部エラーの時は「監視エラー」を1回だけ通知

## セットアップ

1. **楽天アプリ登録**: https://webservice.rakuten.co.jp/ でアプリを新規作成し、アプリID と アクセスキー を取得
   - アプリケーションタイプは「Webアプリケーション」、許可されたWebサイトは `github.com`(バックエンド型はIP指定になり Actions では使えない)
   - API呼び出し時は Origin/Referer に https://github.com を付ける(`RAKUTEN_REFERER` で変更可)
2. **ntfy**: スマホに「ntfy」アプリを入れ、`.env` の `NTFY_TOPIC` の値を購読(Subscribe)する
3. **GitHub**: 公開リポジトリを作り push。Settings → Secrets and variables → Actions に以下を登録
   - `RAKUTEN_APP_ID` / `RAKUTEN_ACCESS_KEY` / `NTFY_TOPIC`
4. Actions タブで `miracosta-watch` を「Run workflow」して手動実行し、ログに各日の結果が出ればOK

## ローカル確認

```
node check.js --dry --fixture test/fixture.json   # ダミーデータで通知文を確認
node --env-file=.env check.js --dry               # 実APIで確認(通知はしない)
```

## 終了

期間が過ぎると何もせず終了する。不要になったら Actions でワークフローを Disable する。
