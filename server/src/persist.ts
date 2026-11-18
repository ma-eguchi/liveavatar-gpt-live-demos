/**
 * Session-end persistence (hosted mode only): one RPC into Supabase with the
 * service role key — plain fetch against PostgREST, no client library.
 *
 * `record_session_end` (supabase/migrations) marks the practice session ended
 * and upserts its words into the user's wordbook. It is idempotent, so a retry
 * after a timeout cannot double-count.
 */

import type { TermCardProps } from "../../shared/messages";
import { config } from "./config";

export interface SessionEndRecord {
  practiceSessionId: string;
  upstreamSessionId: string;
  reason: string;
  durationSec: number;
  words: TermCardProps[];
}

export async function recordSessionEnd(record: SessionEndRecord): Promise<void> {
  const { supabaseUrl, supabaseServiceRoleKey } = config.hosted;
  if (!supabaseUrl || !supabaseServiceRoleKey) return;

  const body = JSON.stringify({
    p_session_id: record.practiceSessionId,
    p_upstream_session_id: record.upstreamSessionId,
    p_reason: record.reason,
    p_duration_sec: Math.round(record.durationSec),
    p_words: record.words,
  });

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(`${supabaseUrl}/rest/v1/rpc/record_session_end`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: supabaseServiceRoleKey,
          Authorization: `Bearer ${supabaseServiceRoleKey}`,
        },
        body,
        signal: AbortSignal.timeout(8_000),
      });
      if (response.ok) return;
      const text = await response.text();
      // 4xx will not get better on retry.
      if (response.status < 500) {
        console.warn(`[persist] record_session_end ${response.status}: ${text.slice(0, 300)}`);
        return;
      }
      console.warn(`[persist] attempt ${attempt} failed: ${response.status}`);
    } catch (err) {
      console.warn(`[persist] attempt ${attempt} failed: ${err}`);
    }
    await new Promise((r) => setTimeout(r, 500 * attempt));
  }
}
