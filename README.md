# Talk with Masahiro — AIアバター英会話コーチ

**AIアバターと声で会話しながら英語のフレーズを覚える Web アプリです。**
英会話コーチの「Masahiro」とビデオ通話のように話すと、教わったフレーズが発音と意味のカードで画面に表示され、
レッスンが終わると単語帳に自動で保存されます。

- **公開URL**: `https://<your-app>.vercel.app` ← デプロイ後に差し替え
- **デモ動画**: `<YouTube / Loom のURL>` ← 録画後に差し替え
- **開発**: 個人開発（要件定義・設計・実装・デプロイ）。詳しくは [docs/PORTFOLIO.md](docs/PORTFOLIO.md)

| 技術 | 用途 |
| --- | --- |
| **Next.js 16**（App Router, Route Handlers, Proxy） | 画面、ログイン、セッション開始API |
| **Supabase**（Auth, Postgres, RLS, SQL関数） | メールリンク認証、練習履歴、単語帳、1日の回数制限 |
| **Node.js + WebSocket** | 音声の中継サーバー（オーケストレーター） |
| **OpenAI GPT-Live** | 全二重の音声対話モデル（話し終わり・割り込みをAIが判断） |
| **HeyGen LiveAvatar + LiveKit** | リアルタイムに口が動くアバター映像 |
| TypeScript / pnpm workspace / Vercel / Docker | |

## 機能

- **声だけで会話**：押して話すボタンはありません。ターンの切り替えはAIが判断します
- **単語カード**：コーチが新しいフレーズを言うと、カタカナ発音と日本語訳が映像に重なって表示されます
- **振り返りパネル**：数語ごとにアバターが画面の隅に小さくなり、これまでの単語を一覧で復習します
- **単語帳**：レッスンで出たフレーズを自動保存。「覚えた」チェック、フラッシュカード、ブラウザ読み上げに対応
- **練習履歴**：レッスン回数、練習した日数、合計時間、レッスンごとのフレーズ
- **費用の上限**：ログイン必須、1人1日3回（DBで判定）、1回5分（サーバーで強制終了）

## 構成

```
 ブラウザ ─────── HTTPS ───────► Next.js (Vercel)                  Supabase
   │  ▲                           ├ /login        メールリンク ───► Auth
   │  │                           ├ /practice /history /wordbook ─► Postgres (RLS)
   │  │                           └ /api/session/start
   │  │                               1. ログイン確認
   │  │                               2. start_practice_session()  ← 1日の回数をSQLで判定
   │  │                               3. オーケストレーターへ（共有シークレット）
   │  │                                          │
   │  │ マイク音声 / 文字起こし・単語カード     ▼
   │  └──── WebSocket（使い捨てチケット）── オーケストレーター (Node)
   │                                         │  ├─ GPT-Live（音声対話）
   │  アバター映像・音声                      │  └─ LiveAvatar メディアサーバー
   └◄──────────── LiveKit ◄───────────────────┘
                                             終了時 record_session_end() ─► Supabase
```

- ブラウザにはAPIキーを一切渡しません。受け取るのは LiveKit の視聴トークンと、そのセッション専用の WebSocket チケットだけです。
- Vercel は WebSocket を常時接続できないため、音声中継は別サーバー（Render / Fly.io / Railway など）で動かします。
- 1日の回数制限は SQL 関数の中で「数える＋登録する」を1トランザクションで行うので、タブを2つ開いて同時に押しても上限を超えません。
- 覚えた単語は、AIの記憶ではなくサーバーが実際に表示したカードの記録から保存します。

## ローカルで動かす

必要なもの：Node 20.12 以上、pnpm、[Supabase](https://supabase.com) プロジェクト（無料枠で可）、
[LiveAvatar の API キー](https://app.liveavatar.com)、GPT-Live が使える OpenAI API キー。

```bash
pnpm install

# 1. Supabase の SQL Editor で supabase/migrations/0001_init.sql を実行
#    Authentication → URL Configuration の Redirect URLs に http://localhost:3000/auth/callback を追加

# 2. オーケストレーターの設定（リポジトリ直下の .env）
pnpm run setup                 # LiveAvatar / OpenAI のキーを確認して .env を作成
#    続けて .env に ORCHESTRATOR_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY を追記（.env.example 参照）

# 3. Next.js の設定
cp web/.env.example web/.env.local   # Supabase の URL / anon key と、同じ ORCHESTRATOR_SECRET を記入

pnpm dev                       # web → http://localhost:3000, オーケストレーター → :8787
```

本番へのデプロイ手順は [docs/DEPLOY.md](docs/DEPLOY.md) にあります。

## ディレクトリ

| パス | 内容 |
| --- | --- |
| `web/app/` | Next.js の画面と API（LP、ログイン、練習、履歴、単語帳、`/api/session/*`） |
| `web/proxy.ts` | Supabase のセッション更新と、未ログイン時のリダイレクト |
| `web/lib/avatar/` | ブラウザ側のセッション制御：LiveKit 接続、マイク取り込み（AudioWorklet）、オーバーレイ |
| `web/public/overlays/` | 単語カード・振り返りパネルのアニメーション（映像の上に重ねる透明ページ） |
| `supabase/migrations/` | テーブル、RLS、回数制限・終了記録の SQL 関数 |
| `server/src/` | オーケストレーター：GPT-Live ↔ アバターの音声中継、ツール呼び出し、認証、DB 保存 |
| `server/prompts/*.md` | コーチのペルソナ（話し方・教え方） |
| `shared/` | ブラウザとサーバーで共有する型（通信プロトコル、ツール定義） |

技術的な詳細：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)（音声中継の設計）、
[AGENTS.md](AGENTS.md)（コードの地図と守るべき前提）。

## 開発の経緯と担当範囲

音声中継の土台（`server/src/` の GPT-Live・LiveAvatar 接続、ブラウザのマイク取り込みとオーバーレイ）は、
HeyGen が MIT ライセンスで公開しているリファレンス実装
[heygen-com/liveavatar-language-demo](https://github.com/heygen-com/liveavatar-language-demo) をベースにしています。

その上に、公開サービスとして必要な部分を個人で設計・実装しました。

- 英会話コーチのペルソナとレッスン設計
- Next.js アプリ全体（LP、認証、練習画面の移植、履歴、単語帳、フラッシュカード）
- Supabase のスキーマ、RLS、回数制限・終了記録の SQL 関数
- オーケストレーターの本番モード：共有シークレット、WebSocket チケット、Origin 制限、時間上限、DB 保存
- サーバー側から終了したときにブラウザへ通知されない不具合の修正
- デプロイ構成（Vercel + Docker / Render）

範囲ごとの詳細は [docs/PORTFOLIO.md](docs/PORTFOLIO.md) にまとめています。

## ライセンス

MIT（[LICENSE](LICENSE)）。同梱の GSAP（`web/public/overlays/vendor/gsap.min.js`）は
[GSAP Standard License](https://gsap.com/standard-license) に従います。[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照してください。
