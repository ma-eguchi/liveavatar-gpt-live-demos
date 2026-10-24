import "./style.css";
import type { Turn } from "../../shared/messages";
import type {
  RehearsalResult,
  RehearsalSettings,
  StartRehearsalResponse,
} from "../../shared/rehearsal";
import { startMicCapture, type MicCapture } from "./micCapture";
import { joinAvatarRoom, type AvatarRoom } from "./livekitRoom";
import { openSessionSocket, type SessionSocket } from "./socket";

const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const form = el<HTMLFormElement>("settings-form");
const video = el<HTMLVideoElement>("video");
const audio = el<HTMLAudioElement>("audio");
interface Attempt {
  controller: AbortController;
  canceled: boolean;
  finishing: boolean;
  streaming: boolean;
  begun: boolean;
  ready: boolean;
  mic?: MicCapture;
  room?: AvatarRoom;
  socket?: SessionSocket;
  session?: StartRehearsalResponse;
  turns: Map<string, Turn>;
  settings: RehearsalSettings;
  startedAt: number | null;
  deadline: number | null;
  timeout?: ReturnType<typeof setTimeout>;
}
let active: Attempt | null = null;
let last: {
  session: StartRehearsalResponse;
  settings: RehearsalSettings;
} | null = null;
let muted = false;
let resultGeneration = 0;
let resultController: AbortController | null = null;
function invalidateResult() {
  resultGeneration++;
  resultController?.abort();
  resultController = null;
}
const clock = (seconds: number) =>
  `${Math.floor(Math.max(0, seconds) / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(Math.max(0, seconds) % 60)
    .toString()
    .padStart(2, "0")}`;
