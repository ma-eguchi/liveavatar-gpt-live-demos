// Browser integration tests use mock HTTP/WS/LiveKit responses, never paid APIs.
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const base = "http://127.0.0.1:15173";
let server, browser;
let logs = "";
before(async () => {
  server = spawn(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "--host",
      "127.0.0.1",
      "--port",
      "15173",
      "--strictPort",
    ],
    { cwd: `${root}web`, stdio: ["ignore", "pipe", "pipe"] },
  );
  server.stdout.on("data", (data) => {
    logs += data;
  });
  server.stderr.on("data", (data) => {
    logs += data;
  });
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(logs);
    try {
      if ((await fetch(base)).ok) break;
    } catch {}
    await delay(100);
  }
  browser = await chromium.launch({
    headless: true,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  });
  await mkdir(`${root}test-results`, { recursive: true });
});
after(async () => {
  await browser?.close();
  if (server?.exitCode === null) {
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await exited;
  }
});

async function fixture(options = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    permissions: ["microphone"],
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const requests = { starts: [], stops: [], begins: 0, mic: 0 };
  const customer = {
    name: "佐藤",
    role: "導入検討の担当者",
    situation: "営業8名のチームで、案件管理の見直しを検討しています。",
  };
  const turns = [
    {
      id: "assistant_1",
      role: "assistant",
      text: "佐藤です。本日はよろしくお願いします。",
      done: true,
    },
    {
      id: "user_2",
      role: "user",
      text: "現在、案件の進捗はどのように確認されていますか？",
      done: true,
    },
    {
      id: "assistant_3",
      role: "assistant",
      text: "Excelを使っていますが、更新の確認に時間がかかっています。",
      done: true,
      uncertain: true,
    },
  ];
  let current, endedReason;
  const records = new Map();
  const fulfill = (route, data, status = 200) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(data),
    });
  await page.route("**/api/config", (route) =>
    fulfill(route, {
      configured: !options.missing,
      missing: options.missing ? ["OPENAI_API_KEY", "LIVEAVATAR_API_KEY"] : [],
    }),
  );
  await page.route("**/api/session/start", async (route) => {
    const body = route.request().postDataJSON();
    requests.starts.push(body);
    if (options.startDelay) await delay(options.startDelay);
    if (options.startFailure)
      return fulfill(
        route,
        {
          error:
            "会話を開始できませんでした。APIキーと利用枠を確認してください。",
        },
        502,
      );
    current = {
      session_id: `session-${requests.starts.length}`,
      attemptId: `attempt-${requests.starts.length}`,
      accessToken: "test-capability",
      livekit_url: "wss://test.invalid",
      livekit_client_token: "test-token",
      ws_path: "/ws/test?token=test-capability",
      customer,
      durationSeconds: 300,
    };
    records.set(current.attemptId, {
      session: current,
      settings: body.settings,
    });
    await fulfill(route, current, 201);
  });
  await page.route("**/api/session/stop", (route) => {
    requests.stops.push(route.request().postDataJSON());
    return route.fulfill({ status: 204 });
  });
  await page.route("**/api/rehearsals/*", async (route) => {
    assert.equal(
      route.request().headers().authorization,
      "Bearer test-capability",
    );
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    const record = records.get(id);
    const data = {
      attemptId: id,
      settings: record.settings,
      customer,
      status: endedReason === "leg_died" ? "incomplete" : "completed",
      startedAt: Date.now() - 35000,
      endedAt: Date.now(),
      endReason: endedReason ?? "client_stop",
      turns: options.distinctResults
        ? turns.map((turn) => ({ ...turn, text: `${turn.text} (${id})` }))
        : turns,
      evaluationStatus: "not_implemented",
    };
    if (options.resultHook) return options.resultHook(route, data, fulfill);
    if (options.resultFailure)
      return fulfill(route, { error: "unavailable" }, 503);
    return fulfill(route, data);
  });
  await page.route("**/src/livekitRoom.ts*", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `export async function joinAvatarRoom(url, token, elements, signal) {
    window.__mockRoomJoins = (window.__mockRoomJoins || 0) + 1;
    return { disconnect: async () => { window.__mockRoomDisconnects = (window.__mockRoomDisconnects || 0) + 1; } };
  }`,
    }),
  );
  await page.routeWebSocket("**/ws/**", (ws) => {
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === "begin") {
        requests.begins++;
        ws.send(
          JSON.stringify({
            type: "started",
            startedAt: Date.now(),
            deadline: Date.now() + 300000,
          }),
        );
        for (const turn of turns)
          ws.send(JSON.stringify({ type: "turn", ...turn }));
        if (options.disconnect)
          setTimeout(() => {
            endedReason = "leg_died";
            ws.send(JSON.stringify({ type: "ended", reason: endedReason }));
            ws.close();
          }, 100);
      }
      if (message.type === "mic_audio") requests.mic++;
    });
    ws.send(JSON.stringify({ type: "ready" }));
  });
  if (options.denyMic)
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        throw new DOMException("Denied", "NotAllowedError");
      };
    });
  await page.goto(base);
  return { page, context, requests, errors };
}
async function start(page) {
  await page.locator("#sample").click();
  await page.locator("#start").click();
}
async function waitUntil(fn) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await delay(50);
  }
  assert.ok(fn(), "condition did not become true");
}

