"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export function LoginForm({ next }: { next: string }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setState("sending");
    const supabase = createClient();
    const redirectTo = new URL("/auth/callback", window.location.origin);
    redirectTo.searchParams.set("next", next);
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: redirectTo.toString() },
    });
    if (error) {
      setState("idle");
      setError(
        error.status === 429
          ? "送信回数が多すぎます。少し時間をおいてから試してください。"
          : "送信できませんでした。メールアドレスを確認してください。",
      );
      return;
    }
    setState("sent");
  }

  if (state === "sent") {
    return (
      <div className="notice" role="status">
        <strong>{email}</strong> にログインリンクを送りました。
        メールを開いて、このブラウザでリンクをクリックしてください。
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit}>
      <div className="field">
        <label htmlFor="email">メールアドレス</label>
        <input
          id="email"
          className="input"
          type="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <button type="submit" className="btn btn-primary" style={{ width: "100%" }} disabled={state === "sending"}>
        {state === "sending" ? "送信中…" : "ログインリンクを送る"}
      </button>
      {error && <p className="form-error">{error}</p>}
    </form>
  );
}
