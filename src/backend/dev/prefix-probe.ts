import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";

import { canonicalJson } from "@/backend/local/prefix-freeze";
import { isRecord } from "@/utils/type-guards";

/**
 * Strict prefix freeze payload probe (D-008).
 *
 * When `LETTA_PREFIX_PROBE_DIR` is set, every provider request payload is
 * written to `<dir>/payload-<conversationId>-<seq>.json` so adjacent turns can
 * be compared offline: the system segment hash, the tools-field hash, and the
 * shared message prefix length (implementation route §5.1). Disabled by
 * default; a probe failure must never break the provider turn.
 *
 * The analysis half is pure so `scripts/verify-prefix-probe.ts` and the unit
 * tests share exactly one definition of "the prefix is stable".
 */

function prefixProbeDir(): string | undefined {
  const raw = process.env.LETTA_PREFIX_PROBE_DIR;
  const dir = raw?.trim();
  return dir && dir.length > 0 ? dir : undefined;
}

function sanitizeSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  return sanitized.length > 0 ? sanitized : "conversation";
}

const probeSeqByConversation = new Map<string, number>();

/** Test-only: clear the per-conversation sequence counter between cases. */
export function resetPrefixProbeSequence(): void {
  probeSeqByConversation.clear();
}

/** Wrap the existing `onPayload` hook with the probe writer. No-op unless the
 * `LETTA_PREFIX_PROBE_DIR` environment variable is set.
 */
export function withPrefixProbe(
  existing: SimpleStreamOptions["onPayload"] | undefined,
  context: { conversationId: string; modelId?: string },
): SimpleStreamOptions["onPayload"] | undefined {
  const dir = prefixProbeDir();
  if (dir === undefined) return existing;
  return async (payload, _model) => {
    try {
      const seq = (probeSeqByConversation.get(context.conversationId) ?? 0) + 1;
      probeSeqByConversation.set(context.conversationId, seq);
      mkdirSync(dir, { recursive: true });
      const record = {
        conversationId: context.conversationId,
        ...(context.modelId !== undefined ? { modelId: context.modelId } : {}),
        seq,
        payload,
      };
      const fileName = `payload-${sanitizeSegment(context.conversationId)}-${String(seq).padStart(4, "0")}.json`;
      writeFileSync(
        join(dir, fileName),
        `${JSON.stringify(record, null, 2)}\n`,
        "utf8",
      );
    } catch {
      // Best-effort probe: a write failure must never break the provider turn.
    }
    return existing?.(payload, _model);
  };
}

// --- analysis -------------------------------------------------------------

export interface PrefixProbeRecord {
  conversationId: string;
  seq: number;
  payload: unknown;
}

export interface PrefixProbeComparison {
  fromSeq: number;
  toSeq: number;
  systemStable: boolean;
  toolsStable: boolean;
  /** Number of leading messages identical between the two turns. */
  commonMessagePrefix: number;
  laterMessageCount: number;
  /** True when the earlier message list is a byte-identical prefix of the later. */
  messagesAppended: boolean;
}

export interface PrefixProbeConversationReport {
  conversationId: string;
  turns: number;
  comparisons: PrefixProbeComparison[];
}

export interface PrefixProbeReport {
  conversations: PrefixProbeConversationReport[];
  systemStable: boolean;
  toolsStable: boolean;
  pass: boolean;
}

function systemSegment(payload: unknown): string {
  if (!isRecord(payload)) return canonicalJson(null);
  const value = payload.system ?? payload.instructions;
  return canonicalJson(value ?? null);
}

function toolsSegment(payload: unknown): string | undefined {
  if (!isRecord(payload) || payload.tools === undefined) return undefined;
  return canonicalJson(payload.tools);
}

function messagesSegment(payload: unknown): unknown[] {
  if (!isRecord(payload)) return [];
  const value = payload.messages ?? payload.input;
  return Array.isArray(value) ? value : [];
}

function commonPrefixLength(a: unknown[], b: unknown[]): number {
  const max = Math.min(a.length, b.length);
  let index = 0;
  while (index < max && canonicalJson(a[index]) === canonicalJson(b[index])) {
    index += 1;
  }
  return index;
}

export function comparePrefixProbeTurns(
  previous: PrefixProbeRecord,
  next: PrefixProbeRecord,
): PrefixProbeComparison {
  const previousMessages = messagesSegment(previous.payload);
  const nextMessages = messagesSegment(next.payload);
  const common = commonPrefixLength(previousMessages, nextMessages);
  return {
    fromSeq: previous.seq,
    toSeq: next.seq,
    systemStable:
      systemSegment(previous.payload) === systemSegment(next.payload),
    toolsStable: toolsSegment(previous.payload) === toolsSegment(next.payload),
    commonMessagePrefix: common,
    laterMessageCount: nextMessages.length,
    messagesAppended: common >= previousMessages.length,
  };
}

export function analyzePrefixProbe(
  records: readonly PrefixProbeRecord[],
): PrefixProbeReport {
  const byConversation = new Map<string, PrefixProbeRecord[]>();
  for (const record of records) {
    const list = byConversation.get(record.conversationId);
    if (list) list.push(record);
    else byConversation.set(record.conversationId, [record]);
  }

  const conversations: PrefixProbeConversationReport[] = [];
  for (const [conversationId, list] of byConversation) {
    const sorted = [...list].sort((a, b) => a.seq - b.seq);
    const comparisons: PrefixProbeComparison[] = [];
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const next = sorted[index];
      if (!previous || !next) continue;
      comparisons.push(comparePrefixProbeTurns(previous, next));
    }
    conversations.push({ conversationId, turns: sorted.length, comparisons });
  }
  conversations.sort((a, b) =>
    a.conversationId.localeCompare(b.conversationId),
  );

  const comparisons = conversations.flatMap((entry) => entry.comparisons);
  const systemStable = comparisons.every((entry) => entry.systemStable);
  const toolsStable = comparisons.every((entry) => entry.toolsStable);
  return {
    conversations,
    systemStable,
    toolsStable,
    pass: systemStable && toolsStable,
  };
}

function messageLine(comparison: PrefixProbeComparison): string {
  const range = `${comparison.commonMessagePrefix}/${comparison.laterMessageCount}`;
  return comparison.messagesAppended
    ? `messages appended (shared prefix ${range})`
    : `messages diverge at index ${comparison.commonMessagePrefix} (shared prefix ${range})`;
}

export function formatPrefixProbeReport(report: PrefixProbeReport): string {
  const turnCount = report.conversations.reduce(
    (total, entry) => total + entry.turns,
    0,
  );
  const lines = [
    `prefix probe: ${report.conversations.length} conversation(s), ${turnCount} payload(s)`,
  ];
  for (const conversation of report.conversations) {
    lines.push(
      `  ${conversation.conversationId}: ${conversation.turns} turn(s)`,
    );
    for (const comparison of conversation.comparisons) {
      const system = comparison.systemStable ? "system STABLE" : "system DRIFT";
      const tools = comparison.toolsStable ? "tools STABLE" : "tools DRIFT";
      lines.push(
        `    ${String(comparison.fromSeq).padStart(4, "0")} -> ${String(comparison.toSeq).padStart(4, "0")}  ${system}  ${tools}  ${messageLine(comparison)}`,
      );
    }
  }
  lines.push(report.pass ? "RESULT: PASS" : "RESULT: FAIL");
  return lines.join("\n");
}
