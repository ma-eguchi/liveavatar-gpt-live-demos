import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  CustomerProfile,
  RehearsalResult,
  RehearsalSettings,
} from "../../shared/rehearsal";
import type { Turn } from "../../shared/messages";

export function validateSettings(input: unknown): RehearsalSettings {
  if (!input || typeof input !== "object")
    throw new Error("商談設定を入力してください。");
  const value = input as Record<string, unknown>;
  const field = (key: string, max: number, required: boolean): string => {
    const raw = value[key];
    if (
      typeof raw !== "string" ||
      raw.length > max ||
      (required && !raw.trim())
    )
      throw new Error(`入力内容を確認してください（${key}: ${max}文字以内）。`);
    return raw.trim();
  };
  return {
    productName: field("productName", 100, true),
    productDescription: field("productDescription", 1000, true),
    customerContext: field("customerContext", 500, false),
  };
}
export interface Scenario {
  id: string;
  customer: CustomerProfile;
  privateContext: string;
}
export interface Attempt {
  result: RehearsalResult;
  token: string;
  scenario: Scenario;
  createdAt: number;
  sessionId?: string;
}
export class AttemptStore {
  private attempts = new Map<string, Attempt>();
  create(settings: RehearsalSettings, previous?: Attempt): Attempt {
    this.prune();
    const scenario = previous?.scenario ?? {
      id: randomUUID(),
      customer: {
        name: "佐藤",
        role: "導入検討の担当者",
        situation:
          settings.customerContext ||
          "架空の企業で業務改善を検討しています。初回の情報交換です。",
      },
      privateContext:
        "以下は練習用の仮定。現状: 既存の運用を続けており、変更の手間を懸念している。課題: 商材で解決する課題には心当たりがあるが深刻度はまだ整理できていない。業務への影響: 数値未計測。予算: 未定。導入時期: まず今後3か月で検討。決裁: 担当者が比較し上長が承認。懸念: 現場の負担と導入効果。次回条件: 自社の課題に沿った具体例を確認できるなら30分の打ち合わせを検討する。入力と矛盾する仮定は断定しない。",
    };
    const attempt: Attempt = {
      token: randomBytes(32).toString("hex"),
      scenario,
      createdAt: Date.now(),
      result: {
        attemptId: randomUUID(),
        settings: previous?.result.settings ?? settings,
        customer: scenario.customer,
        status: "connecting",
        startedAt: null,
        endedAt: null,
        endReason: null,
        turns: [],
        ...(previous ? { previousAttemptId: previous.result.attemptId } : {}),
        evaluationStatus: "not_implemented",
      },
    };
    this.attempts.set(attempt.result.attemptId, attempt);
    return attempt;
  }
  authorize(id: string, token: unknown): Attempt | undefined {
    this.prune();
    const attempt = this.attempts.get(id);
    if (!attempt || typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token))
      return;
    return timingSafeEqual(Buffer.from(token), Buffer.from(attempt.token))
      ? attempt
      : undefined;
  }
  forSession(id: string, token: unknown): Attempt | undefined {
    const attempt = [...this.attempts.values()].find((a) => a.sessionId === id);
    return attempt && this.authorize(attempt.result.attemptId, token);
  }
  upsert(attempt: Attempt, turn: Turn): void {
    const old = attempt.result.turns.findIndex((t) => t.id === turn.id);
    if (old < 0) attempt.result.turns.push({ ...turn });
    else attempt.result.turns[old] = { ...attempt.result.turns[old], ...turn };
  }
  finish(attempt: Attempt, reason: string): void {
    attempt.result.endedAt = Date.now();
    attempt.result.endReason = reason;
    attempt.result.status =
      ["client_stop", "time_limit"].includes(reason) &&
      attempt.result.turns.some((t) => t.role === "user" && t.text.trim())
        ? "completed"
        : "incomplete";
  }
  private prune(): void {
    for (const [id, a] of this.attempts)
      if (
        a.result.endedAt !== null &&
        Date.now() - a.result.endedAt > 3_600_000
      )
        this.attempts.delete(id);
  }
}
export const attempts = new AttemptStore();
