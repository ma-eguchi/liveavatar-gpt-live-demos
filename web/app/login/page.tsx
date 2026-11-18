import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/env";
import { getUser } from "@/lib/user";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "ログイン" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/practice";
  if (await getUser()) redirect(safeNext);

  return (
    <div className="auth-wrap">
      <div className="card auth-card">
        <h1>ログイン</h1>
        <p>
          メールアドレスにログイン用のリンクを送ります。パスワードは不要です。
          はじめての方もそのまま登録されます。
        </p>
        {error === "link" && (
          <p className="form-error">リンクの有効期限が切れたか、別のブラウザで開かれました。もう一度送信してください。</p>
        )}
        {isSupabaseConfigured() ? (
          <LoginForm next={safeNext} />
        ) : (
          <div className="notice">
            Supabase が未設定です。<code>NEXT_PUBLIC_SUPABASE_URL</code> と{" "}
            <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> を設定してください（docs/DEPLOY.md）。
          </div>
        )}
      </div>
    </div>
  );
}
