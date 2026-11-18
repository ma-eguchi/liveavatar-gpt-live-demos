/**
 * POST /api/session/start — the only door to a billable session.
 *
 *   1. who is it?            Supabase user from the cookie (401 if none)
 *   2. may they?             start_practice_session() RPC: daily quota, atomic in SQL
 *   3. start the avatar      orchestrator /api/session/start (Bearer secret)
 *   4. hand back             LiveKit creds + a websocket URL carrying a single-use ticket
 *
 * If step 3 fails the quota slot is given back (fail_practice_session).
 */
import { NextResponse } from "next/server";
import type { SessionStartResponse } from "@/lib/api";
import { serverEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "ログインしてください" }, { status: 401 });

  let env: ReturnType<typeof serverEnv>;
  try {
    env = serverEnv();
  } catch (err) {
    console.error("[session/start]", err);
    return NextResponse.json({ error: "サーバーの設定が未完了です" }, { status: 500 });
  }

  const { data: quota, error: quotaError } = await supabase
    .rpc("start_practice_session", { p_mode: "english_coach" })
    .single<{ session_id: string; used_today: number; daily_limit: number }>();
  if (quotaError || !quota) {
    if (quotaError?.message.includes("daily_limit_reached")) {
      return NextResponse.json(
        { error: "今日の練習回数の上限に達しました。また明日どうぞ！" },
        { status: 429 },
      );
    }
    console.error("[session/start] quota rpc failed:", quotaError);
    return NextResponse.json({ error: "セッションを開始できませんでした" }, { status: 500 });
  }

  let upstream: {
    session_id: string;
    livekit_url: string;
    livekit_client_token: string;
    ws_path: string;
    max_session_seconds?: number;
  };
  try {
    const response = await fetch(`${env.orchestratorUrl}/api/session/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.orchestratorSecret}`,
      },
      body: JSON.stringify({ practice_session_id: quota.session_id, user_id: user.id }),
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
    const body = (await response.json()) as typeof upstream & { error?: string };
    if (!response.ok) throw new Error(body.error ?? `orchestrator ${response.status}`);
    upstream = body;
  } catch (err) {
    console.error("[session/start] orchestrator failed:", err);
    await supabase.rpc("fail_practice_session", {
      p_session_id: quota.session_id,
      p_reason: err instanceof Error ? err.message.slice(0, 200) : "orchestrator error",
    });
    return NextResponse.json(
      { error: "アバターに接続できませんでした。少し時間をおいて試してください" },
      { status: 502 },
    );
  }

  const wsBase = env.orchestratorPublicUrl.replace(/^http/, "ws");
  const payload: SessionStartResponse = {
    practice_session_id: quota.session_id,
    livekit_url: upstream.livekit_url,
    livekit_client_token: upstream.livekit_client_token,
    ws_url: `${wsBase}${upstream.ws_path}`,
    max_session_seconds: upstream.max_session_seconds ?? 0,
    used_today: quota.used_today,
    daily_limit: quota.daily_limit,
  };
  return NextResponse.json(payload, { status: 201 });
}
