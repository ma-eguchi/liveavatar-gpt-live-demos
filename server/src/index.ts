/**
 * HTTP + WebSocket entrypoint.
 *
 *   POST /api/session/start  → mint + start a LITE session, spin up the legs
 *   POST /api/session/stop   → tear one down
 *   GET  /healthz
 *   WS   /ws/:sessionId      → the browser leg: mic audio up; transcripts,
 *                              tool visuals, and errors down
 *
 * In dev the web app runs on Vite (:5173) and proxies /api and /ws here, so
 * the browser sees one origin. In production this server also serves the built
 * frontend from web/dist.
 *
 * Local pilot: loopback binding, Host/Origin checks and per-attempt capabilities.
 * External deployment requires account authentication and persistent limits.
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import type { ClientMessage } from "../../shared/messages";
import { config, missingConfig } from "./config";
import {
  stopSession as stopUpstream,
  startSession as startUpstream,
} from "./liveavatar";
import {
  activeCount,
  addSession,
  getSession,
  stopAll,
  stopSession,
} from "./registry";
import { Session } from "./session";
import { attempts, validateSettings } from "./attemptStore";
import { localRequestAllowed } from "./localAccess";
import type {
  StartRehearsalRequest,
  StartRehearsalResponse,
} from "../../shared/rehearsal";

const WEB_DIST = fileURLToPath(new URL("../../web/dist", import.meta.url));
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

const server = createServer((req, res) => {
  void route(req, res).catch((err: unknown) => {
    console.error("[http] unhandled:", err);
    if (!res.headersSent) json(res, 500, { error: "internal error" });
  });
});

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!localRequestAllowed(req)) {
    json(res, 403, { error: "ローカルの同一オリジンからのみ利用できます。" });
    return;
  }
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (req.method === "GET" && path === "/api/config") {
    const missing = missingConfig();
    json(res, 200, { configured: missing.length === 0, missing });
    return;
  }
  const resultMatch = /^\/api\/rehearsals\/([A-Za-z0-9_-]+)$/.exec(path);
  if (req.method === "GET" && resultMatch) {
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    const attempt = attempts.authorize(resultMatch[1]!, token);
    json(
      res,
      attempt ? 200 : 404,
      attempt?.result ?? { error: "記録が見つかりません。" },
    );
    return;
  }

  if (path === "/healthz") {
    res.writeHead(200).end("ok");
    return;
  }
  if (req.method === "POST" && path === "/api/session/start")
    return handleStart(req, res);
  if (req.method === "POST" && path === "/api/session/stop")
    return handleStop(req, res);
  if (path.startsWith("/api/")) {
    json(res, 404, { error: "not found" });
    return;
  }
  return serveStatic(res, path);
}

let starting = false;
async function handleStart(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: StartRehearsalRequest;
  let settings;
  try {
    body = (await readJson(req)) as StartRehearsalRequest;
    settings = validateSettings(body.settings);
  } catch {
    json(res, 400, {
      error:
        "商材名100文字・説明1000文字・相手情報500文字以内で入力してください。",
    });
    return;
  }
  const previous = body.previousAttemptId
    ? attempts.authorize(body.previousAttemptId, body.previousAccessToken)
    : undefined;
  if (body.previousAttemptId && !previous) {
    json(res, 403, { error: "再挑戦する記録を確認できません。" });
    return;
  }
  const missing = missingConfig();
  if (missing.length) {
    json(res, 503, { error: `API設定が必要です: ${missing.join(", ")}` });
    return;
  }
  if (starting || activeCount()) {
    json(res, 409, { error: "別の練習を終了してから開始してください。" });
    return;
  }
  starting = true;
  const attempt = attempts.create(settings, previous);
  let upstreamId: string | undefined;
  try {
    const upstream = await startUpstream();
    upstreamId = upstream.sessionId;
    attempt.sessionId = upstreamId;
    if (res.destroyed) throw new Error("start cancelled");
    const session = new Session(
      upstream.sessionId,
      upstream.wsUrl,
      attempt,
      (id, reason) => {
        void stopSession(id, reason);
      },
    );
    addSession(session);
    session.start();
    const response: StartRehearsalResponse = {
      session_id: upstream.sessionId,
      attemptId: attempt.result.attemptId,
      accessToken: attempt.token,
      livekit_url: upstream.livekitUrl,
      livekit_client_token: upstream.livekitClientToken,
      ws_path: `/ws/${upstream.sessionId}?token=${attempt.token}`,
      customer: attempt.result.customer,
      durationSeconds: 300,
    };
    json(res, 201, response);
  } catch {
    if (upstreamId) {
      if (!(await stopSession(upstreamId, "start_failed")))
        await stopUpstream(upstreamId).catch(() => {});
    }
    attempts.finish(attempt, "start_failed");
    if (!res.destroyed)
      json(res, 502, {
        error:
          "会話を開始できませんでした。APIキーと利用枠を確認してください。",
      });
  } finally {
    starting = false;
  }
}
async function handleStop(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: { session_id?: string; accessToken?: string };
  try {
    body = (await readJson(req)) as typeof body;
  } catch {
    json(res, 400, { error: "invalid request" });
    return;
  }
  if (
    typeof body?.session_id !== "string" ||
    !attempts.forSession(body.session_id, body.accessToken)
  ) {
    json(res, 404, { error: "セッションが見つかりません。" });
    return;
  }
  await stopSession(body.session_id, "client_stop");
  res.writeHead(204).end();
}

async function serveStatic(
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  let rel = decodeURIComponent(pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  const filePath = normalize(join(WEB_DIST, rel));
  if (!filePath.startsWith(normalize(WEB_DIST))) {
    res.writeHead(403).end();
    return;
  }
  try {
    if ((await stat(filePath)).isDirectory()) throw new Error("dir");
    res.writeHead(200, {
      "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream",
    });
    res.end(await readFile(filePath));
  } catch {
    // Overlay compositions must 404 rather than fall through to the app shell:
    // the hyperframes player would load index.html with a 200, find no
    // timeline, and report a generic timeout that looks like a broken
    // composition instead of a missing file.
    if (rel.startsWith("/overlays/")) {
      res.writeHead(404).end("composition not found");
      return;
    }
    try {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(await readFile(join(WEB_DIST, "index.html")));
    } catch {
      res
        .writeHead(404)
        .end("not found — in dev, use the Vite server (pnpm dev)");
    }
  }
}

// ── browser websocket ─────────────────────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "", "http://localhost");
  if (!localRequestAllowed(req, true)) {
    socket.destroy();
    return;
  }
  const match = /^\/ws\/([A-Za-z0-9_-]+)$/.exec(
    new URL(req.url ?? "", "http://x").pathname,
  );
  const session = match?.[1] ? getSession(match[1]) : undefined;
  if (
    !session ||
    !attempts.forSession(session.sessionId, url.searchParams.get("token"))
  ) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
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
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "begin") session.begin();
      else if (
        msg.type === "mic_audio" &&
        typeof msg.audio === "string" &&
        msg.audio
      ) {
        session.sendMicAudio(msg.audio);
      } else if (msg.type === "stop") {
        void stopSession(session.sessionId, "client_stop");
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

server.listen(config.port, "127.0.0.1", () => {
  console.log(`[server] listening on http://localhost:${config.port}`);
  const missing = missingConfig();
  if (missing.length > 0) {
    console.warn(
      `[server] ⚠ missing env vars: ${missing.join(", ")} — sessions will not start`,
    );
    console.warn(
      "[server]   copy .env.example to .env at the repo root and fill it in",
    );
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
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString();
      if (Buffer.byteLength(data) > 16_384) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}
