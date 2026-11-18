import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/user";

export const metadata: Metadata = { title: "練習履歴" };
export const dynamic = "force-dynamic";

interface SessionRow {
  id: string;
  status: "starting" | "ended" | "failed";
  started_at: string;
  duration_sec: number | null;
  end_reason: string | null;
  session_words: { position: number; words: { term: string; meaning: string | null } | null }[];
}

export default async function HistoryPage() {
  const user = await getUser();
  if (!user) redirect("/login?next=/history");

  const supabase = await createClient();
  const [{ data: sessions }, { count: wordCount }, { count: masteredCount }] = await Promise.all([
    supabase
      .from("practice_sessions")
      .select("id, status, started_at, duration_sec, end_reason, session_words(position, words(term, meaning))")
      .neq("status", "failed")
      .order("started_at", { ascending: false })
      .limit(50)
      .returns<SessionRow[]>(),
    supabase.from("words").select("id", { count: "exact", head: true }),
    supabase.from("words").select("id", { count: "exact", head: true }).eq("mastered", true),
  ]);

  const list = sessions ?? [];
  const totalSec = list.reduce((s, r) => s + (r.duration_sec ?? 0), 0);
  const days = new Set(list.map((r) => dayKey(r.started_at))).size;

  return (
    <div className="container page">
      <h1 className="page-title">練習履歴</h1>
      <p className="page-lead">これまでのレッスンと、そこで出てきたフレーズです。</p>

      <div className="stats">
        <Stat value={list.length} label="レッスン回数" />
        <Stat value={days} label="練習した日数" />
        <Stat value={Math.round(totalSec / 60)} label="合計（分）" />
        <Stat value={`${masteredCount ?? 0} / ${wordCount ?? 0}`} label="覚えた / 学んだ単語" />
      </div>

      {list.length === 0 ? (
        <div className="card empty">
          まだ練習の記録がありません。
          <br />
          <Link href="/practice" className="btn btn-primary" style={{ marginTop: 16 }}>
            最初のレッスンをはじめる
          </Link>
        </div>
      ) : (
        <div className="history-list">
          {list.map((s) => {
            const words = [...s.session_words]
              .sort((a, b) => a.position - b.position)
              .map((sw) => sw.words)
              .filter((w): w is NonNullable<typeof w> => Boolean(w));
            return (
              <article key={s.id} className="card history-item">
                <header>
                  <time dateTime={s.started_at}>{formatDate(s.started_at)}</time>
                  <span className="muted" style={{ fontSize: 13 }}>
                    {s.status === "starting"
                      ? "記録中 / 未完了"
                      : `${formatDuration(s.duration_sec ?? 0)} · ${words.length}フレーズ`}
                  </span>
                </header>
                {words.length > 0 ? (
                  <div className="chips">
                    {words.map((w) => (
                      <span key={w.term} className="chip" title={w.meaning ?? undefined}>
                        {w.term}
                      </span>
                    ))}
                  </div>
                ) : (
                  <span className="muted" style={{ fontSize: 13 }}>
                    このレッスンでは単語カードは出ませんでした
                  </span>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Stat({ value, label }: { value: number | string; label: string }) {
  return (
    <div className="card stat">
      <div className="value">{value}</div>
      <div className="label">{label}</div>
    </div>
  );
}

const TZ = "Asia/Tokyo";
function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: TZ,
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}
function dayKey(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(iso));
}
function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}分${s}秒` : `${s}秒`;
}
