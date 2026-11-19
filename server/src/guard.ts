/**
 * Guardrails for a publicly reachable demo. Every session is billable
 * (LiveAvatar + OpenAI), so a URL handed to strangers needs a lock and a
 * budget. All of it is opt-in via env — unset, local dev behaves exactly as
 * before.
 *
 *   DEMO_PASSCODE          required passcode for /api/session/start
 *   MAX_CONCURRENT_SESSIONS  live sessions at once (0 = unlimited)
 *   MAX_SESSION_SECONDS    hard cap per session (0 = unlimited)
 *   DAILY_SESSION_LIMIT    session starts per UTC day (0 = unlimited)
 *
 * State is in-memory, like the session registry: a restart resets the daily
 * counter. Good enough for a portfolio demo; a real product would keep this
 * in a store and put auth in front.
 */

import { timingSafeEqual, createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { config } from "./config";

// Passcode brute-force damping: this many misses per IP per window → 429.
const FAIL_WINDOW_MS = 10 * 60_000;
const MAX_FAILS = 5;
const failures = new Map<string, { count: number; since: number }>();

let dayKey = "";
let startsToday = 0;

export type GuardResult = { ok: true } | { ok: false; status: number; error: string };

/** Whether the browser must show a passcode field. Exposed via /api/config. */
export function passcodeRequired(): boolean {
  return config.guard.passcode !== "";
}

/**
 * Gate a session start. On success the start is counted against the daily
 * budget, so call it only right before actually minting a session.
 */
export function admitStart(req: IncomingMessage, liveSessions: number): GuardResult {
  const g = config.guard;
  const ip = clientIp(req);

  if (g.passcode) {
    const fail = failures.get(ip);
    if (fail && Date.now() - fail.since > FAIL_WINDOW_MS) failures.delete(ip);
    if ((failures.get(ip)?.count ?? 0) >= MAX_FAILS) {
      return { ok: false, status: 429, error: "too many wrong passcodes — try again in a few minutes" };
    }
    const given = String(req.headers["x-demo-passcode"] ?? "");
    if (!sameSecret(given, g.passcode)) {
      const entry = failures.get(ip) ?? { count: 0, since: Date.now() };
      entry.count += 1;
      failures.set(ip, entry);
      return { ok: false, status: 401, error: "wrong passcode" };
    }
    failures.delete(ip);
  }

  if (g.maxConcurrent > 0 && liveSessions >= g.maxConcurrent) {
    return { ok: false, status: 503, error: "the demo is in use right now — please try again in a few minutes" };
  }

  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayKey) {
    dayKey = today;
    startsToday = 0;
  }
  if (g.dailyLimit > 0 && startsToday >= g.dailyLimit) {
    return { ok: false, status: 429, error: "today's demo quota is used up — please come back tomorrow" };
  }
  startsToday += 1;
  return { ok: true };
}

/** Constant-time compare that doesn't leak the length either. */
function sameSecret(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function clientIp(req: IncomingMessage): string {
  // Render / Fly / most PaaS put the real client first in X-Forwarded-For.
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}
