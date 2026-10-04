/**
 * Topic listing and user-picked trims (feature ③, D-104).
 *
 * The planning itself is pure and lives in `topic-compaction.ts`; this module is
 * the I/O shell around it: it reads the in-context list and the transcript
 * markers, resolves the retention cap from the model's window, asks the existing
 * sliding-window summarizer for the summary, and writes the result through the
 * single in-context rewrite path (`local-context-rewrite.ts`) — then refreshes
 * the frozen prefix, because a trim *is* the "compaction" application point.
 *
 * It runs against a port object rather than the backend so the ordering — and the
 * "nothing to trim must not write anything" rule — can be tested without a
 * provider, exactly like the rewrite path it delegates to.
 */
import type { LocalPiModelsRuntime } from "@/backend/dev/pi-models-runtime";
import {
  LOCAL_SLIDING_WINDOW_COMPACTION_PROMPT,
  type LocalCompactionStats,
  type LocalCompleteFunction,
  type LocalTrimStats,
  packageLocalSummaryMessage,
  summarizeLocalMessagesSlidingWindow,
} from "./compaction";
import { estimateLocalMessagesTokens } from "./local-context-estimate";
import type {
  LocalCompactionStoreResult,
  LocalConversationRewriteInput,
} from "./local-context-rewrite";
import type { LocalMessage } from "./local-message";
import type { LocalAgentRecord } from "./local-store";
import {
  DEFAULT_TOPIC_BOUNDARY_REWIND_TURNS,
  type LocalTopicMarker,
  listTopicBlocks,
  resolveTrimPlan,
  type TopicBlock,
  type TrimNoopReason,
  type TrimPlan,
  type TrimStartSource,
} from "./topic-compaction";

/** The user's pick: a 1-based block index, or "just use the ratio". */
export type LocalTopicTrimPick =
  | { kind: "topic"; index: number }
  | { kind: "ratio_suggestion" };

export interface LocalTopicTrimSettings {
  /** Retention ratio; the cap is `percentage x context window`. */
  slidingWindowPercentage: number;
  prompt?: string | null;
  clipChars?: number | null;
}

/**
 * Everything this module needs from the backend. Each member maps to one
 * existing backend responsibility, so no policy is duplicated here.
 */
export interface LocalTopicTrimPorts {
  resolveAgentId(conversationId: string): string;
  listMessages(conversationId: string, agentId: string): LocalMessage[];
  readMarkers(conversationId: string, agentId: string): LocalTopicMarker[];
  contextWindow(conversationId: string, agentId: string): number | undefined;
  /** The frozen agent, so the summary runs on the model the prefix pinned. */
  resolveSummarizerAgent(
    conversationId: string,
    agentId: string,
  ): LocalAgentRecord;
  compactionSettings(
    conversationId: string,
    agentId: string,
  ): LocalTopicTrimSettings;
  rewrite(input: LocalConversationRewriteInput): LocalCompactionStoreResult;
  /** Re-apply the frozen prefix after the context changed. */
  refreshFrozenPrefix(conversationId: string, agentId: string): Promise<void>;
  onCompactionStart?(
    conversationId: string,
    agentId: string,
    trigger: string,
  ): void | Promise<void>;
  onCompactionEnd?(
    conversationId: string,
    agentId: string,
    trigger: string,
    stats: LocalCompactionStats,
  ): void | Promise<void>;
  complete?: LocalCompleteFunction;
  storageDir: string;
  modelsRuntime?: LocalPiModelsRuntime;
}

export interface LocalTopicMarkerView {
  marker: LocalTopicMarker;
  /** False once a trim moved the anchor out of the context. */
  anchorInContext: boolean;
}

export interface LocalTopicList {
  /** Blocks cut at the effective boundaries, oldest first, trailing one included. */
  blocks: TopicBlock[];
  /** Every marker in the transcript, oldest first, for `/topics --all`. */
  markers: LocalTopicMarkerView[];
  contextMessageCount: number;
  contextTokens: number;
  contextWindow?: number;
  /**
   * `Infinity` when the window is unknown: without a window there is no
   * retention target, so the cap cannot override anything.
   */
  retentionCapTokens: number;
}

