import test from "node:test";
import assert from "node:assert/strict";
import { AttemptStore, validateSettings } from "../src/attemptStore";
import { TurnProjector } from "../src/turns";
import { localRequestAllowed } from "../src/localAccess";
import { Session } from "../src/session";
import { customerInstructions } from "../src/prompts";
import type { Turn } from "../../shared/messages";
const settings = {
  productName: "案件管理",
  productDescription: "案件情報の集約",
  customerContext: "",
};

test("server ends the rehearsal at five minutes even without a browser timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = new AttemptStore();
  const reasons: string[] = [];
  const session = new Session(
    "deadline-test",
    "wss://unused.example",
    store.create(settings),
    (_id, reason) => reasons.push(reason),
  );
  session.bridge.sendGreeting = () => {};
  session.bridge.close = async () => {};
  session.media.close = () => {};
  session.onReady();
  session.begin();
  t.mock.timers.tick(299_999);
  assert.deepEqual(reasons, []);
  t.mock.timers.tick(1);
  assert.deepEqual(reasons, ["time_limit"]);
  await session.stop("time_limit");
});

test("settings enforce type, required fields and size boundaries", () => {
  assert.equal(
    validateSettings({ ...settings, productName: " 案件管理 " }).productName,
    "案件管理",
  );
  for (const input of [
    null,
    {},
    { ...settings, productName: " " },
    { ...settings, productName: "a".repeat(101) },
    { ...settings, productDescription: 5 },
    { ...settings, customerContext: "a".repeat(501) },
  ])
    assert.throws(() => validateSettings(input));
});
test("ownership, retry immutability, private scenario separation and turn upsert", () => {
  const store = new AttemptStore();
  const a = store.create(settings);
  a.sessionId = "s1";
  assert.equal(store.authorize(a.result.attemptId, "bad"), undefined);
  assert.equal(store.authorize(a.result.attemptId, "あ".repeat(64)), undefined);
  assert.equal(store.forSession("s1", a.token), a);
  const b = store.create({ ...settings, productName: "changed" }, a);
  assert.equal(b.scenario.id, a.scenario.id);
  assert.deepEqual(b.result.settings, settings);
  assert.notEqual(a.token, b.token);
  assert.equal(store.authorize(b.result.attemptId, a.token), undefined);
  assert.ok(!JSON.stringify(a.result).includes("privateContext"));
  store.upsert(a, { id: "u1", role: "user", text: "現在", done: false });
  store.upsert(a, {
    id: "u1",
    role: "user",
    text: "現在の課題は？",
    done: true,
  });
  assert.equal(a.result.turns.length, 1);
  store.finish(a, "client_stop");
  assert.equal(a.result.status, "completed");
  store.finish(b, "connection_timeout");
  assert.equal(b.result.status, "incomplete");
  store.finish(a, "frontend_disconnect");
  assert.equal(a.result.status, "incomplete");
  assert.ok(customerInstructions(a).includes(settings.productName));
});
test("projector flush preserves both speakers without duplicating partial turns", () => {
  const updates: Turn[] = [];
  const projector = new TurnProjector({
    onTurn: (t) => updates.push(t),
    onUserTurnStarted() {},
  });
  projector.fragment("user", "最後の", 0, 100);
  projector.fragment("user", "質問", 100, 200);
  projector.fragment("assistant", "回答", 210, 300);
  projector.flush();
  const finals = updates.filter((t) => t.uncertain);
  assert.equal(finals.length, 2);
  assert.equal(finals[0]?.text, "最後の質問");
  assert.equal(finals[0]?.done, false);
  projector.flush();
  assert.equal(updates.filter((t) => t.uncertain).length, 2);
  projector.dispose();
});
test("local security rejects cross-origin, DNS rebinding and websocket without Origin", () => {
  assert.ok(
    localRequestAllowed(
      { headers: { host: "localhost:5173", origin: "http://localhost:5173" } },
      true,
    ),
  );
  assert.ok(localRequestAllowed({ headers: { host: "127.0.0.1:8787" } }));
  for (const headers of [
    { host: "evil.example:8787" },
    { host: "localhost:5173", origin: "https://evil.example" },
    { host: "localhost:5173", origin: "http://localhost:5000" },
  ])
    assert.equal(localRequestAllowed({ headers }), false);
  assert.equal(
    localRequestAllowed({ headers: { host: "localhost:5173" } }, true),
    false,
  );
});
test("begin waits for ready, starts once; stop drains transcript before result and ended", async () => {
  const store = new AttemptStore();
  const attempt = store.create(settings);
  const session = new Session(
    "test",
    "wss://unused.example",
    attempt,
    () => {},
  );
  let greeting = 0;
  let mic = 0;
  const messages: Record<string, unknown>[] = [];
  session.bridge.sendGreeting = () => {
    greeting++;
  };
  session.bridge.sendMicAudio = () => {
    mic++;
  };
  session.media.close = () => {};
  session.bridge.close = async () => {
    await Promise.resolve();
    session.onTurn({
      id: "last",
      role: "user",
      text: "最終発言",
      done: false,
      uncertain: true,
    });
  };
  session.tryAttachFrontend({
    OPEN: 1,
    readyState: 1,
    send: (s: string) => messages.push(JSON.parse(s)),
    close() {},
  } as any);
  session.begin();
  session.sendMicAudio("AAAA");
  assert.equal(greeting, 0);
  assert.equal(mic, 0);
  session.onReady();
  session.begin();
  session.begin();
  session.sendMicAudio("AAAA");
  assert.equal(greeting, 1);
  assert.equal(mic, 1);
  const started = messages.find((m) => m.type === "started")!;
  assert.equal(Number(started.deadline) - Number(started.startedAt), 300_000);
  await session.stop("client_stop");
  assert.equal(attempt.result.turns[0]?.text, "最終発言");
  assert.equal(attempt.result.status, "completed");
  assert.equal(messages.at(-1)?.type, "ended");
  session.sendMicAudio("AAAA");
  assert.equal(mic, 1);
});
