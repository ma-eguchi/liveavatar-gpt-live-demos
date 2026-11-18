import Link from "next/link";
import { REPO_URL } from "@/components/SiteChrome";
import { getUser } from "@/lib/user";

export default async function Home() {
  const user = await getUser();
  const cta = user ? "/practice" : "/login?next=/practice";

  return (
    <>
      <section className="hero">
        <div className="container">
          <span className="eyebrow">AIアバター × リアルタイム音声会話</span>
          <h1>
            話しかけるだけで、
            <br />
            <span className="gradient-text">英語が口から出てくる。</span>
          </h1>
          <p>
            AI英会話コーチの Masahiro と、ビデオ通話のように声で会話。
            教わったフレーズはその場で画面にカード表示され、あとから単語帳で復習できます。
          </p>
          <div className="hero-actions">
            <Link href={cta} className="btn btn-primary btn-lg">
              無料で練習してみる
            </Link>
            <a href="#how" className="btn btn-lg">
              仕組みを見る
            </a>
          </div>
          <div className="hero-note">ログインが必要です · 1日3回まで · マイクを使います</div>

          <div className="mock" aria-hidden="true">
            <div className="mock-avatar" />
            <div className="mock-bubble">Could you help me? …って、どういう時に使うの？</div>
            <div className="mock-card">
              <div className="t">Could you help me?</div>
              <div className="r">クッジュー ヘルプ ミー</div>
              <div className="m">手伝ってもらえますか？</div>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <h2>できること</h2>
          <p className="lead">「読む・書く」より先に「話す」から。初心者が最初につまずく一言目を練習します。</p>
          <div className="grid-3">
            <Feature
              title="声だけで会話できる"
              body="ボタンを押す必要はありません。話し終わりも割り込みもAIが判断するので、人と話すのと同じテンポで練習できます。"
              icon={<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3ZM5 10v2a7 7 0 0 0 14 0v-2M12 19v3" />}
            />
            <Feature
              title="単語がカードで見える"
              body="コーチが新しいフレーズを言うと、発音（カタカナ）と意味のカードが映像の上に表示されます。数語ごとに振り返りパネルも出ます。"
              icon={<path d="M4 5h16v14H4zM8 9h8M8 13h5" />}
            />
            <Feature
              title="単語帳に自動保存"
              body="練習で出てきたフレーズは自動で単語帳へ。フラッシュカードで復習し、覚えたものにチェックを付けられます。"
              icon={<path d="M4 4h12a4 4 0 0 1 4 4v12H8a4 4 0 0 1-4-4V4ZM8 8h8M8 12h6" />}
            />
          </div>
        </div>
      </section>

      <section className="section" id="how">
        <div className="container">
          <h2>使い方</h2>
          <p className="lead">1回のレッスンは最大5分。毎日少しずつ続けられる長さにしています。</p>
          <ol className="steps card">
            <li>メールアドレスでログイン（パスワード不要のログインリンクが届きます）</li>
            <li>「練習をはじめる」を押してマイクを許可すると、Masahiro が日本語で挨拶します</li>
            <li>教わったフレーズを声に出してまねする。発音はその場で直してもらえます</li>
            <li>終わったら単語帳で復習。履歴ページで練習した日と覚えた単語を振り返れます</li>
          </ol>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <h2>システム構成</h2>
          <p className="lead">
            ブラウザにAPIキーを一切渡さない設計です。音声はサーバー同士で中継し、
            ブラウザはアバターの映像を受け取ってマイク音声を送るだけです。
          </p>
          <div className="arch">
            <ArchNode
              title="Next.js アプリ"
              where="Vercel"
              body="画面・ログイン・利用回数チェック。セッション開始APIはここだけが持ち、ユーザー認証と回数制限を通った人だけがアバターを起動できます。"
            />
            <ArchNode
              title="Supabase"
              where="Auth / Postgres"
              body="メールリンク認証、練習履歴、単語帳。1日の回数制限はSQL関数の中で判定し、行レベルセキュリティで他人のデータは読めません。"
            />
            <ArchNode
              title="オーケストレーター"
              where="Node.js + WebSocket"
              body="GPT-Live（音声対話AI）の音声をアバターへ中継し、会話の流れに合わせて単語カードを出します。終了時に覚えた単語を DB へ保存します。"
            />
            <ArchNode
              title="OpenAI GPT-Live / HeyGen LiveAvatar"
              where="外部API"
              body="全二重の音声対話モデルと、リアルタイムに口が動くアバター映像（LiveKit 配信）。"
            />
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <h2>開発について</h2>
          <p className="lead">要件定義から設計・実装・デプロイまで、個人で開発したポートフォリオ作品です。</p>
          <div className="dev-note">
            <div className="card">
              <h3>設計・実装したところ</h3>
              <ul>
                <li>Next.js（App Router）での画面・API・認証フロー</li>
                <li>Supabase のテーブル設計、RLS、回数制限のSQL関数</li>
                <li>オーケストレーターの認証（共有シークレット＋使い捨てチケット）</li>
                <li>セッション時間の上限・終了時の単語保存</li>
                <li>英会話コーチのペルソナと教え方（プロンプト設計）</li>
                <li>履歴・単語帳・フラッシュカード復習</li>
              </ul>
            </div>
            <div className="card">
              <h3>気をつけたこと</h3>
              <ul>
                <li>1回ごとに API 料金がかかるため、ログイン・1日の回数・時間の上限で費用を制御</li>
                <li>ブラウザにAPIキーを渡さず、AIの出力は画面に出す前に検証</li>
                <li>覚えた単語のリストはAIの記憶ではなくサーバーの記録から作る</li>
              </ul>
              <p className="muted" style={{ fontSize: 13, lineHeight: 1.7, marginTop: 12 }}>
                音声中継の土台には HeyGen が MIT ライセンスで公開しているリファレンス実装を使い、
                その上にプロダクトとして必要な部分を作っています。詳しくは{" "}
                <a href={REPO_URL} target="_blank" rel="noreferrer">
                  GitHub
                </a>{" "}
                をご覧ください。
              </p>
            </div>
          </div>
          <div style={{ marginTop: 32, textAlign: "center" }}>
            <Link href={cta} className="btn btn-primary btn-lg">
              Masahiro と話してみる
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}

function Feature({ title, body, icon }: { title: string; body: string; icon: React.ReactNode }) {
  return (
    <div className="card feature">
      <div className="icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {icon}
        </svg>
      </div>
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}

function ArchNode({ title, where, body }: { title: string; where: string; body: string }) {
  return (
    <div className="node">
      <h4>{title}</h4>
      <div className="where">{where}</div>
      <p>{body}</p>
    </div>
  );
}