export interface LocalTopicTrimOutcome {
  /** False when the request resolved to a no-op; nothing was written. */
  executed: boolean;
  source: TrimStartSource;
  noopReason?: TrimNoopReason;
  /** The topic the kept region starts in (`null` = the current topic). */
  topicTitle: string | null;
  summarizedTitles: string[];
  boundaryAdjusted: boolean;
  ratioCapApplied: boolean;
  /** User turns the effective boundary was rewound from the marker anchor. */
  rewindTurns: number;
  numMessagesBefore: number;
  numMessagesAfter: number;
  summarizedMessageCount: number;
  requestedRetentionTokens: number;
  retainedTokens: number;
  /** `null` when the window — and therefore the cap — is unknown. */
  retentionCapTokens: number | null;
  contextWindow?: number;
  /** The kept region, so a receipt can name its first message. */
  firstKeptMessageId?: string;
  /** Exactly what was persisted on the `compaction` row. */
  stats: LocalCompactionStats;
}

export function retentionCapTokensFor(
  contextWindow: number | undefined,
  percentage: number,
): number {
  if (
    typeof contextWindow !== "number" ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0
  ) {
    return Number.POSITIVE_INFINITY;
  }
  const ratio =
    typeof percentage === "number" &&
    Number.isFinite(percentage) &&
    percentage > 0
      ? Math.min(percentage, 1)
      : 0;
  return Math.floor(contextWindow * ratio);
}

export function listLocalTopics(
  ports: LocalTopicTrimPorts,
  input: {
    conversationId: string;
    agentId?: string;
    rewindTurns?: number;
  },
): LocalTopicList {
  const agentId = input.agentId ?? ports.resolveAgentId(input.conversationId);
  const messages = ports.listMessages(input.conversationId, agentId);
  const markers = ports.readMarkers(input.conversationId, agentId);
  const contextWindow = ports.contextWindow(input.conversationId, agentId);
  const inContext = new Set(messages.map((message) => message.id));
  return {
    blocks: listTopicBlocks(messages, markers, {
      rewindTurns: input.rewindTurns ?? DEFAULT_TOPIC_BOUNDARY_REWIND_TURNS,
    }),
    markers: markers.map((marker) => ({
      marker,
      anchorInContext:
        marker.anchorMessageId !== null &&
        inContext.has(marker.anchorMessageId),
    })),
    contextMessageCount: messages.length,
    contextTokens: estimateLocalMessagesTokens(messages),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    retentionCapTokens: retentionCapTokensFor(
      contextWindow,
      ports.compactionSettings(input.conversationId, agentId)
        .slidingWindowPercentage,
    ),
  };
}

/**
 * Ask the summarizer to structure its output by topic.
 *
 * The titles are the ones being evicted, oldest first. With no titles the prompt
 * is passed through untouched, so an unmarked region summarizes exactly as it did
 * before this feature.
 */
export function topicSectionPrompt(
  basePrompt: string,
  titles: readonly string[],
): string {
  if (titles.length === 0) return basePrompt;
  const list = titles.map((title) => `- ${title}`).join("\n");
  return `${basePrompt}

Additionally, structure the summary as one section per topic listed below, in
this order, using each title as the section heading. Every topic in the list is
being evicted, so none of them may be dropped even if it looks minor.

${list}`;
}

function emptyStats(contextWindow: number | undefined): LocalCompactionStats {
  return contextWindow === undefined ? {} : { context_window: contextWindow };
}

function noopOutcome(
  input: {
    numMessagesBefore: number;
    retentionCapTokens: number;
    contextWindow?: number;
  },
  plan: TrimPlan,
): LocalTopicTrimOutcome {
  return {
    executed: false,
    source: plan.source,
    ...(plan.noopReason === undefined ? {} : { noopReason: plan.noopReason }),
    topicTitle: plan.topicTitle,
    summarizedTitles: [],
    boundaryAdjusted: plan.boundaryAdjusted,
    ratioCapApplied: plan.ratioCapApplied,
    rewindTurns: 0,
    numMessagesBefore: input.numMessagesBefore,
    numMessagesAfter: input.numMessagesBefore,
    summarizedMessageCount: 0,
    requestedRetentionTokens: 0,
    retainedTokens: estimateLocalMessagesTokens(plan.keep),
    retentionCapTokens: Number.isFinite(input.retentionCapTokens)
      ? input.retentionCapTokens
      : null,
    ...(input.contextWindow === undefined
      ? {}
      : { contextWindow: input.contextWindow }),
    stats: emptyStats(input.contextWindow),
  };
}

/**
 * Execute a user-picked trim: summarize everything before the picked boundary
 * and rewrite the in-context list as `[summary, ...kept]`.
 *
 * Every refusal path returns `executed: false` with a structured reason and
 * writes nothing — a trim that cannot honor the request must not half-apply.
 */
