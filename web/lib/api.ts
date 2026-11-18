/** Response of POST /api/session/start (Next.js backend → browser). */
export interface SessionStartResponse {
  practice_session_id: string;
  livekit_url: string;
  livekit_client_token: string;
  /** Absolute wss:// URL to the orchestrator, ticket included. */
  ws_url: string;
  /** 0 = no limit. */
  max_session_seconds: number;
  used_today: number;
  daily_limit: number;
}
