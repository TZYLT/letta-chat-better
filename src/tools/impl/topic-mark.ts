/**
 * `TopicMark` — the agent-side half of the topic-marker channel.
 *
 * The tool is deliberately thin: it validates the arguments, resolves the
 * conversation, applies the frequency gate, and hands the write to
 * `LocalBackend.markTopic`. The two decisions worth testing (what counts as a
 * valid marker, and how the receipt reads) are pure functions at the bottom of
 * this file.
 *
 * Markers are metadata. Nothing here touches the context or the frozen prefix,
 * and a refused mark writes nothing at all — the gate reads
 * `topicMarkerState` before the write, never after.
 */
import { getConversationId, getCurrentAgentId } from "@/agent/context";
import { type Backend, getBackend } from "@/backend";
import { LocalBackend } from "@/backend/local/local-backend";
import {
  evaluateTopicMarkerGate,
  type TopicMarkerGateVerdict,
} from "@/backend/local/topic-compaction";

export const TOPIC_MARK_TITLE_MAX_LENGTH = 60;
export const TOPIC_MARK_SUMMARY_MAX_LENGTH = 600;

/** Markers have no meaning on the cloud backend, which keeps its own behaviour. */
export const TOPIC_MARK_REMOTE_UNSUPPORTED =
  "Topic markers are only available on the local backend. This conversation runs on the Letta API, where context is managed by the server.";

export interface TopicMarkArgs {
  title?: unknown;
  summary?: unknown;
}

export interface TopicMarkDeps {
  backend?: Backend;
  agentId?: string;
  conversationId?: string;
}

export interface TopicMarkResult {
  content: string;
  status: "success" | "error";
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Validate and normalize the arguments. `ok: false` carries the model-facing
 * reason; a rejected *gate* is a different concern and stays in the tool body.
 */
export function validateTopicMarkArgs(
  args: TopicMarkArgs,
):
  | { ok: true; title: string; summary?: string }
  | { ok: false; content: string } {
  const { title, summary } = args;
  if (typeof title !== "string" || collapseWhitespace(title).length === 0) {
    return {
      ok: false,
      content:
        "A topic marker needs a non-empty `title` naming the topic that ended.",
    };
  }
  const normalizedTitle = collapseWhitespace(title);
  if (normalizedTitle.length > TOPIC_MARK_TITLE_MAX_LENGTH) {
    return {
      ok: false,
      content: `Topic title is ${normalizedTitle.length} characters; the maximum is ${TOPIC_MARK_TITLE_MAX_LENGTH}. Use a shorter noun phrase.`,
    };
  }
  if (summary !== undefined && typeof summary !== "string") {
    return { ok: false, content: "`summary` must be a string when provided." };
  }
  const normalizedSummary =
    typeof summary === "string" ? collapseWhitespace(summary) : "";
  if (normalizedSummary.length > TOPIC_MARK_SUMMARY_MAX_LENGTH) {
    return {
      ok: false,
      content: `Topic summary is ${normalizedSummary.length} characters; the maximum is ${TOPIC_MARK_SUMMARY_MAX_LENGTH}.`,
    };
  }
  return {
    ok: true,
    title: normalizedTitle,
    ...(normalizedSummary.length > 0 ? { summary: normalizedSummary } : {}),
  };
}

/**
 * The model-facing receipt.
 *
 * Unlike the CLI trim receipts, nothing else renders these, so the copy lives
 * here rather than in a structured-facts + CLI-copy split.
 */
export function formatTopicMarkReceipt(input: {
  verdict: TopicMarkerGateVerdict;
  title: string;
  contextMessageCount: number;
}): string {
  const { verdict, title, contextMessageCount } = input;
  const position = `The marker points at the newest of ${contextMessageCount} in-context messages and does not change the context.`;
  if (verdict.status === "rejected") {
    const turns = verdict.turnsUntilAllowed;
    return `Topic marker rejected: the previous marker is too recent. Wait ${turns} more user turn${turns === 1 ? "" : "s"} before marking another topic. Nothing was written.`;
  }
  if (verdict.status === "warned") {
    return `Topic marker recorded for "${title}". This is sooner after the previous marker than recommended: one marker per topic is enough, and marking more often adds noise. ${position}`;
  }
  return `Topic marker recorded for "${title}". ${position}`;
}

export async function topic_mark(
  args: TopicMarkArgs,
  deps: TopicMarkDeps = {},
): Promise<TopicMarkResult> {
  const validated = validateTopicMarkArgs(args);
  if (!validated.ok) {
    return { content: validated.content, status: "error" };
  }

  const backend = deps.backend ?? getBackend();
  if (!(backend instanceof LocalBackend)) {
    return { content: TOPIC_MARK_REMOTE_UNSUPPORTED, status: "error" };
  }

  let agentId: string;
  try {
    agentId = deps.agentId ?? getCurrentAgentId();
  } catch {
    return {
      content:
        "A topic marker needs the calling agent and conversation; neither is available in this execution context.",
      status: "error",
    };
  }
  const conversationId =
    deps.conversationId ?? getConversationId() ?? "default";

  const state = backend.topicMarkerState(conversationId, agentId);
  if (state.contextMessageCount === 0) {
    return {
      content:
        "There is nothing in the context to anchor a topic marker to yet. Nothing was written.",
      status: "error",
    };
  }

  // A previous marker in the same turn leaves zero user turns between them, so
  // "one marker per turn" needs no separate counter: the gate rejects it.
  const verdict = evaluateTopicMarkerGate({
    turnsSincePrevious: state.turnsSinceLastMarker,
  });
  if (verdict.status === "rejected") {
    return {
      content: formatTopicMarkReceipt({
        verdict,
        title: validated.title,
        contextMessageCount: state.contextMessageCount,
      }),
      status: "error",
    };
  }

  backend.markTopic({
    conversationId,
    agentId,
    title: validated.title,
    ...(validated.summary === undefined ? {} : { summary: validated.summary }),
    createdBy: "agent",
  });
  return {
    content: formatTopicMarkReceipt({
      verdict,
      title: validated.title,
      contextMessageCount: state.contextMessageCount,
    }),
    status: "success",
  };
}