export async function trimLocalConversationToTopic(
  ports: LocalTopicTrimPorts,
  input: {
    conversationId: string;
    agentId?: string;
    pick: LocalTopicTrimPick;
    rewindTurns?: number;
    trigger?: string;
  },
): Promise<LocalTopicTrimOutcome> {
  const conversationId = input.conversationId;
  const agentId = input.agentId ?? ports.resolveAgentId(conversationId);
  const trigger = input.trigger ?? "manual";
  const messages = ports.listMessages(conversationId, agentId);
  const contextWindow = ports.contextWindow(conversationId, agentId);
  const settings = ports.compactionSettings(conversationId, agentId);
  const retentionCapTokens = retentionCapTokensFor(
    contextWindow,
    settings.slidingWindowPercentage,
  );
  const rewindTurns = input.rewindTurns ?? DEFAULT_TOPIC_BOUNDARY_REWIND_TURNS;
  const markers = ports.readMarkers(conversationId, agentId);
  const blocks = listTopicBlocks(messages, markers, { rewindTurns });
  const plan = resolveTrimPlan({
    messages,
    blocks,
    pick: input.pick,
    retentionCapTokens,
  });
  const windowFields = contextWindow === undefined ? {} : { contextWindow };
  if (plan.noop) {
    return noopOutcome(
      {
        numMessagesBefore: messages.length,
        retentionCapTokens,
        ...windowFields,
      },
      plan,
    );
  }

  const pick = input.pick;
  const pickedBlock =
    pick.kind === "topic"
      ? blocks.find((block) => block.index === pick.index)
      : undefined;
  const summarize = [...plan.summarize];
  const keep = [...plan.keep];
  const requestedRetentionTokens = estimateLocalMessagesTokens(
    messages.slice(plan.requestedStartIndex),
  );
  const retainedTokens = estimateLocalMessagesTokens(keep);
  const trim: LocalTrimStats = {
    source: plan.source,
    topic_title: plan.topicTitle,
    summarized_titles: [...plan.summarizedTitles],
    rewind_turns: pickedBlock ? pickedBlock.rewindTurns : 0,
    requested_retention_tokens: requestedRetentionTokens,
    retention_tokens: retainedTokens,
    retention_cap_tokens: Number.isFinite(retentionCapTokens)
      ? retentionCapTokens
      : null,
  };
  await ports.onCompactionStart?.(conversationId, agentId, trigger);
  const summary = await summarizeLocalMessagesSlidingWindow({
    conversationId,
    agent: ports.resolveSummarizerAgent(conversationId, agentId),
    messages: summarize,
    complete: ports.complete,
    prompt: topicSectionPrompt(
      settings.prompt ?? LOCAL_SLIDING_WINDOW_COMPACTION_PROMPT,
      plan.summarizedTitles,
    ),
    clipChars: settings.clipChars,
    localProviderAuthStorageDir: ports.storageDir,
    modelsRuntime: ports.modelsRuntime,
  });

  const stats: LocalCompactionStats = {
    trigger,
    context_tokens_before: estimateLocalMessagesTokens(messages),
    context_tokens_after: Math.ceil(summary.length / 4) + retainedTokens,
    messages_count_before: messages.length,
    messages_count_after: 1 + keep.length,
    trim,
    ...(contextWindow === undefined ? {} : { context_window: contextWindow }),
  };
  const written = ports.rewrite({
    conversationId,
    agentId,
    summary,
    packedSummary: packageLocalSummaryMessage(summary, stats, "sliding_window"),
    stats,
    remainingMessages: keep,
  });
  await ports.refreshFrozenPrefix(conversationId, agentId);
  await ports.onCompactionEnd?.(conversationId, agentId, trigger, stats);

  return {
    executed: true,
    source: plan.source,
    topicTitle: plan.topicTitle,
    summarizedTitles: [...plan.summarizedTitles],
    boundaryAdjusted: plan.boundaryAdjusted,
    ratioCapApplied: plan.ratioCapApplied,
    rewindTurns: trim.rewind_turns,
    numMessagesBefore: written.numMessagesBefore,
    numMessagesAfter: written.numMessagesAfter,
    summarizedMessageCount: summarize.length,
    requestedRetentionTokens,
    retainedTokens,
    retentionCapTokens: trim.retention_cap_tokens,
    ...windowFields,
    ...(keep[0] === undefined ? {} : { firstKeptMessageId: keep[0].id }),
    stats,
  };
}
