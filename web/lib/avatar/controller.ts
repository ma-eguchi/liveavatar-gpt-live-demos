/**
 * Owns one practice session end to end: start → LiveKit join → websocket →
 * mic, and the teardown of all four in the right order. Framework-free on
 * purpose: React renders the markup and hands the elements in; this class
 * drives them imperatively (audio meters run at 60fps and the transcript
 * streams token-by-token — neither belongs in React state).
 *
 * Ordering matters on the way up: the mic only starts once the server says
 * `ready`, because audio sent before GPT-Live's session exists is discarded.
 *
 * Startup is guarded by a generation counter: every await below is a window in
 * which the user can hit Stop or the socket can drop, and a stale start must
 * not re-attach resources that teardown already released.
 */

import type { TermCardProps, Turn, UiMessage } from "../../../shared/messages";
import type { SessionStartResponse } from "../api";
import { joinAvatarRoom, type AvatarRoom } from "./livekitRoom";
import { startMicCapture, type MicCapture } from "./micCapture";
import { createOverlays, type Overlays } from "./overlays/index";
import { openSessionSocket, type SessionSocket } from "./socket";

export type StatusKind = "idle" | "busy" | "live" | "error";
export type StageState = "idle" | "connecting" | "live";

export interface SessionElements {
  stage: HTMLDivElement;
  video: HTMLVideoElement;
  audio: HTMLAudioElement;
  player: HTMLElement;
  transcript: HTMLDivElement;
  micCanvas: HTMLCanvasElement;
}

export interface SessionCallbacks {
  onStatus: (message: string, kind: StatusKind) => void;
  onStage: (state: StageState) => void;
  onMicAvailable: (available: boolean) => void;
  onMicMuted: (muted: boolean) => void;
  /** A new word was put on screen (deduped per session). */
  onWord: (word: TermCardProps) => void;
  /** The backend charged today's quota for this session. */
  onQuota: (usedToday: number, dailyLimit: number) => void;
  /** Session is live; seconds until the hard limit (0 = none). */
  onLive: (info: { maxSeconds: number }) => void;
  onEnded: () => void;
}

/** Server error codes → what the learner reads. */
const ERROR_TEXT: Record<string, string> = {
  time_limit: "練習時間の上限に達したので終了しました。おつかれさまでした！",
};

export class PracticeSession {
  private overlays: Overlays;
  private practiceSessionId: string | null = null;
  private socket: SessionSocket | null = null;
  private room: AvatarRoom | null = null;
  private mic: MicCapture | null = null;
  private generation = 0;
  private stopping = false;
  private started = false;
  private muted = false;

  private turnLines = new Map<string, HTMLSpanElement>();
  private lastAssistantLine: HTMLDivElement | null = null;
  private words = new Set<string>();

  private waveCtx: CanvasRenderingContext2D;
  private micAnalyser: AnalyserNode | null = null;
  private micFreqBuf: Uint8Array<ArrayBuffer> | null = null;
  private speakCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserBuf: Uint8Array<ArrayBuffer> | null = null;
  private analysedStream: MediaStream | null = null;
  private quietSince = 0;
  private raf = 0;

  constructor(
    private readonly el: SessionElements,
    private readonly cb: SessionCallbacks,
  ) {
    this.waveCtx = el.micCanvas.getContext("2d") as CanvasRenderingContext2D;
    this.overlays = createOverlays({
      stage: el.stage,
      player: el.player,
      onStatus: (msg) => cb.onStatus(msg, "error"),
    });
    el.audio.addEventListener("playing", this.onAudioPlaying);
    // Live on the first decoded frame, not on join — the video fades in with
    // a face already in it.
    el.video.addEventListener("playing", this.onVideoPlaying);
    window.addEventListener("pagehide", this.onPageHide);
    this.drawMicWave();
  }

  /** Dev hook: render a widget without a session. */
  renderUi(msg: UiMessage): void {
    this.handleUi(msg);
  }

  dispose(): void {
    void this.stop();
    this.el.audio.removeEventListener("playing", this.onAudioPlaying);
    this.el.video.removeEventListener("playing", this.onVideoPlaying);
    window.removeEventListener("pagehide", this.onPageHide);
  }

