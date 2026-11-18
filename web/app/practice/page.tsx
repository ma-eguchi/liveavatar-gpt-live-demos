import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUser } from "@/lib/user";
import { PracticeRoom } from "./PracticeRoom";

export const metadata: Metadata = { title: "練習する" };
export const dynamic = "force-dynamic";

export default async function PracticePage() {
  const user = await getUser();
  if (!user) redirect("/login?next=/practice");

  const supabase = await createClient();
  const { data } = await supabase
    .rpc("usage_today")
    .single<{ used_today: number; daily_limit: number }>();

  return (
    <div className="container page">
      <PracticeRoom usedToday={data?.used_today ?? 0} dailyLimit={data?.daily_limit ?? 3} />
    </div>
  );
}
