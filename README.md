# 商談リハーサル

初回商談の前に、顧客役のライブアバターと5分間練習するローカルWebアプリです。
[HeyGenのサンプル](https://github.com/heygen-com/liveavatar-gpt-live-demos)から派生しています。

## この段階でできること

- 商材名、解決する課題、商談相手の情報を入力。
- GPT-Liveによる顧客役と、LiveAvatarの映像・音声を通じて日本語で会話。
- マイク確認、ミュート、5分の時間上限、手動終了。
- 会話記録を読み返し、自分で振り返る4つの観点を確認。
- 同じ顧客条件で再挑戦。

**AIによる採点・改善例の生成はまだ実装していません。** 振り返り画面の確認事項は固定の自己振り返り用です。会話の音声・動画は保存しません。会話テキストは短期間のメモリ保持で、サーバーを再起動すると消えます。SQLiteへの永続保存、長期履歴、チーム管理、課金は後続の段階です。

## 起動

Node.js 20.12以上とpnpmが必要です。

```sh
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev
```

`.env` が既にある場合はコピーせず、そのファイルを編集してください。
ブラウザで http://localhost:5173 を開きます。APIキーがなくても設定画面を確認できます。会話を開始するには、`.env` に次の値を設定してサーバーを再起動してください。

| 環境変数 | 用途 |
| --- | --- |
| `OPENAI_API_KEY` | GPT-Liveへアクセス可能なOpenAI APIキー |
| `LIVEAVATAR_API_KEY` | LiveAvatar APIキー |
| `LIVEAVATAR_AVATAR_ID` | 任意。既定値は `.env.example` に記載 |

キーをブラウザやGitへ含めないでください。対話式の設定を使う場合は `pnpm run setup` を実行します。接続中はAPIの利用料金が発生します。

## 検証

```sh
pnpm typecheck
pnpm test
pnpm build
```

ブラウザテストは別途 `pnpm test:e2e` で実行します。初回は `pnpm exec playwright install chromium` でテスト用ブラウザを導入してください。ブラウザテストの接続先は模擬応答に置き換え、外部APIの利用料金を発生させません。実APIでの音声・アバター・遅延の確認は別途必要です。

## 開発範囲

- `web/`: 設定、練習、振り返りの3画面。
- `shared/rehearsal.ts`: 設定・開始・結果の型。
- `server/`: 顧客役プロンプト、会話セッション、結果保持。
- [MVP全体の仕様](tasks/sales-rehearsal-mvp.md): 後続の評価・永続保存も含む。
- [今回の実装と検証](tasks/todo.md): 第1段階の実装範囲と確認結果。

既存forkの `master` は英会話用の変更を含むため、この実装は上流の `daa8cc9` を起点に `codex/sales-rehearsal-mvp` ブランチで開発しています。

## 利用範囲

この段階はローカル利用を前提とします。外部公開用の招待ログイン、利用枠、永続保存は未実装です。ローカルの開始・停止・結果取得にはセッション資格情報とオリジン検証を用いますが、公開サービスの認証を代替するものではありません。

## ライセンス

MIT。上流に含まれるGSAPは独自のライセンスです。[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)を参照してください。
