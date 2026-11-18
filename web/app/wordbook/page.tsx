import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/user";
import { Wordbook, type Word } from "./Wordbook";

export const metadata: Metadata = { title: "単語帳" };
export const dynamic = "force-dynamic";

export default async function WordbookPage() {
  const user = await getUser();
  if (!user) redirect("/login?next=/wordbook");

  const supabase = await createClient();
  const { data } = await supabase
    .from("words")
    .select("id, term, reading, meaning, mastered, times_seen, last_seen_at")
    .order("last_seen_at", { ascending: false })
    .returns<Word[]>();

  return (
    <div className="container page">
      <h1 className="page-title">単語帳</h1>
      <p className="page-lead">レッスンで出てきたフレーズが自動で追加されます。フラッシュカードで復習しましょう。</p>
      <Wordbook initialWords={data ?? []} />
    </div>
  );
}
