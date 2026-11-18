"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { TermCardProps, UiMessage } from "../../../shared/messages";
import { PracticeSession, type StageState, type StatusKind } from "@/lib/avatar/controller";

interface Props {
  usedToday: number;
  dailyLimit: number;
}

export function PracticeRoom({ usedToday: initialUsed, dailyLimit: initialLimit }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const playerSlotRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<PracticeSession | null>(null);

  const [stage, setStage] = useState<StageState>("idle");
  const [status, setStatus] = useState<{ text: string; kind: StatusKind }>({
    text: "待機中",
    kind: "idle",
  });
  const [ready, setReady] = useState(false);
  const [micAvailable, setMicAvailable] = useState(false);
  const [muted, setMuted] = useState(false);
  const [words, setWords] = useState<TermCardProps[]>([]);
  const [usage, setUsage] = useState({ used: initialUsed, limit: initialLimit });
  const [deadline, setDeadline] = useState<number | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [ended, setEnded] = useState(false);

  const busy = stage !== "idle";
  const outOfQuota = usage.used >= usage.limit;

  useEffect(() => {
    let disposed = false;
    // The hyperframes player registers a custom element on import and touches
    // `window`, so it is loaded client-side only and the element is created
    // after registration.
    void import("@hyperframes/player").then(() => {
      if (disposed) return;
      const player = document.createElement("hyperframes-player");
      player.className = "overlay-player";
      player.setAttribute("autoplay", "");
      player.setAttribute("muted", "");
      // Appended inside a React-owned slot (not replacing it) so React never
      // has to reconcile a node it did not create.
      playerSlotRef.current?.appendChild(player);

      const session = new PracticeSession(
        {
          stage: stageRef.current!,
          video: videoRef.current!,
          audio: audioRef.current!,
          player,
          transcript: transcriptRef.current!,
          micCanvas: canvasRef.current!,
        },
        {
          onStatus: (text, kind) => setStatus({ text, kind }),
          onStage: setStage,
          onMicAvailable: setMicAvailable,
          onMicMuted: setMuted,
          onWord: (w) => setWords((prev) => [...prev, w]),
          onQuota: (used, limit) => setUsage({ used, limit }),
          onLive: ({ maxSeconds }) => {
            setDeadline(maxSeconds > 0 ? Date.now() + maxSeconds * 1000 : null);
          },
          onEnded: () => {
            setDeadline(null);
            setEnded(true);
          },
        },
      );
      sessionRef.current = session;
      setReady(true);
      if (process.env.NODE_ENV !== "production") {
        // Dev hook: render a widget without burning session minutes —
        //   __ui({ widget: "term_card", props: { term: "Hello", reading: "ハロー", meaning: "こんにちは" } })
        (window as unknown as { __ui: (m: UiMessage) => void }).__ui = (m) => session.renderUi(m);
      }
    });
    return () => {
      disposed = true;
      sessionRef.current?.dispose();
      sessionRef.current = null;
    };
  }, []);

  // Countdown to the server-enforced time limit (display only).
  useEffect(() => {
    if (!deadline) {
      setRemaining(null);
      return;
    }
    const tick = () => setRemaining(Math.max(0, Math.round((deadline - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [deadline]);

  function start() {
    setWords([]);
    setEnded(false);
    void sessionRef.current?.start();
  }

  return (
    <>
      <div className="practice-top">
        <h1>英会話レッスン</h1>
        <div className="quota">
          今日の練習回数 <strong>{usage.used}</strong> / {usage.limit}
        </div>
      </div>

      <div className="room">
        <div ref={stageRef} className="stage" data-state={stage}>
          <video ref={videoRef} autoPlay playsInline />
          <audio ref={audioRef} autoPlay />
          <div ref={playerSlotRef} />
          <div className="stage-hero">
            <h2>Masahiro と英語で話そう</h2>
            <p>
              フレーズを教わって、声に出してまねするだけ。新しい単語は画面にカードで表示され、
              終わると単語帳に保存されます。
            </p>
            {outOfQuota ? (
              <div className="notice">今日の練習回数を使い切りました。また明日どうぞ！</div>
            ) : (
              <button className="btn btn-primary btn-lg" onClick={start} disabled={!ready || busy}>
                練習をはじめる
              </button>
            )}
            <span className="hint">マイクを使います · 1回最大5分</span>
          </div>
          <div className="stage-loader" aria-hidden="true">
            <span className="orb" />
            <span>{status.text}</span>
          </div>
        </div>

        <div className="controls">
          <div className="status" data-kind={status.kind} role="status">
            {status.text}
            {remaining !== null && <span className="timer"> · 残り {formatTime(remaining)}</span>}
          </div>
          <button
            className="mic-btn"
            disabled={!micAvailable}
            data-muted={muted ? "" : undefined}
            aria-pressed={muted}
            aria-label={muted ? "ミュート解除" : "ミュート"}
            title={muted ? "ミュート解除" : "ミュート"}
            onClick={() => sessionRef.current?.toggleMute()}
          >
            <MicIcon muted={muted} />
            <canvas ref={canvasRef} width={80} height={44} />
          </button>
          <button
            className="btn btn-sm btn-danger end"
            disabled={stage === "idle"}
            onClick={() => void sessionRef.current?.stop()}
          >
            終了する
          </button>
        </div>

        <section className="session-words card" aria-live="polite">
          <h2>このレッスンの単語</h2>
          {words.length === 0 ? (
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              コーチが教えたフレーズがここに並びます
            </p>
          ) : (
            <div className="chips">
              {words.map((w) => (
                <div key={w.term} className="word-chip">
                  <b>{w.term}</b>
                  {w.meaning && <span>{w.meaning}</span>}
                </div>
              ))}
            </div>
          )}
          {ended && words.length > 0 && (
            <div className="summary">
              <span className="muted" style={{ fontSize: 14 }}>
                {words.length}個のフレーズを単語帳に保存しました
              </span>
              <Link href="/wordbook" className="btn btn-sm">
                単語帳で復習する →
              </Link>
            </div>
          )}
        </section>

        <aside className="transcript-panel">
          <div className="panel-inner">
            <h2>会話</h2>
            <div ref={transcriptRef} className="transcript" />
          </div>
        </aside>
      </div>
    </>
  );
}

function formatTime(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

function MicIcon({ muted }: { muted: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v4" />
      {muted && <path d="M3 3l18 18" />}
    </svg>
  );
}