test("settings screen and missing configuration remain actionable without paid requests", async () => {
  const { page, context, requests, errors } = await fixture({ missing: true });
  try {
    await page.screenshot({
      path: `${root}test-results/setup.png`,
      fullPage: true,
    });
    await start(page);
    await page.locator("#setup").waitFor({ state: "visible" });
    assert.match(await page.locator("#notice").innerText(), /OPENAI_API_KEY/);
    assert.equal(requests.starts.length, 0);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("three-screen flow, microphone, exact transcript, mute and same-condition retry", async () => {
  const { page, context, requests, errors } = await fixture();
  try {
    await start(page);
    await page.getByText("会話中", { exact: true }).waitFor();
    assert.equal(requests.begins, 1);
    await waitUntil(() => requests.mic > 0);
    await page.locator("#mute").click();
    assert.equal(
      await page.locator("#mute").getAttribute("aria-pressed"),
      "true",
    );
    await page.locator("#mute").click();
    await page.screenshot({
      path: `${root}test-results/rehearsal-mocked.png`,
      fullPage: true,
    });
    await page.locator("#end").click();
    await page.locator("#retry:not([disabled])").waitFor();
    assert.match(
      await page.locator("#review-transcript").innerText(),
      /案件の進捗/,
    );
    assert.match(
      await page.locator("#review").innerText(),
      /AIによる評価・採点は未実装/,
    );
    await page.screenshot({
      path: `${root}test-results/review.png`,
      fullPage: true,
    });
    await page.locator("#retry").click();
    await page.getByText("会話中", { exact: true }).waitFor();
    assert.equal(requests.starts[1].previousAttemptId, "attempt-1");
    assert.deepEqual(requests.starts[1].settings, requests.starts[0].settings);
    await page.locator("#end").click();
    await page.locator("#retry:not([disabled])").waitFor();
    await page.locator("#edit-settings").click();
    await page.locator("#setup").waitFor({ state: "visible" });
    assert.ok((await page.locator("#product-name").inputValue()).length > 0);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("denied microphone never starts an upstream session", async () => {
  const { page, context, requests, errors } = await fixture({ denyMic: true });
  try {
    await start(page);
    await page.locator("#setup").waitFor({ state: "visible" });
    assert.match(
      await page.locator("#notice").innerText(),
      /マイクの利用を許可/,
    );
    assert.equal(requests.starts.length, 0);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("cancel while session creation is pending stops the late session", async () => {
  const { page, context, requests, errors } = await fixture({
    startDelay: 800,
  });
  try {
    await start(page);
    await waitUntil(() => requests.starts.length === 1);
    await page.locator("#end").click();
    await page.locator("#setup").waitFor({ state: "visible" });
    await waitUntil(() => requests.stops.length === 1);
    assert.equal(requests.begins, 0);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("connection failure returns to editable settings", async () => {
  const { page, context, errors } = await fixture({ startFailure: true });
  try {
    await start(page);
    await page.locator("#setup").waitFor({ state: "visible" });
    assert.match(await page.locator("#notice").innerText(), /APIキーと利用枠/);
    assert.equal(await page.locator("#start").isEnabled(), true);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test("disconnect saves partial result; retrieval failure clearly marks browser fallback", async () => {
  for (const resultFailure of [false, true]) {
    const { page, context, errors } = await fixture({
      disconnect: true,
      resultFailure,
    });
    try {
      await start(page);
      await page.locator("#review").waitFor({ state: "visible" });
      if (resultFailure) {
        await page.locator("#reload-result").waitFor({ state: "visible" });
        assert.match(
          await page.locator("#result-status").innerText(),
          /不完全/,
        );
        assert.equal(await page.locator("#retry").isDisabled(), true);
      } else {
        await page.locator("#retry:not([disabled])").waitFor();
        assert.match(
          await page.locator("#result-status").innerText(),
          /途中まで/,
        );
      }
      assert.match(
        await page.locator("#review-transcript").innerText(),
        /案件の進捗/,
      );
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
});

test("a stalled result request times out and restores editing controls", async () => {
  let pending;
  const { page, context, errors } = await fixture({
    resultHook: (route) => {
      pending = route;
    },
  });
  try {
    await start(page);
    await page.getByText("会話中", { exact: true }).waitFor();
    await page.locator("#end").click();
    await waitUntil(() => pending);
    await page
      .locator("#edit-settings:not([disabled])")
      .waitFor({ timeout: 15000 });
    assert.match(await page.locator("#result-status").innerText(), /不完全/);
    assert.equal(await page.locator("#reload-result").isVisible(), true);
    assert.deepEqual(errors, []);
  } finally {
    await pending?.abort().catch(() => {});
    await context.close();
  }
});

test("late previous-result response cannot overwrite a newer review", async () => {
  let firstRequests = 0;
  let releaseOld;
  const { page, context, errors } = await fixture({
    distinctResults: true,
    resultHook: async (route, data, fulfill) => {
      if (data.attemptId === "attempt-1") {
        firstRequests++;
        if (firstRequests === 1)
          return fulfill(route, { error: "unavailable" }, 503);
        await new Promise((resolve) => {
          releaseOld = resolve;
        });
      }
      return fulfill(route, data).catch(() => {});
    },
  });
  try {
    await start(page);
    await page.getByText("会話中", { exact: true }).waitFor();
    await page.locator("#end").click();
    await page.locator("#reload-result").waitFor({ state: "visible" });
    await page.locator("#reload-result").click();
    await waitUntil(() => releaseOld);
    await page.locator("#edit-settings").click();
    await start(page);
    await page.getByText("会話中", { exact: true }).waitFor();
    await page.locator("#end").click();
    await page.locator("#retry:not([disabled])").waitFor();
    releaseOld();
    await delay(150);
    const text = await page.locator("#review-transcript").innerText();
    assert.match(text, /attempt-2/);
    assert.doesNotMatch(text, /attempt-1/);
    assert.deepEqual(errors, []);
  } finally {
    releaseOld?.();
    await context.close();
  }
});
