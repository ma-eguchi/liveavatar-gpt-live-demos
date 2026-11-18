import { isSupabaseConfigured } from "./env";
import { createClient } from "./supabase/server";

/** The signed-in user, or null (also null when Supabase is not configured yet). */
export async function getUser() {
  if (!isSupabaseConfigured()) return null;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}
