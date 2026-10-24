import type { Turn } from "./messages";

export interface RehearsalSettings {
  productName: string;
  productDescription: string;
  customerContext: string;
}
export interface CustomerProfile {
  name: string;
  role: string;
  situation: string;
}
export interface StartRehearsalRequest {
  settings: RehearsalSettings;
  previousAttemptId?: string;
  previousAccessToken?: string;
}
export interface StartRehearsalResponse {
  session_id: string;
  attemptId: string;
  accessToken: string;
  livekit_url: string;
  livekit_client_token: string;
  ws_path: string;
  customer: CustomerProfile;
  durationSeconds: number;
}
export interface RehearsalResult {
  attemptId: string;
  settings: RehearsalSettings;
  customer: CustomerProfile;
  status: "connecting" | "active" | "finishing" | "completed" | "incomplete";
  startedAt: number | null;
  endedAt: number | null;
  endReason: string | null;
  turns: Turn[];
  previousAttemptId?: string;
  evaluationStatus: "not_implemented";
}
