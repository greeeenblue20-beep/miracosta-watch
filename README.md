# ホテル空室監視

楽天トラベル空室検索API(公式API)で、`config.json` の監視条件ごとに空室を5分ごとに確認し、
新しく空きが出たらスマホへ ntfy で通知する。予約は通知を見て人が行う(公式 or 楽天)。

- 監視条件: `config.json` の `watches` に1件ずつ並べる
  - `hotelNo`: 楽天の施設番号 / `roomKeywords`: 部屋名・プラン名に含む語(空なら全部屋) / `adultNum` `roomNum`
  - 日程は `range`(start〜end の各1泊、fullStay で全期間連泊も)か `weekly`(今日から daysAhead 日先までの指定曜日。0=日〜6=土)
  - 期間が過ぎた条件は自動で確認しなくなる
- 主な施設番号: ミラコスタ 74733 / ランドホテル 74732 / ファンタジースプリングス 189000 / アンバサダー 72737 / トイ・ストーリー 183493 / セレブレーション 151431
- 実行場所: GitHub Actions(5分ごと)。分数無制限にするため**公開リポジトリ**で運用する(キー類は Secrets に入れるので公開されない)
- 同じ空きは1回だけ通知。前回の状態は `state.json` に保存。30日コミットが無いと自動でコミットし、60日無更新による定期実行停止を防ぐ
- API が全部エラーの時は「監視エラー」を1回だけ通知

## セットアップ

1. **楽天アプリ登録**: https://webservice.rakuten.co.jp/ でアプリを新規作成し、アプリID と アクセスキー を取得
   - アプリケーションタイプは「Webアプリケーション」、許可されたWebサイトは `github.com`(バックエンド型はIP指定になり Actions では使えない)
   - API呼び出し時は Origin/Referer に https://github.com を付ける(`RAKUTEN_REFERER` で変更可)
2. **ntfy**: スマホに「ntfy」アプリを入れ、`.env` の `NTFY_TOPIC` の値を購読(Subscribe)する
3. **GitHub**: 公開リポジトリを作り push。Settings → Secrets and variables → Actions に以下を登録
   - `RAKUTEN_APP_ID` / `RAKUTEN_ACCESS_KEY` / `NTFY_TOPIC`
4. Actions タブで `hotel-watch` を「Run workflow」して手動実行し、ログに各日の結果が出ればOK

## ローカル確認

```
node check.js --dry --fixture test/fixture.json   # ダミーデータで通知文を確認
node --env-file=.env check.js --dry               # 実APIで確認(通知はしない)
```

## 終了

期間が過ぎると何もせず終了する。不要になったら Actions でワークフローを Disable する。
