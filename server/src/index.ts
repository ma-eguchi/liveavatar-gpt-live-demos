/**
 * HTTP + WebSocket entrypoint.
 *
 *   POST /api/session/start  → mint + start a LITE session, spin up the legs
 *   POST /api/session/stop   → tear one down
 *   GET  /healthz
 *   WS   /ws/:sessionId      → the browser leg: mic audio up; transcripts,
 *                              tool visuals, and errors down
 *
 * Two modes, picked by ORCHESTRATOR_SECRET:
 *
 *  - local (unset): the original open starter. Anyone who can reach the port
 *    can start a session. Never expose it like this.
 *  - hosted (set): only the Next.js backend may call /api/session/* (Bearer
 *    secret; it has already authenticated the user and charged their daily
 *    quota). The browser connects the websocket directly — Vercel cannot
 *    proxy websockets — so the upgrade needs the single-use ticket minted by
 *    /start, and its Origin must be in ALLOWED_ORIGINS.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";
import type { ClientMessage } from "../../shared/messages";
import { config, missingConfig } from "./config";
import { LiveAvatarApiError, startSession as startUpstream } from "./liveavatar";
import {
  addSession,
  findByPracticeId,
  getSession,
  stopAll,
  stopSession,
} from "./registry";
import { Session, type SessionOwner } from "./session";

const hosted = Boolean(config.hosted.secret);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const server = createServer((req, res) => {
  void route(req, res).catch((err: unknown) => {
    console.error("[http] unhandled:", err);
    if (!res.headersSent) json(res, 500, { error: "internal error" });
  });
});

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;

  if (path === "/healthz") {
    res.writeHead(200).end("ok");
    return;
  }
  if (req.method === "POST" && (path === "/api/session/start" || path === "/api/session/stop")) {
    if (hosted && !hasSecret(req)) {
      json(res, 401, { error: "unauthorized" });
      return;
    }
    return path === "/api/session/start" ? handleStart(req, res) : handleStop(req, res);
  }
  res.writeHead(404, { "Content-Type": "text/plain" }).end("orchestrator — see /healthz");
}

function hasSecret(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? "";
  return safeEqual(header, `Bearer ${config.hosted.secret}`);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

async function handleStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const missing = missingConfig();
  if (missing.length > 0) {
    json(res, 500, { error: `missing env vars: ${missing.join(", ")} — copy .env.example to .env` });
    return;
  }

  let owner: SessionOwner | null = null;
  if (hosted) {
    const body = (await readJson(req)) as { practice_session_id?: unknown; user_id?: unknown };
    if (
      typeof body.practice_session_id !== "string" ||
      !UUID_RE.test(body.practice_session_id) ||
      typeof body.user_id !== "string" ||
      !UUID_RE.test(body.user_id)
    ) {
      json(res, 400, { error: "practice_session_id and user_id are required" });
      return;
    }
    owner = {
      practiceSessionId: body.practice_session_id,
      userId: body.user_id,
      wsTicket: randomBytes(24).toString("base64url"),
    };
  }

  try {
    const upstream = await startUpstream();
    const session = new Session(
      upstream.sessionId,
      upstream.wsUrl,
      (id) => {
        void stopSession(id, "leg_died");
      },
      owner,
    );
    addSession(session);
    session.start();
    console.log(`[http] session started: ${upstream.sessionId}`);
    const wsPath = owner
      ? `/ws/${upstream.sessionId}?ticket=${owner.wsTicket}`
      : `/ws/${upstream.sessionId}`;
    json(res, 201, {
      session_id: upstream.sessionId,
      livekit_url: upstream.livekitUrl,
      livekit_client_token: upstream.livekitClientToken,
      // Relative: the caller resolves it against wherever it reached us
      // (the Next.js backend prefixes its public orchestrator URL).
      ws_path: wsPath,
      max_session_seconds: config.maxSessionSeconds,
    });
  } catch (err) {
    const message =
      err instanceof LiveAvatarApiError
        ? err.message
        : err instanceof Error
          ? err.message
          : "session start failed";
    console.error(`[http] session start failed: ${message}`);
    // Hosted callers (the Next.js backend) log the detail and show the user a
    // generic message; local developers want it verbatim.
    json(res, 502, { error: message });
  }
}

async function handleStop(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readJson(req)) as { session_id?: string; practice_session_id?: string };
  if (typeof body.session_id === "string") {
    await stopSession(body.session_id, "client_stop");
  } else if (typeof body.practice_session_id === "string") {
    const session = findByPracticeId(body.practice_session_id);
    if (session) await stopSession(session.sessionId, "client_stop");
  }
  // Already-gone is success: the caller wanted it gone and it is gone.
  res.writeHead(204).end();
}

// ── browser websocket ─────────────────────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "", "http://x");
  const match = /^\/ws\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  const session = match?.[1] ? getSession(match[1]) : undefined;
  const reject = (status: string) => {
    socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
    socket.destroy();
  };
  if (!session) return reject("404 Not Found");

  if (hosted) {
    const origin = (req.headers.origin ?? "").replace(/\/+$/, "");
    if (config.hosted.allowedOrigins.length > 0 && !config.hosted.allowedOrigins.includes(origin)) {
      return reject("403 Forbidden");
    }
    const ticket = url.searchParams.get("ticket") ?? "";
    if (!session.owner || !safeEqual(ticket, session.owner.wsTicket)) {
      return reject("401 Unauthorized");
    }
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    // One browser per session. The loser of a race (second tab, double click)
    // closes without entering the teardown below, so it cannot stop the
    // winner's session.
    if (!session.tryAttachFrontend(ws)) {
      ws.close(1008, "already connected");
      return;
    }
    console.log(`[ws] browser attached: ${session.sessionId}`);

    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        return;
      }
      if (msg.type === "mic_audio" && typeof msg.audio === "string" && msg.audio) {
        session.sendMicAudio(msg.audio);
      } else if (msg.type === "stop") {
        ws.close(1000);
      }
    });

    ws.on("close", () => {
      session.detachFrontend(ws);
      // The browser leaving ends the session — there is no reconnect path, and
      // a session nobody is watching should not keep billing.
      void stopSession(session.sessionId, "frontend_disconnect");
    });
  });
});

// ── boot ──────────────────────────────────────────────────────────────────────

server.listen(config.port, () => {
  console.log(
    `[server] listening on http://localhost:${config.port} (${hosted ? "hosted" : "local"} mode)`,
  );
  const missing = missingConfig();
  if (missing.length > 0) {
    console.warn(`[server] ⚠ missing env vars: ${missing.join(", ")} — sessions will not start`);
    console.warn("[server]   copy .env.example to .env at the repo root and fill it in");
  }
});

// Sessions live in this process; a shutdown is the end of them. Stop them
// upstream on the way out rather than leaving them to the billing clock.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void stopAll().finally(() => process.exit(0));
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk.toString()));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}