function notice(message = "") {
  el("notice").textContent = message;
  el("notice").hidden = !message;
}
function screen(name: "setup" | "rehearsal" | "review") {
  invalidateResult();
  for (const id of ["setup", "rehearsal", "review"])
    el(id).hidden = id !== name;
  document.querySelectorAll<HTMLElement>("[data-step]").forEach((step) => {
    if (step.dataset.step === name) step.setAttribute("aria-current", "step");
    else step.removeAttribute("aria-current");
  });
  el(`${name}-title`).focus({ preventScroll: true });
  window.scrollTo(0, 0);
}
function settings(): RehearsalSettings {
  return {
    productName: el<HTMLInputElement>("product-name").value.trim(),
    productDescription: el<HTMLTextAreaElement>(
      "product-description",
    ).value.trim(),
    customerContext: el<HTMLTextAreaElement>("customer-context").value.trim(),
  };
}
function renderTurns(target: string, turns: Turn[]) {
  const container = el(target);
  const pinned =
    container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  container.replaceChildren(
    ...turns.map((turn) => {
      const item = document.createElement("div");
      item.className = `turn ${turn.role}`;
      const who = document.createElement("strong");
      who.textContent = turn.role === "user" ? "あなた" : "顧客役";
      const text = document.createElement("p");
      text.textContent = turn.text;
      item.append(who, text);
      if (!turn.done || turn.uncertain) {
        const note = document.createElement("small");
        note.textContent = "発言の途中・未確定の記録";
        item.append(note);
      }
      return item;
    }),
  );
  if (pinned) container.scrollTop = container.scrollHeight;
}
async function json<T>(
  url: string,
  options: RequestInit = {},
  timeoutMs = 10000,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const data = (await response.json().catch((error) => {
      if (controller.signal.aborted) throw error;
      return {};
    })) as { error?: string };
    if (!response.ok)
      throw new Error(
        data.error || "通信に失敗しました。接続を確認して再試行してください。",
      );
    return data as T;
  } catch (error) {
    if (controller.signal.aborted)
      throw new Error(
        "通信が時間内に完了しませんでした。接続を確認して再試行してください。",
      );
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}
function stopRemote(session: StartRehearsalResponse) {
  return json(
    "/api/session/stop",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: session.session_id,
        accessToken: session.accessToken,
      }),
      keepalive: true,
    },
    35000,
  );
}
function release(attempt: Attempt) {
  attempt.streaming = false;
  attempt.controller.abort();
  clearTimeout(attempt.timeout);
  attempt.mic?.stop();
  attempt.mic = undefined;
  attempt.socket?.close();
  attempt.socket = undefined;
  void attempt.room?.disconnect().catch(() => {});
  attempt.room = undefined;
  audio.pause();
  video.pause();
  audio.srcObject = null;
  video.srcObject = null;
}
function begin(attempt: Attempt) {
  if (
    attempt.canceled ||
    attempt.finishing ||
    attempt.begun ||
    !attempt.ready ||
    !attempt.room ||
    !attempt.mic
  )
    return;
  attempt.begun = true;
  attempt.socket?.begin();
}
async function launch(retry = false) {
  if (active) return;
  notice();
  const currentSettings = retry && last ? last.settings : settings();
  if (!currentSettings.productName || !currentSettings.productDescription) {
    notice("商材名と、解決する課題を入力してください。");
    return;
  }
  const attempt: Attempt = {
    controller: new AbortController(),
    canceled: false,
    finishing: false,
    streaming: false,
    begun: false,
    ready: false,
    turns: new Map(),
    settings: currentSettings,
    startedAt: null,
    deadline: null,
  };
  active = attempt;
  muted = false;
  el<HTMLButtonElement>("start").disabled = true;
  el<HTMLButtonElement>("mute").disabled = true;
  el("mute").textContent = "ミュート";
  el("mute").setAttribute("aria-pressed", "false");
  el("end").textContent = "接続をキャンセル";
  el<HTMLButtonElement>("end").disabled = false;
  el("connecting").hidden = false;
  el("connection-label").textContent = "マイクを確認しています";
  el("mic-status").textContent = "マイク確認中";
  el("stage-status").textContent = "接続準備中";
  el("customer-name").textContent = "顧客役を準備中";
  el("customer-role").textContent = "";
  el("customer-situation").textContent = "";
  el("time").textContent = "05:00";
  el("enable-audio").hidden = true;
  renderTurns("live-transcript", []);
  screen("rehearsal");
  attempt.timeout = setTimeout(() => {
    if (active === attempt && !attempt.streaming)
      void finish(
        attempt,
        "接続が時間内に完了しませんでした。もう一度お試しください。",
      );
  }, 90000);
  try {
    const config = await json<{ configured: boolean; missing: string[] }>(
      "/api/config",
    );
    if (attempt.canceled) return;
    if (!config.configured)
      throw new Error(
        `接続の設定が必要です。サーバーの .env に ${config.missing.join("、")} を設定して再起動してください。`,
      );
    const mic = await startMicCapture(
      (chunk) => {
        if (attempt.streaming && !attempt.canceled)
          attempt.socket?.sendMicAudio(chunk);
      },
      (level) => {
        if (active === attempt)
          el("level").style.opacity = String(
            0.35 + Math.min(1, level * 10) * 0.65,
          );
      },
    );
    if (attempt.canceled) {
      mic.stop();
      return;
    }
    attempt.mic = mic;
    el("mic-status").textContent = "マイク接続済み";
    el("connection-label").textContent = "顧客役に接続しています";
    const session = await json<StartRehearsalResponse>(
      "/api/session/start",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: currentSettings,
          ...(retry && last
            ? {
                previousAttemptId: last.session.attemptId,
                previousAccessToken: last.session.accessToken,
              }
            : {}),
        }),
      },
      45000,
    );
    if (attempt.canceled) {
      await stopRemote(session);
      return;
    }
    attempt.session = session;
    el("customer-name").textContent = session.customer.name;
    el("customer-role").textContent = session.customer.role;
    el("customer-situation").textContent = session.customer.situation;
    attempt.socket = openSessionSocket(session.ws_path, {
      onReady: () => {
        attempt.ready = true;
        begin(attempt);
      },
      onStarted: (startedAt, deadline) => {
        if (attempt.canceled || attempt.finishing) return;
        clearTimeout(attempt.timeout);
        attempt.startedAt = startedAt;
        attempt.deadline = deadline;
        attempt.streaming = true;
        el("connecting").hidden = true;
        el("stage-status").textContent = "会話中";
        el("mic-status").textContent = "マイク ON";
        el("end").textContent = "終了して振り返る";
        el<HTMLButtonElement>("mute").disabled = false;
        void audio.play().catch(() => {
          if (active === attempt) el("enable-audio").hidden = false;
        });
      },
      onEnded: () => {
        void finish(attempt);
      },
      onTurn: (turn) => {
        if (!attempt.canceled) {
          attempt.turns.set(turn.id, turn);
          renderTurns("live-transcript", [...attempt.turns.values()]);
        }
      },
      onUi: () => {},
      onInterrupted: () => {},
      onError: () => {
        void finish(
          attempt,
          "会話への接続に問題が発生しました。記録を確認して、再度お試しください。",
        );
      },
      onClose: () => {
        void finish(attempt, "通信が切断されたため、練習を終了しました。");
      },
    });
    const room = await joinAvatarRoom(
      session.livekit_url,
      session.livekit_client_token,
      { video, audio },
      attempt.controller.signal,
    );
    if (attempt.canceled || attempt.finishing) {
      await room.disconnect();
      return;
    }
    attempt.room = room;
    begin(attempt);
  } catch (error) {
    if (!attempt.canceled)
      await finish(
        attempt,
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "マイクの利用を許可してください。ブラウザのサイト設定から変更できます。"
          : error instanceof Error
            ? error.message
            : "接続を開始できませんでした。",
      );
  }
}
async function finish(attempt: Attempt, message = "") {
  if (attempt.finishing || attempt.canceled) return;
  attempt.finishing = true;
  attempt.canceled = true;
  release(attempt);
  el<HTMLButtonElement>("end").disabled = true;
  if (message) notice(message);
  if (!attempt.session) {
    active = null;
    el<HTMLButtonElement>("start").disabled = false;
    screen("setup");
    return;
  }
  last = { session: attempt.session, settings: attempt.settings };
  screen("review");
  el("result-status").textContent =
    "接続を終了し、会話の記録を確認しています。";
  el("duration").textContent = attempt.startedAt
    ? clock((Date.now() - attempt.startedAt) / 1000)
    : "00:00";
  el<HTMLButtonElement>("retry").disabled = true;
  el<HTMLButtonElement>("edit-settings").disabled = true;
  renderTurns("review-transcript", [...attempt.turns.values()]);
  try {
    try {
      await stopRemote(attempt.session);
    } catch {
      notice("終了の確認ができませんでした。会話の記録は再取得できます。");
    }
    await loadResult(attempt.session);
  } finally {
    if (active === attempt) {
      active = null;
      el<HTMLButtonElement>("start").disabled = false;
      el<HTMLButtonElement>("edit-settings").disabled = false;
    }
  }
}
async function loadResult(session: StartRehearsalResponse) {
  invalidateResult();
  const generation = resultGeneration;
  const controller = new AbortController();
  resultController = controller;
  const current = () =>
    generation === resultGeneration &&
    last?.session.attemptId === session.attemptId &&
    !el("review").hidden;
  el("reload-result").hidden = true;
  try {
    const result = await json<RehearsalResult>(
      `/api/rehearsals/${encodeURIComponent(session.attemptId)}`,
      {
        headers: { Authorization: `Bearer ${session.accessToken}` },
        signal: controller.signal,
      },
    );
    if (!current()) return;
    renderTurns("review-transcript", result.turns);
    el("duration").textContent = result.startedAt
      ? clock(((result.endedAt ?? Date.now()) - result.startedAt) / 1000)
      : "00:00";
    const ended =
      result.status === "completed" || result.status === "incomplete";
    el("result-status").textContent =
      result.status === "completed"
        ? "おつかれさまでした。会話を読み返し、次の練習につなげましょう。"
        : ended
          ? "途中までの会話記録です。振り返りにお使いください。"
          : "終了処理中です。少し待って記録を再取得してください。";
    el<HTMLButtonElement>("retry").disabled = !ended;
    el("reload-result").hidden = ended;
  } catch {
    if (!current()) return;
    el("result-status").textContent =
      "保存済みの記録を取得できませんでした。画面に残っていた記録を表示しています（不完全な場合があります）。";
    el("reload-result").hidden = false;
    el<HTMLButtonElement>("retry").disabled = true;
  } finally {
    if (resultController === controller) resultController = null;
  }
}
form.addEventListener("submit", (event) => {
  event.preventDefault();
  void launch();
});
el("sample").addEventListener("click", () => {
  el<HTMLInputElement>("product-name").value = "営業チーム向け案件管理サービス";
  el<HTMLTextAreaElement>("product-description").value =
    "メールやExcelに分散した案件情報を一元管理し、営業責任者の進捗確認や報告の時間を減らします。";
  el<HTMLTextAreaElement>("customer-context").value =
    "従業員50人の企業の営業責任者。営業担当は8人。現在はExcelで案件を管理している。";
  el("product-name").focus();
});
el("end").addEventListener("click", () => {
  if (active) void finish(active);
});
el("retry").addEventListener("click", () => {
  void launch(true);
});
el("edit-settings").addEventListener("click", () => {
  notice();
  screen("setup");
});
el("reload-result").addEventListener("click", () => {
  if (last) void loadResult(last.session);
});
el("mute").addEventListener("click", () => {
  if (!active?.streaming) return;
  muted = !muted;
  active.mic?.setMuted(muted);
  el("mute").setAttribute("aria-pressed", String(muted));
  el("mute").textContent = muted ? "ミュート解除" : "ミュート";
  el("mic-status").textContent = muted ? "マイク OFF" : "マイク ON";
});
el("enable-audio").addEventListener("click", () => {
  void audio
    .play()
    .then(() => {
      el("enable-audio").hidden = true;
    })
    .catch(() =>
      notice(
        "音声を再生できませんでした。ブラウザの音声設定を確認してください。",
      ),
    );
});
setInterval(() => {
  if (active?.deadline && active.streaming) {
    const remaining = Math.max(
      0,
      Math.ceil((active.deadline - Date.now()) / 1000),
    );
    el("time").textContent = clock(remaining);
    el("time").parentElement?.classList.toggle("urgent", remaining <= 30);
  }
}, 500);
window.addEventListener("pagehide", () => {
  if (!active) return;
  active.canceled = true;
  release(active);
  if (active.session) void stopRemote(active.session).catch(() => {});
});
screen("setup");
void json<{ configured: boolean; missing: string[] }>("/api/config")
  .then((config) => {
    if (!config.configured && !active)
      notice(
        `会話を始めるには接続設定が必要です。サーバーの .env に ${config.missing.join("、")} を設定してください。商談の入力は先にお試しいただけます。`,
      );
  })
  .catch(() =>
    notice(
      "サーバーに接続できません。サーバーを起動してから再度お試しください。",
    ),
  );
