import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const port = 18787;
const base = `http://127.0.0.1:${port}`;
let server;
let logs = "";
before(async () => {
  // Empty overrides prevent these tests from using a developer's real keys.
  server = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: fileURLToPath(new URL("../server/", import.meta.url)),
    env: {
      ...process.env,
      PORT: String(port),
      OPENAI_API_KEY: "",
      LIVEAVATAR_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (data) => {
    logs += data;
  });
  server.stderr.on("data", (data) => {
    logs += data;
  });
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) throw new Error(`Server exited: ${logs}`);
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`Server did not start: ${logs}`);
});
after(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await exited;
  }
});

test("configuration reports missing names, never secret values", async () => {
  const response = await fetch(`${base}/api/config`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    configured: false,
    missing: ["LIVEAVATAR_API_KEY", "OPENAI_API_KEY"],
  });
});

test("invalid input is rejected before a paid upstream session can start", async () => {
  for (const body of [
    null,
    {},
    {
      settings: {
        productName: "x".repeat(101),
        productDescription: "valid",
        customerContext: "",
      },
    },
  ]) {
    const response = await fetch(`${base}/api/session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
  }
});

test("valid form with missing keys gets a readable setup error", async () => {
  const response = await fetch(`${base}/api/session/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({
      settings: {
        productName: "営業支援",
        productDescription: "進捗確認の時間を減らす",
        customerContext: "",
      },
    }),
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /API設定/);
});

test("cross-origin access and unauthorized records/stops are rejected", async () => {
  assert.equal(
    (
      await fetch(`${base}/api/config`, {
        headers: { Origin: "https://unrelated.example" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${base}/api/rehearsals/unknown`, {
        headers: { Authorization: "Bearer invalid" },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await fetch(`${base}/api/session/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "unknown", accessToken: "invalid" }),
      })
    ).status,
    404,
  );
});
