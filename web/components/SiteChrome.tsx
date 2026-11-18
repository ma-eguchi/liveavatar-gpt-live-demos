import Link from "next/link";
import { getUser } from "@/lib/user";
import { NavLinks } from "./NavLinks";

export const REPO_URL = "https://github.com/ma-eguchi/liveavatar-gpt-live-demos";

export async function SiteHeader() {
  const user = await getUser();
  return (
    <header className="site-header">
      <div className="container">
        <Link href="/" className="brand">
          <span className="mark" aria-hidden="true" />
          Talk with Masahiro
        </Link>
        <nav className="nav" aria-label="メイン">
          {user ? (
            <>
              <NavLinks />
              <form action="/auth/signout" method="post">
                <button type="submit">ログアウト</button>
              </form>
            </>
          ) : (
            <Link href="/login">ログイン</Link>
          )}
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="container">
        <span>© {new Date().getFullYear()} Talk with Masahiro — 個人開発プロジェクト</span>
        <span>
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            GitHub
          </a>
          {" · "}
          Next.js · Supabase · OpenAI GPT-Live · HeyGen LiveAvatar
        </span>
      </div>
    </footer>
  );
}
