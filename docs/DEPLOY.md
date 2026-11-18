# デプロイ手順

使うサービスは次の3つです。

| 置くもの | サービス | 理由 |
| --- | --- | --- |
| Next.js（`web/`） | **Vercel** | Next.js の標準的なホスティング先 |
| 認証・DB | **Supabase** | Auth と Postgres と RLS が揃っている |
| オーケストレーター（`server/`） | **Render**（または Fly.io / Railway） | 数分間つなぎっぱなしの WebSocket が必要で、Vercel の関数では動かせない |

作業は次の順に進めます：Supabase → オーケストレーター → Vercel → URL の相互登録。

---

## 1. Supabase

1. https://supabase.com でプロジェクトを作成します（リージョンは Tokyo）。
2. **SQL Editor** に `supabase/migrations/0001_init.sql` の中身を貼り付けて実行します。
3. **Project Settings → API** から次の3つを控えます。
   - Project URL → `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL`
   - `anon` `public` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`（ブラウザに出てもよいキー）
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY`（**オーケストレーターだけ**に設定します。絶対に `web/` に置かないでください）
4. **Authentication → Sign In / Providers** で Email が有効になっていることを確認します。
5. 公開するなら **Authentication → Emails → SMTP Settings** で独自の SMTP（Resend など）を設定します。
   標準の送信機能は1時間あたりの送信数がとても少なく、デモ用途でもすぐ上限に達します。

> 自分だけ回数制限を緩めたいとき：Table Editor → `profiles` で自分の行の `daily_limit` を変更します。

## 2. オーケストレーター（Render の例）

1. 共有シークレットを作ります：`openssl rand -base64 32`
2. Render で **New → Blueprint** を選び、このリポジトリを指定します（`render.yaml` が読み込まれます）。
3. 次の環境変数を入力します。

   | 変数 | 値 |
   | --- | --- |
   | `LIVEAVATAR_API_KEY` | LiveAvatar の API キー |
   | `OPENAI_API_KEY` | OpenAI の API キー |
   | `ORCHESTRATOR_SECRET` | 手順1で作ったシークレット |
   | `ALLOWED_ORIGINS` | Vercel の URL（例：`https://talk-with-masahiro.vercel.app`）。手順3のあとで入力しても構いません |
   | `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Supabase で控えた値 |
   | `MAX_SESSION_SECONDS` | `300`（1回5分） |

4. デプロイが終わったら `https://<service>.onrender.com/healthz` が `ok` を返すことを確認します。

**プランについて**：Render の無料インスタンスはしばらくアクセスがないと停止し、
その間にプロセス内のセッションは消えます。デモを見てもらう期間は有料の Starter プランにしてください。

Fly.io / Railway / 自前のサーバーで動かす場合も、イメージは同じです。

```bash
docker build -f server/Dockerfile -t talk-orchestrator .   # リポジトリ直下で実行
docker run -p 8787:8787 --env-file .env talk-orchestrator
```

## 3. Vercel

1. **Add New → Project** でこのリポジトリをインポートします。
2. **Root Directory** に `web` を指定します。Framework は Next.js が自動で選ばれます。
   「Include files outside the root directory」は有効のままにしてください（`shared/` を参照するため）。
3. 次の環境変数を設定します。

   | 変数 | 値 |
   | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | Supabase の Project URL |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon key |
   | `ORCHESTRATOR_URL` | `https://<service>.onrender.com` |
   | `ORCHESTRATOR_SECRET` | オーケストレーターと**同じ値** |

4. デプロイします。

## 4. URL の相互登録

- **Supabase → Authentication → URL Configuration**
  - Site URL：`https://<your-app>.vercel.app`
  - Redirect URLs：`https://<your-app>.vercel.app/auth/callback`
    （プレビュー環境も使うなら `https://*-<team>.vercel.app/auth/callback` も追加）
- **Render** の `ALLOWED_ORIGINS` に Vercel の URL を入れて再デプロイします（独自ドメインがあればカンマ区切りで追加）。

## 5. 動作確認チェックリスト

- [ ] `/practice` を未ログインで開くと `/login` に移動する
- [ ] メールのリンクでログインでき、`/practice` に戻ってくる
- [ ] 「練習をはじめる」でアバターが日本語で挨拶する
- [ ] フレーズを言うと単語カードが出る
- [ ] 「今日の練習回数」が1増える。上限に達するとボタンが消える
- [ ] 終了後、`/history` と `/wordbook` に記録が出る
- [ ] 5分経つと自動で終了し、メッセージが表示される
- [ ] `curl -X POST https://<service>.onrender.com/api/session/start` が `401` を返す（シークレットなしでは誰も起動できない）

## うまくいかないとき

| 症状 | 確認すること |
| --- | --- |
| 「サーバーの設定が未完了です」 | Vercel に `ORCHESTRATOR_URL` と `ORCHESTRATOR_SECRET` が入っているか |
| 「アバターに接続できませんでした」 | Render のログ。`401` ならシークレットが Vercel と Render で一致していない。LiveAvatar / OpenAI のエラーもここに出る |
| 起動直後に「セッションが終了しました」 | WebSocket が拒否されている。`ALLOWED_ORIGINS` が実際の URL と完全に一致しているか（末尾の `/` は不要） |
| 履歴に記録が残らない | Render の `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`。ログの `[persist]` 行を確認 |
| ログインリンクで `/login?error=link` に戻る | リンクを別のブラウザで開いた、または Redirect URLs が未登録 |
