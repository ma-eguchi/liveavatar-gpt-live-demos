/**
 * Environment, split by who may see it.
 *
 * NEXT_PUBLIC_* ends up in the browser bundle: the Supabase URL and anon key
 * are public by design (RLS is the security boundary). Everything else is
 * read only inside route handlers / server components.
 */

export const publicEnv = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
};

export function isSupabaseConfigured(): boolean {
  return Boolean(publicEnv.supabaseUrl && publicEnv.supabaseAnonKey);
}

/** Server-only. Throws with the missing names so a misconfigured deploy explains itself. */
export function serverEnv() {
  const env = {
    /** Where this backend reaches the orchestrator (may be a private URL). */
    orchestratorUrl: (process.env.ORCHESTRATOR_URL ?? "").replace(/\/+$/, ""),
    /** Where the BROWSER reaches it for the websocket. Defaults to the above. */
    orchestratorPublicUrl: (
      process.env.ORCHESTRATOR_PUBLIC_URL ??
      process.env.ORCHESTRATOR_URL ??
      ""
    ).replace(/\/+$/, ""),
    orchestratorSecret: process.env.ORCHESTRATOR_SECRET ?? "",
  };
  const missing = [
    ["ORCHESTRATOR_URL", env.orchestratorUrl],
    ["ORCHESTRATOR_SECRET", env.orchestratorSecret],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) throw new Error(`missing env: ${missing.join(", ")}`);
  return env;
}