  toggleMute(): void {
    if (!this.mic) return;
    this.setMuted(!this.muted);
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    const myGeneration = ++this.generation;
    const superseded = () => this.generation !== myGeneration;
    this.started = true;

    this.clearTranscript();
    this.words.clear();
    this.cb.onStage("connecting");
    this.status("セッションを準備しています…", "busy");
    this.raf ||= requestAnimationFrame(this.tick);

    let started: SessionStartResponse;
    try {
      const response = await fetch("/api/session/start", { method: "POST" });
      const body = (await response.json()) as SessionStartResponse & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "セッションを開始できませんでした");
      started = body;
      this.cb.onQuota(started.used_today, started.daily_limit);
    } catch (err) {
      this.cb.onStage("idle");
      this.status(err instanceof Error ? err.message : "セッションを開始できませんでした", "error");
      this.started = false;
      this.cb.onEnded();
      return;
    }

    // Cancelled while the mint was in flight: the session is real and
    // billable, so release it rather than leave it to the idle watchdog.
    if (superseded()) {
      void endOnServer(started.practice_session_id);
      return;
    }
    this.practiceSessionId = started.practice_session_id;

    this.status("アバターに接続しています…", "busy");
    try {
      this.room = await joinAvatarRoom(started.livekit_url, started.livekit_client_token, {
        video: this.el.video,
        audio: this.el.audio,
      });
    } catch (err) {
      // LiveKit's own messages are English and technical; keep them as a hint.
      const detail = err instanceof Error ? `（${err.message}）` : "";
      await this.stop(`アバターの映像に接続できませんでした${detail}`, "error");
      return;
    }
    if (superseded()) return;

