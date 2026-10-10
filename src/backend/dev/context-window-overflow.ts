import { isRecord } from "@/utils/type-guards";

function contextOverflowHaystack(error: unknown): string {
  const pieces: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (value === undefined || value === null || depth > 3) return;
    if (typeof value === "string") {
      pieces.push(value);
      return;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      pieces.push(String(value));
      return;
    }
    if (value instanceof Error) {
      pieces.push(value.name, value.message);
      for (const [key, item] of Object.entries(
        value as unknown as Record<string, unknown>,
      )) {
        pieces.push(key);
        visit(item, depth + 1);
      }
      visit((value as { cause?: unknown }).cause, depth + 1);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (isRecord(value)) {
      for (const [key, item] of Object.entries(value)) {
        pieces.push(key);
        visit(item, depth + 1);
      }
    }
  };
  visit(error, 0);
  return pieces.join("\n").toLowerCase();
}

/**
 * The local backend's own "this turn cannot be sent" verdict.
 *
 * Distinct from a provider-reported overflow: the request was never sent, so
 * the numbers behind the decision are known. It is still an overflow for every
 * classifier, which is what keeps it non-retryable and actionable.
 */
export class LocalContextOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalContextOverflowError";
  }
}

/**
 * What the operator can do about an overflow. Appended to every overflow report.
 *
 * The second sentence is not padding: the first is a dead end whenever the
 * conversation has no marker to cut at, or its markers define no block inside the
 * current context. A bare `/compact` still compresses by the rate there — the
 * rate is a share of the transcript, not a threshold it must exceed — so the
 * report points at a command that always has something to do, and `/topic` is
 * how the operator makes the cut land on a topic edge instead.
 */
export const CONTEXT_OVERFLOW_GUIDANCE =
  "Run /compact to compress the older part of the conversation. This product no longer splits context automatically. Mark a boundary with /topic <title> when you want the cut to land on a topic edge.";

/** Report for an overflow the provider reported, where the numbers are unknown. */
export const CONTEXT_OVERFLOW_MESSAGE = `Context has exceeded the model window. ${CONTEXT_OVERFLOW_GUIDANCE}`;

export function isContextWindowOverflowError(error: unknown): boolean {
  if (error instanceof LocalContextOverflowError) return true;
  const haystack = contextOverflowHaystack(error);
  return [
    "context_length_exceeded",
    "context window",
    "maximum context length",
    "max context length",
    "prompt is too long",
    "input is too long",
    "too many tokens",
    "exceeds the context",
    "exceeded the context",
    "reduce the length",
    "request too large",
    "request_too_large",
    "model_context_window_exceeded",
  ].some((marker) => haystack.includes(marker));
}
