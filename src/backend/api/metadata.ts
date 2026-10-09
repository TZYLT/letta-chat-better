import { appendLocalFeedback } from "@/telemetry/local-feedback-log";
import { apiRequest } from "./request";

export interface BalanceMetadata {
  total_balance: number;
  monthly_credit_balance: number;
  purchased_credit_balance: number;
  billing_tier: string;
}

type QuotaBucket = "empty" | "low" | "medium" | "high" | "full";

interface ModelTierQuota {
  bucket: QuotaBucket;
  dailyBucket?: QuotaBucket;
}

export interface ModelQuotaMetadata {
  lettaTier: ModelTierQuota;
  quotaWindowEnd: string;
  dailyQuotaWindowEnd?: string;
}

export type FeedbackClientType = "desktop" | "chat.letta.com" | "cli";

export function getFeedbackClientType(
  env: NodeJS.ProcessEnv = process.env,
): FeedbackClientType {
  if (env.HARUYUKI_DESKTOP_MODE === "1") {
    return "desktop";
  }
  if (env.HARUYUKI_RUNTIME_ENVIRONMENT_DEVICE_ID) {
    return "chat.letta.com";
  }
  return "cli";
}

export async function getBalanceMetadata(): Promise<BalanceMetadata> {
  return apiRequest<BalanceMetadata>("GET", "/v1/metadata/balance");
}

export async function getModelQuotaMetadata(): Promise<ModelQuotaMetadata> {
  return apiRequest<ModelQuotaMetadata>("GET", "/v1/organizations/self/quotas");
}

export async function getBillingTier(): Promise<string | null> {
  try {
    const balance = await getBalanceMetadata();
    return balance.billing_tier ?? null;
  } catch {
    return null;
  }
}

/**
 * Record a feedback submission locally.
 *
 * This used to POST to `https://api.letta.com/v1/metadata/feedback` unless a
 * Desktop runtime had a loopback server configured. There is no Cloud backend
 * any more, so the submission is written to
 * `~/.haruyuki/logs/feedback.jsonl` instead: the report still survives on disk for
 * the user to attach to an issue, and nothing leaves the machine.
 *
 * Stays async so the call sites keep their shape.
 */
export async function submitFeedbackMetadata(
  deviceId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  appendLocalFeedback({ device_id: deviceId, ...payload });
}