    this.socket = openSessionSocket(started.ws_url, {
      onReady: () => {
        if (superseded()) return;
        this.status("話しかけてみましょう", "live");
        this.cb.onLive({ maxSeconds: started.max_session_seconds });
        void startMicCapture((base64) => this.socket?.sendMicAudio(base64))
          .then((capture) => {
            // getUserMedia takes real time; if the session ended meanwhile,
            // keeping this would leave the mic light on with nothing to stop it.
            if (superseded()) {
              capture.stop();
              return;
            }
            this.mic = capture;
            this.micAnalyser = capture.analyser;
            this.micFreqBuf = new Uint8Array(capture.analyser.frequencyBinCount);
            this.cb.onMicAvailable(true);
          })
          .catch((err: unknown) => {
            this.status(
              err instanceof Error
                ? `マイクが使えません: ${err.message}`
                : "マイクが使えません",
              "error",
            );
          });
      },
      onTurn: (turn) => this.upsertTurn(turn),
      onUi: (msg) => this.handleUi(msg),
      onInterrupted: () => {
        // The rest of that sentence is never coming.
        this.lastAssistantLine?.classList.add("interrupted");
      },
      onError: (message) => {
        const text = ERROR_TEXT[message];
        if (text) void this.stop(text, "idle");
        else this.status(message, "error");
      },
      onClose: () => {
        if (!this.stopping) void this.stop("セッションが終了しました");
      },
    });
  }

  async stop(reason?: string, kind: StatusKind = "idle"): Promise<void> {
    this.generation += 1; // cancel any in-flight start
    if (this.stopping || !this.started) return;
    this.stopping = true;

    this.mic?.stop();
    this.mic = null;
    this.socket?.close();
    this.socket = null;
    await this.room?.disconnect();
    this.room = null;
    this.overlays.hideAll();
    this.stopLiveness();

    const id = this.practiceSessionId;
    this.practiceSessionId = null;
    if (id) void endOnServer(id);

    this.cb.onStage("idle");
    this.status(reason ?? "おつかれさまでした", kind);
    this.started = false;
    this.stopping = false;
    this.cb.onEnded();
  }

  // ── UI channel ─────────────────────────────────────────────────────────────

  private handleUi(msg: UiMessage): void {
    if (msg.widget === "term_card" && !this.words.has(msg.props.term)) {
      this.words.add(msg.props.term);
      this.cb.onWord(msg.props);
    }
    this.overlays.render(msg);
  }

  // ── transcript ─────────────────────────────────────────────────────────────
  // One line per turn, keyed by turn id: streaming updates rewrite the line in
  // place. textContent only — this is model output.

  private upsertTurn(turn: Turn): void {
    let text = this.turnLines.get(turn.id);
    if (!text) {
      const line = document.createElement("div");
      line.className = `turn ${turn.role}`;
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = turn.role === "user" ? "あなた" : "Masahiro";
      text = document.createElement("span");
      text.className = "text";
      line.append(who, text);
      this.el.transcript.appendChild(line);
      this.turnLines.set(turn.id, text);
      if (turn.role === "assistant") this.lastAssistantLine = line;
    }
    text.textContent = turn.text;
    this.el.transcript.scrollTop = this.el.transcript.scrollHeight;
  }

  private clearTranscript(): void {
    this.el.transcript.textContent = "";
    this.turnLines.clear();
    this.lastAssistantLine = null;
  }

  // ── liveness: mic bars + speaking glow, one rAF loop ───────────────────────

  private onAudioPlaying = () => {
    const stream = this.el.audio.srcObject;
    if (!(stream instanceof MediaStream) || stream === this.analysedStream) return;
    void this.speakCtx?.close();
    this.speakCtx = new AudioContext();
    this.analyser = this.speakCtx.createAnalyser();
    this.analyser.fftSize = 512;
    this.speakCtx.createMediaStreamSource(stream).connect(this.analyser);
    this.analyserBuf = new Uint8Array(this.analyser.fftSize);
    this.analysedStream = stream;
  };

  private onVideoPlaying = () => {
    if (this.el.stage.dataset.state === "connecting") this.cb.onStage("live");
  };

  private onPageHide = () => {
    // Only sendBeacon survives unload; fetch is cancelled.
    if (!this.practiceSessionId) return;
    navigator.sendBeacon?.(
      "/api/session/stop",
      new Blob([JSON.stringify({ practice_session_id: this.practiceSessionId })], {
        type: "application/json",
      }),
    );
  };

  private tick = (now: number) => {
    this.drawMicWave();
    if (this.analyser && this.analyserBuf) {
      this.analyser.getByteTimeDomainData(this.analyserBuf);
      let sum = 0;
      for (let i = 0; i < this.analyserBuf.length; i++) {
        const v = ((this.analyserBuf[i] ?? 128) - 128) / 128;
        sum += v * v;
      }
      if (Math.sqrt(sum / this.analyserBuf.length) > 0.03) {
        this.quietSince = 0;
        this.el.stage.dataset.speaking = "";
      } else {
        this.quietSince ||= now;
        // Half a second of hush before the glow drops.
        if (now - this.quietSince > 500) delete this.el.stage.dataset.speaking;
      }
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private drawMicWave(): void {
    const canvas = this.el.micCanvas;
    const ctx = this.waveCtx;
    const w = canvas.width;
    const h = canvas.height;
    const BAR_COUNT = 7;
    const BINS_PER_BAR = 6; // fftSize 512 @ 48k → ~94Hz/bin: ≈ 0–4kHz, the speech band
    ctx.clearRect(0, 0, w, h);
    const live = this.micAnalyser && this.micFreqBuf && !this.muted;
    if (live) {
      this.micAnalyser!.getByteFrequencyData(this.micFreqBuf!);
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, "#b98cff");
      grad.addColorStop(1, "#6ea8ff");
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = "#5a6577";
    }
    const barW = 6;
    const gap = (w - BAR_COUNT * barW) / (BAR_COUNT - 1);
    for (let i = 0; i < BAR_COUNT; i++) {
      let level = 0;
      if (live) {
        let sum = 0;
        for (let j = 0; j < BINS_PER_BAR; j++) sum += this.micFreqBuf![1 + i * BINS_PER_BAR + j] ?? 0;
        level = Math.min(1, (sum / BINS_PER_BAR / 255) * 1.4);
      }
      const barH = 6 + level * (h - 6);
      ctx.beginPath();
      ctx.roundRect(i * (barW + gap), (h - barH) / 2, barW, barH, 3);
      ctx.fill();
    }
  }

  private stopLiveness(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.cb.onMicAvailable(false);
    this.setMuted(false);
    this.micAnalyser = null;
    this.micFreqBuf = null;
    this.drawMicWave();
    delete this.el.stage.dataset.speaking;
    void this.speakCtx?.close();
    this.speakCtx = null;
    this.analyser = null;
    this.analyserBuf = null;
    this.analysedStream = null;
    this.quietSince = 0;
  }

  /** Muting disables the track — silence keeps streaming, so the model still hears a continuous feed. */
  private setMuted(muted: boolean): void {
    this.muted = muted;
    this.mic?.setMuted(muted);
    this.cb.onMicMuted(muted);
  }

  private status(message: string, kind: StatusKind): void {
    this.cb.onStatus(message, kind);
  }
}

async function endOnServer(practiceSessionId: string): Promise<void> {
  try {
    await fetch("/api/session/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ practice_session_id: practiceSessionId }),
    });
  } catch {
    // The orchestrator reaps the session on its own.
  }
}
