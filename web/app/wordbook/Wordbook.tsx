"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export interface Word {
  id: string;
  term: string;
  reading: string | null;
  meaning: string | null;
  mastered: boolean;
  times_seen: number;
  last_seen_at: string;
}

type Filter = "all" | "learning" | "mastered";

export function Wordbook({ initialWords }: { initialWords: Word[] }) {
  const [words, setWords] = useState(initialWords);
  const [filter, setFilter] = useState<Filter>("all");
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const visible = useMemo(
    () =>
      words.filter((w) =>
        filter === "all" ? true : filter === "mastered" ? w.mastered : !w.mastered,
      ),
    [words, filter],
  );
  const learningCount = words.filter((w) => !w.mastered).length;

  async function setMastered(id: string, mastered: boolean) {
    setError(null);
    setWords((prev) => prev.map((w) => (w.id === id ? { ...w, mastered } : w)));
    const { error } = await createClient().from("words").update({ mastered }).eq("id", id);
    if (error) {
      setWords((prev) => prev.map((w) => (w.id === id ? { ...w, mastered: !mastered } : w)));
      setError("保存できませんでした。通信状況を確認してください。");
    }
  }

  if (words.length === 0) {
    return (
      <div className="card empty">
        まだ単語がありません。レッスンで教わったフレーズがここに追加されます。
        <br />
        <Link href="/practice" className="btn btn-primary" style={{ marginTop: 16 }}>
          レッスンをはじめる
        </Link>
      </div>
    );
  }

  if (reviewing) {
    return (
      <Review
        words={words.filter((w) => !w.mastered).length > 0 ? words.filter((w) => !w.mastered) : words}
        onMastered={(id) => void setMastered(id, true)}
        onExit={() => setReviewing(false)}
      />
    );
  }

  return (
    <>
      <div className="toolbar">
        <div className="seg" role="group" aria-label="表示する単語">
          {(
            [
              ["all", `すべて ${words.length}`],
              ["learning", `学習中 ${learningCount}`],
              ["mastered", `覚えた ${words.length - learningCount}`],
            ] as const
          ).map(([key, label]) => (
            <button key={key} aria-pressed={filter === key} onClick={() => setFilter(key)}>
              {label}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button className="btn btn-primary btn-sm" onClick={() => setReviewing(true)}>
          フラッシュカードで復習
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="word-table">
        {visible.map((w) => (
          <div key={w.id} className="card word-row">
            <div>
              <div className="term">{w.term}</div>
              <div className="meta">
                {[w.reading, w.meaning].filter(Boolean).join(" · ")}
                {w.times_seen > 1 && ` · ${w.times_seen}回出てきた`}
              </div>
            </div>
            <div className="actions">
              <button className="icon-btn" aria-label={`${w.term} を読み上げ`} title="読み上げ" onClick={() => speak(w.term)}>
                <SpeakerIcon />
              </button>
              <button
                className="icon-btn"
                aria-pressed={w.mastered}
                aria-label={w.mastered ? "覚えたを取り消す" : "覚えたにする"}
                title={w.mastered ? "覚えた（クリックで取り消し）" : "覚えたにする"}
                onClick={() => void setMastered(w.id, !w.mastered)}
              >
                <CheckIcon />
              </button>
            </div>
          </div>
        ))}
        {visible.length === 0 && <div className="card empty">この条件の単語はありません</div>}
      </div>
    </>
  );
}

function Review({
  words,
  onMastered,
  onExit,
}: {
  words: Word[];
  onMastered: (id: string) => void;
  onExit: () => void;
}) {
  // Shuffle once per review round.
  const [deck] = useState(() => [...words].sort(() => Math.random() - 0.5));
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const card = deck[index];

  if (!card) {
    return (
      <div className="flashcard-wrap">
        <div className="card empty" style={{ width: "min(520px, 100%)" }}>
          🎉 {deck.length}枚の復習が終わりました！
        </div>
        <button className="btn" onClick={onExit}>
          単語帳に戻る
        </button>
      </div>
    );
  }

  const next = () => {
    setFlipped(false);
    setIndex((i) => i + 1);
  };

  return (
    <div className="flashcard-wrap">
      <div className="progress">
        {index + 1} / {deck.length}
      </div>
      <button className="flashcard" onClick={() => setFlipped((f) => !f)} aria-label="カードをめくる">
        <div>
          <div className="term">{card.term}</div>
          {flipped ? (
            <>
              {card.reading && <div className="reading">{card.reading}</div>}
              {card.meaning && <div className="meaning">{card.meaning}</div>}
            </>
          ) : (
            <div className="tap">声に出して言ってから、タップして意味を確認</div>
          )}
        </div>
      </button>
      <div className="flash-actions">
        <button className="btn btn-sm" onClick={() => speak(card.term)}>
          <SpeakerIcon /> 発音を聞く
        </button>
        <button className="btn btn-sm" onClick={next}>
          もう一回あとで
        </button>
        <button
          className="btn btn-sm btn-primary"
          onClick={() => {
            onMastered(card.id);
            next();
          }}
        >
          覚えた！
        </button>
      </div>
      <button className="btn btn-sm" onClick={onExit} style={{ background: "none", border: 0 }}>
        復習をやめる
      </button>
    </div>
  );
}

/** Browser TTS — free and instant; good enough for a word-level reminder. */
function speak(text: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  u.rate = 0.9;
  window.speechSynthesis.speak(u);
}

function SpeakerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 5 6 9H3v6h3l5 4V5ZM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5 10 17l9-10" />
    </svg>
  );
}
