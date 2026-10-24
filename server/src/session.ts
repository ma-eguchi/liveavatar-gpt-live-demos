import type WebSocket from "ws";
import type { ServerMessage, Turn } from "../../shared/messages";
import { GptLiveBridge, type GptLiveEvents } from "./gptlive";
import { MediaServerLeg } from "./mediaServer";
import { customerInstructions } from "./prompts";
import { attempts, type Attempt } from "./attemptStore";
const MEDIA_READY_TIMEOUT_MS = 15_000;
const YIELD_GRACE_MS = 600;
const YIELD_QUIET_MS = 350;
const YIELD_STALE_MS = 6_000;
const INTERRUPT_COOLDOWN_MS = 1_000;
export const DURATION_MS = 300_000;

export class Session implements GptLiveEvents {
  readonly bridge: GptLiveBridge;
  readonly media: MediaServerLeg;
  private frontend: WebSocket | null = null;
  private ready = false;
  private stopping = false;
  private lastAudioAt: number | null = null;
  private lastInterruptAt: number | null = null;
  private interruptWatch: NodeJS.Timeout | null = null;
  private deadlineTimer: NodeJS.Timeout | null = null;
  private connectTimer: NodeJS.Timeout | null = null;
  lastActivityAt = Date.now();
  constructor(
    readonly sessionId: string,
    mediaWsUrl: string,
    readonly attempt: Attempt,
    private readonly onDead: (id: string, reason: string) => void,
  ) {
    this.media = new MediaServerLeg(mediaWsUrl, (msg) => this.log(msg));
    this.bridge = new GptLiveBridge(
      this,
      (msg) => this.log(msg),
      customerInstructions(attempt),
    );
  }
  start(): void {
    this.connectTimer = setTimeout(
      () => this.onDead(this.sessionId, "connection_timeout"),
      45_000,
    );
    void this.runLeg("media server", () => this.media.run());
    void this.runLeg("GPT-Live", async () => {
      if (
        !(await this.media.waitUntilReady(MEDIA_READY_TIMEOUT_MS)) ||
        this.stopping
      )
        return;
      await this.bridge.run();
    });
  }
  begin(): void {
    if (!this.ready || this.stopping || this.attempt.result.startedAt !== null)
      return;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    const startedAt = Date.now();
    this.attempt.result.startedAt = startedAt;
    this.attempt.result.status = "active";
    this.deadlineTimer = setTimeout(
      () => this.onDead(this.sessionId, "time_limit"),
      DURATION_MS,
    );
    this.emit({
      type: "started",
      startedAt,
      deadline: startedAt + DURATION_MS,
    });
    this.bridge.sendGreeting();
  }
  async stop(reason: string): Promise<void> {
    this.stopping = true;
    this.attempt.result.status = "finishing";
    if (this.interruptWatch) clearTimeout(this.interruptWatch);
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    try {
      await this.bridge.close();
    } finally {
      const lastTurn = this.attempt.result.turns
        .filter((t) => t.role === "assistant")
        .at(-1);
      if (lastTurn) this.onTurn({ ...lastTurn, uncertain: true });
      this.media.close();
      attempts.finish(this.attempt, reason);
      this.emit({ type: "ended", reason });
      this.frontend?.close(1000, "ended");
      this.frontend = null;
    }
  }
  tryAttachFrontend(ws: WebSocket): boolean {
    if (this.frontend || this.stopping) return false;
    this.frontend = ws;
    if (this.ready) this.emit({ type: "ready" });
    return true;
  }
  detachFrontend(ws: WebSocket): void {
    if (this.frontend === ws) this.frontend = null;
  }
  sendMicAudio(audioB64: string): void {
    if (this.stopping || this.attempt.result.status !== "active") return;
    this.lastActivityAt = Date.now();
    this.bridge.sendMicAudio(audioB64);
  }
  onReady(): void {
    if (this.stopping) return;
    this.ready = true;
    this.emit({ type: "ready" });
  }
  onAudio(audioB64: string): void {
    if (this.attempt.result.startedAt === null) return;
    this.lastAudioAt = Date.now();
    this.media.speak(audioB64);
  }
  onTurn(turn: Turn): void {
    attempts.upsert(this.attempt, turn);
    this.emit({ type: "turn", ...turn });
  }
  onUserTurnStarted(): void {
    if (this.interruptWatch || this.stopping) return;
    this.interruptWatch = setTimeout(() => {
      this.interruptWatch = null;
      this.stopStaleAudio();
    }, YIELD_GRACE_MS);
  }
  onToolCall(): Record<string, unknown> {
    return {
      error: "No tools are available. Continue the customer conversation.",
    };
  }
  onError(message: string): void {
    this.log(`upstream error: ${message}`);
    this.emit({
      type: "error",
      message:
        "会話サービスに接続できませんでした。API設定と利用枠を確認してください。",
    });
    this.onDead(this.sessionId, "upstream_error");
  }
  private stopStaleAudio(): void {
    const last = this.lastAudioAt;
    if (last === null || this.stopping) return;
    if (
      this.lastInterruptAt !== null &&
      Date.now() - this.lastInterruptAt < INTERRUPT_COOLDOWN_MS
    ) {
      return;
    }
    const quietFor = Date.now() - last;
    // Still talking over the user → the model kept the floor (backchannel).
    if (quietFor < YIELD_QUIET_MS) return;
    // Long quiet → nothing left playing; clearing would empty an empty buffer.
    if (quietFor > YIELD_STALE_MS) return;
    this.lastInterruptAt = Date.now();
    this.log("user barge-in — clearing avatar audio buffer");
    this.media.interrupt();
    const lastTurn = this.attempt.result.turns
      .filter((t) => t.role === "assistant")
      .at(-1);
    if (lastTurn) this.onTurn({ ...lastTurn, uncertain: true });
    // The rest of that sentence is never coming; tell the browser so it can
    // reflect it (e.g. mark the transcript line).
    this.emit({ type: "interrupted" });
  }

  private async runLeg(name: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (err) {
      if (!this.stopping)
        this.log(
          `${name} leg failed: ${err instanceof Error ? err.message : err}`,
        );
    }
    if (this.stopping) return;
    // Neither leg reconnects forever, and a session with one live leg is
    // useless — GPT-Live would stream into a closed socket, or the avatar
    // would sit mute — so the survivor is not left running.
    this.log(`${name} leg exited — ending session`);
    this.emit({ type: "error", message: `the ${name} connection dropped` });
    this.onDead(this.sessionId, "leg_died");
  }

  private emit(message: ServerMessage): void {
    const ws = this.frontend;
    if (!ws || ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(message));
    } catch {
      this.frontend = null;
    }
  }

  private log(msg: string): void {
    console.log(`[session ${this.sessionId.slice(0, 8)}] ${msg}`);
  }
}
