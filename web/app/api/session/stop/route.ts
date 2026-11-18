/**
 * POST /api/session/stop — end a session the caller owns. Also the target of
 * the pagehide sendBeacon, so it must accept a bare JSON blob.
 *
 * Closing the websocket already ends the session on the orchestrator; this is
 * for the gap where a session was minted but the socket never connected.
 */
import { NextResponse, type NextRequest } from "next/server";
import { serverEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse(null, { status: 401 });

  let practiceSessionId: unknown;
  try {
    practiceSessionId = ((await request.json()) as { practice_session_id?: unknown })
      .practice_session_id;
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  if (typeof practiceSessionId !== "string") return new NextResponse(null, { status: 400 });

  // RLS: this only finds the row if it is the caller's own.
  const { data: row } = await supabase
    .from("practice_sessions")
    .select("id, status")
    .eq("id", practiceSessionId)
    .maybeSingle();
  if (!row || row.status !== "starting") return new NextResponse(null, { status: 204 });

  try {
    const env = serverEnv();
    await fetch(`${env.orchestratorUrl}/api/session/stop`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.orchestratorSecret}`,
      },
      body: JSON.stringify({ practice_session_id: practiceSessionId }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    // The orchestrator's idle watchdog reaps it anyway.
    console.warn("[session/stop] forward failed:", err);
  }
  return new NextResponse(null, { status: 204 });
}
