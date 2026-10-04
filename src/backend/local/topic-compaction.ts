/**
 * Pure planning logic for feature ③ (topic-based context management).
 *
 * Everything here is deterministic and free of IO so the trim plan and the
 * marker gate can be unit-tested without a provider, a store, or a clock:
 *
 * - `listTopicBlocks` turns transcript markers into blocks of the *in-context*
 *   message list. A marker stores only its original anchor; the effective
 *   boundary is derived on every read by rewinding a few user turns, so
 *   changing `topic_boundary_rewind_turns` immediately applies to every
 *   existing marker without rewriting the transcript.
 * - `ratioSuggestionMessageId` / `resolveTrimPlan` decide where a trim starts,
 *   with the retention ratio as a hard cap (the topic boundary is an
 *   optimization that may lose to it).
 *
 * User-facing copy lives in the CLI, not here — `source`, `noopReason`, and the
 * adjustment flags are the structured facts a receipt is rendered from.
 */
import {
  estimateLocalMessagesTokens,
  estimateLocalMessageTokens,
} from "./local-context-estimate";
import type { LocalMessage } from "./local-message";

export const DEFAULT_TOPIC_BOUNDARY_REWIND_TURNS = 2;
export const MAX_TOPIC_BOUNDARY_REWIND_TURNS = 3;
export const DEFAULT_TOPIC_MARKER_WARN_TURNS = 10;
export const DEFAULT_TOPIC_MARKER_REJECT_TURNS = 5;
export const DEFAULT_TOPIC_NUDGE_TURNS = 50;

/** A transcript `topic` entry, projected to what the planner needs. */
export interface LocalTopicMarker {
  id: string;
  title: string;
  createdBy: "agent" | "user";
  anchorMessageId: string | null;
  createdAt: string;
}

export interface TopicBlock {
  /** 1-based, oldest to newest. */
  index: number;
  /**
   * The topic this block belongs to — the marker that *ends* it. `null` for the
   * trailing "current topic (not marked finished)" block.
   */
  title: string | null;
  markerId: string | null;
  createdBy: "agent" | "user" | null;
  /** Where that ending marker was written (display only; boundaries are older). */
  anchorMessageId: string | null;
  /**
   * Titles of markers whose boundary was clamped onto this block (they were too
   * close to the previous marker to delimit a block of their own).
   */
  absorbedTitles: string[];
  /** First message of the block: the effective boundary that starts it. */
  boundaryMessageId: string;
  /** Inclusive/exclusive indices into the in-context list. */
  startIndex: number;
  endIndex: number;
  /**
   * User turns rewound to derive this block's start — that is, the rewind that
   * applied to the *previous* marker. `0` for the first block and whenever the
   * start is the beginning of the context.
   */
  rewindTurns: number;
  /** Anchor of the marker that starts this block (`null` for the first block). */
  startMarkerAnchorMessageId: string | null;
  messageCount: number;
  tokens: number;
  /** Creation time of the block's first message. */
  startsAt: string;
  /** A one-message block is not worth cutting on its own. */
  sparse: boolean;
}

export type TrimStartSource = "topic_pick" | "ratio_suggestion" | "ratio_cap";

export type TrimNoopReason =
  | "empty_context"
  | "nothing_before_boundary"
  | "unknown_block"
  | "no_suggestion";

export type TrimBoundaryAdjustReason =
  | "start_message_not_in_context"
  | "start_split_tool_pair"
  | "no_safe_start";

export interface TrimPlan {
  /** Index of the first kept message; `0` means nothing is trimmed. */
  startIndex: number;
  /**
   * The boundary the request asked for, before the retention cap moved it. Equals
   * `startIndex` unless `ratioCapApplied`; it is what a receipt reports as the
   * *requested* retention so the cap override is visible in the numbers, not only
   * in the `source` label.
   */
  requestedStartIndex: number;
  summarize: readonly LocalMessage[];
  /** What stays in context; a no-op plan keeps everything. */
  keep: readonly LocalMessage[];
  source: TrimStartSource;
  /** Name of the topic the kept region starts in (`null` = current topic). */
  topicTitle: string | null;
  /** Names of the topics folded into the new summary, oldest first. */
  summarizedTitles: readonly string[];
  /** The requested boundary had to move to a safe start. */
  boundaryAdjusted: boolean;
  boundaryAdjustReason?: TrimBoundaryAdjustReason;
  /** True when the retention cap overrode the picked topic boundary. */
  ratioCapApplied: boolean;
  noop?: boolean;
  noopReason?: TrimNoopReason;
}

export interface TopicMarkerGateVerdict {
  status: "accepted" | "warned" | "rejected";
  /** User turns still needed before the gate stops complaining (0 = none). */
  turnsUntilAllowed: number;
}

/** Messages that start a user turn. A compaction summary is not a user turn. */
export function isLocalUserTurnMessage(message: LocalMessage): boolean {
  return message.role === "user" && message.metadata?.compaction === undefined;
}

export function normalizeTopicBoundaryRewindTurns(
  value: number | undefined,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_TOPIC_BOUNDARY_REWIND_TURNS;
  }
  return Math.min(
    MAX_TOPIC_BOUNDARY_REWIND_TURNS,
    Math.max(0, Math.trunc(value)),
  );
}

function userTurnStartIndexes(
  messages: readonly LocalMessage[],
): readonly number[] {
  const starts: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message && isLocalUserTurnMessage(message)) starts.push(index);
  }
  return starts;
}

/** Largest position `p` with `values[p] <= target`, or -1. */
function lastPositionAtMost(values: readonly number[], target: number): number {
  let found = -1;
  for (let position = 0; position < values.length; position += 1) {
    const value = values[position];
    if (value === undefined || value > target) break;
    found = position;
  }
  return found;
}

function messageCreatedAt(message: LocalMessage): string {
  const createdAt = message.metadata?.created_at;
  if (typeof createdAt === "string" && createdAt) return createdAt;
  return Number.isFinite(message.timestamp)
    ? new Date(message.timestamp).toISOString()
    : "";
}

/**
 * A safe trim boundary never starts on a tool result: that would leave an
 * orphan result in the kept region whose assistant call was summarized.
 */
function advanceToSafeStart(
  messages: readonly LocalMessage[],
  from: number,
): number {
  let index = from;
  while (index < messages.length && messages[index]?.role === "toolResult") {
    index += 1;
  }
  return index;
}

interface EffectiveBoundary {
  index: number;
  rewindTurns: number;
}

/**
 * Resolve every marker's effective boundary as a message index.
 *
 * The boundary is the first message of the user turn `rewindTurns` turns older
 * than the turn holding the marker's anchor. Three clamps apply:
 *
 * - a boundary never moves before the previous marker's boundary, so a block
 *   can never disappear (two markers closer than `rewindTurns` produce one
 *   block whose title list absorbs the later marker);
 * - a boundary never starts on a tool result (`advanceToSafeStart`);
 * - a boundary never moves past its own anchor.
 *
 * An anchor that left the context (trimmed, or written into an empty context)
 * resolves to the previous boundary, which absorbs the marker the same way.
 */
function effectiveBoundaries(
  messages: readonly LocalMessage[],
  markers: readonly LocalTopicMarker[],
  rewindTurns: number,
): EffectiveBoundary[] {
  const rewind = normalizeTopicBoundaryRewindTurns(rewindTurns);
  const starts = userTurnStartIndexes(messages);
  const boundaries: EffectiveBoundary[] = [];
  let previous = 0;

  for (const marker of markers) {
    const anchorIndex = marker.anchorMessageId
      ? messages.findIndex((message) => message.id === marker.anchorMessageId)
      : -1;
    let target = previous;
    let appliedRewind = 0;

    if (anchorIndex >= 0) {
      const anchorTurn = lastPositionAtMost(starts, anchorIndex);
      if (anchorTurn >= 0) {
        const targetTurn = Math.max(0, anchorTurn - rewind);
        target = starts[targetTurn] ?? 0;
        appliedRewind = anchorTurn - targetTurn;
      } else {
        // The anchor precedes the first user turn: nothing older to rewind to.
        target = 0;
      }
      target = Math.min(target, anchorIndex);
    }

    target = advanceToSafeStart(messages, Math.max(target, previous));
    const clampedRewind = target === previous ? 0 : appliedRewind;
    boundaries.push({ index: target, rewindTurns: clampedRewind });
    previous = target;
  }

  return boundaries;
}

/** Effective boundary message ids, one per marker, in transcript order. */
export function effectiveBoundaryMessageIds(
  messages: readonly LocalMessage[],
  markers: readonly LocalTopicMarker[],
  rewindTurns: number,
): (string | null)[] {
  return effectiveBoundaries(messages, markers, rewindTurns).map(
    (boundary) => messages[boundary.index]?.id ?? null,
  );
}

/**
 * Split the in-context list into topic blocks, oldest first. The trailing block
 * is the current, not-yet-marked topic (`title: null`) and always exists when
 * the context is non-empty.
 *
 * A block is the region `(boundary[i-1], boundary[i]]`: its `title` names the
 * topic that ends there (marker `i`), while `rewindTurns` and
 * `startMarkerAnchorMessageId` describe how its *start* was derived from the
 * previous marker.
 */
export function listTopicBlocks(
  messages: readonly LocalMessage[],
  markers: readonly LocalTopicMarker[],
  options: { rewindTurns?: number } = {},
): TopicBlock[] {
  const boundaries = effectiveBoundaries(
    messages,
    markers,
    options.rewindTurns ?? DEFAULT_TOPIC_BOUNDARY_REWIND_TURNS,
  );
  const blocks: TopicBlock[] = [];
  let start = 0;
  let startRewindTurns = 0;
  let startMarkerAnchorMessageId: string | null = null;

  const addBlock = (
    blockStart: number,
    end: number,
    endingMarker: LocalTopicMarker | null,
  ): void => {
    const slice = messages.slice(blockStart, end);
    const first = slice[0];
    if (!first) return;
    blocks.push({
      index: blocks.length + 1,
      title: endingMarker ? endingMarker.title : null,
      markerId: endingMarker ? endingMarker.id : null,
      createdBy: endingMarker ? endingMarker.createdBy : null,
      anchorMessageId: endingMarker ? endingMarker.anchorMessageId : null,
      absorbedTitles: [],
      boundaryMessageId: first.id,
      startIndex: blockStart,
      endIndex: end,
      rewindTurns: startRewindTurns,
      startMarkerAnchorMessageId,
      messageCount: slice.length,
      tokens: estimateLocalMessagesTokens(slice),
      startsAt: messageCreatedAt(first),
      sparse: slice.length <= 1,
    });
  };

  for (let position = 0; position < markers.length; position += 1) {
    const marker = markers[position];
    const boundary = boundaries[position];
    if (!marker || !boundary) continue;
    if (boundary.index <= start) {
      // Clamped onto the previous boundary: absorb this title into the block
      // that already ends there instead of emitting an empty block.
      const previousBlock = blocks.at(-1);
      if (previousBlock) previousBlock.absorbedTitles.push(marker.title);
      continue;
    }
    addBlock(start, boundary.index, marker);
    start = boundary.index;
    startRewindTurns = boundary.rewindTurns;
    startMarkerAnchorMessageId = marker.anchorMessageId;
  }

  if (start < messages.length) {
    addBlock(start, messages.length, null);
  }

  return blocks;
}

/** Titles of the topics wholly inside the summarized region, oldest first. */
function summarizedTopicTitles(
  blocks: readonly TopicBlock[],
  startIndex: number,
): string[] {
  const titles: string[] = [];
  for (const block of blocks) {
    if (block.endIndex > startIndex) break;
    if (block.title) titles.push(block.title);
    titles.push(...block.absorbedTitles);
  }
  return titles;
}

/**
 * Smallest keep-region that fits `retentionCapTokens`, walking back from the
 * newest message. Returns the start of that region, or `null` for an empty
 * context. A single message over the cap is kept rather than summarized.
 */
export function ratioSuggestionMessageId(
  messages: readonly LocalMessage[],
  retentionCapTokens: number,
): string | null {
  const last = messages.at(-1);
  if (!last) return null;
  const cap = Number.isFinite(retentionCapTokens)
    ? Math.max(0, retentionCapTokens)
    : Number.POSITIVE_INFINITY;

  let total = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (total + estimateLocalMessageTokens(message) > cap) {
      return (messages[index + 1] ?? message).id;
    }
    total += estimateLocalMessageTokens(message);
  }
  return messages[0]?.id ?? null;
}

export function alignTrimBoundary(
  messages: readonly LocalMessage[],
  startMessageId: string,
): {
  startIndex: number;
  adjusted: boolean;
  reason?: TrimBoundaryAdjustReason;
} {
  const rawIndex = messages.findIndex(
    (message) => message.id === startMessageId,
  );
  if (rawIndex < 0) {
    return {
      startIndex: 0,
      adjusted: true,
      reason: "start_message_not_in_context",
    };
  }
  const aligned = advanceToSafeStart(messages, rawIndex);
  if (aligned >= messages.length) {
    // Nothing would be kept; report "nothing to trim" rather than an empty
    // context. The caller still sees that the requested point was illegal.
    return { startIndex: 0, adjusted: true, reason: "no_safe_start" };
  }
  return aligned === rawIndex
    ? { startIndex: rawIndex, adjusted: false }
    : { startIndex: aligned, adjusted: true, reason: "start_split_tool_pair" };
}

function noopPlan(
  messages: readonly LocalMessage[],
  source: TrimStartSource,
  reason: TrimNoopReason,
  topicTitle: string | null = null,
): TrimPlan {
  return {
    startIndex: 0,
    requestedStartIndex: 0,
    summarize: [],
    keep: [...messages],
    source,
    topicTitle,
    summarizedTitles: [],
    boundaryAdjusted: false,
    ratioCapApplied: false,
    noop: true,
    noopReason: reason,
  };
}

/**
 * Decide where a user-initiated trim starts.
 *
 * A topic pick is honored only while it keeps at most `retentionCapTokens`;
 * otherwise the ratio position wins and the plan reports `ratio_cap`, because
 * the ratio is a hard cap and the topic boundary is best-effort.
 */
export function resolveTrimPlan(input: {
  messages: readonly LocalMessage[];
  blocks: readonly TopicBlock[];
  pick: { kind: "topic"; index: number } | { kind: "ratio_suggestion" };
  retentionCapTokens: number;
}): TrimPlan {
  const { messages, blocks, pick, retentionCapTokens } = input;
  if (messages.length === 0) {
    return noopPlan(messages, "topic_pick", "empty_context");
  }

  let candidateId: string | null;
  let source: TrimStartSource;
  let topicTitle: string | null = null;

  if (pick.kind === "topic") {
    const block = blocks.find((candidate) => candidate.index === pick.index);
    if (!block) return noopPlan(messages, "topic_pick", "unknown_block");
    topicTitle = block.title;
    candidateId = block.boundaryMessageId;
    source = "topic_pick";
  } else {
    source = "ratio_suggestion";
    candidateId = ratioSuggestionMessageId(messages, retentionCapTokens);
    if (!candidateId) return noopPlan(messages, source, "no_suggestion");
  }

  const aligned = alignTrimBoundary(messages, candidateId);
  if (aligned.startIndex <= 0) {
    return noopPlan(messages, source, "nothing_before_boundary", topicTitle);
  }

  let startIndex = aligned.startIndex;
  const requestedStartIndex = aligned.startIndex;
  let ratioCapApplied = false;
  if (
    estimateLocalMessagesTokens(messages.slice(startIndex)) > retentionCapTokens
  ) {
    const cappedId = ratioSuggestionMessageId(messages, retentionCapTokens);
    const capped = cappedId ? alignTrimBoundary(messages, cappedId) : null;
    if (capped && capped.startIndex > startIndex) {
      startIndex = capped.startIndex;
      ratioCapApplied = true;
      source = "ratio_cap";
    }
  }

  return {
    startIndex,
    requestedStartIndex,
    summarize: messages.slice(0, startIndex),
    keep: messages.slice(startIndex),
    source,
    topicTitle,
    summarizedTitles: summarizedTopicTitles(blocks, startIndex),
    boundaryAdjusted: aligned.adjusted,
    ...(aligned.reason ? { boundaryAdjustReason: aligned.reason } : {}),
    ratioCapApplied,
  };
}

/**
 * Frequency gate for `TopicMark`, measured in user turns since the previous
 * marker. `0` disables a threshold; the user's own `/topic` command does not
 * consult this.
 */
export function evaluateTopicMarkerGate(input: {
  turnsSincePrevious: number;
  warnTurns?: number;
  rejectTurns?: number;
}): TopicMarkerGateVerdict {
  const warnTurns = input.warnTurns ?? DEFAULT_TOPIC_MARKER_WARN_TURNS;
  const rejectTurns = input.rejectTurns ?? DEFAULT_TOPIC_MARKER_REJECT_TURNS;
  const turns = Number.isFinite(input.turnsSincePrevious)
    ? Math.max(0, Math.trunc(input.turnsSincePrevious))
    : 0;

  if (rejectTurns > 0 && turns < rejectTurns) {
    return { status: "rejected", turnsUntilAllowed: rejectTurns - turns };
  }
  if (warnTurns > 0 && turns < warnTurns) {
    return { status: "warned", turnsUntilAllowed: warnTurns - turns };
  }
  return { status: "accepted", turnsUntilAllowed: 0 };
}

/**
 * One-shot nudge after `nudgeTurns` user turns without a marker. The caller
 * persists `alreadySentForStreak`, so a long unmarked stretch nudges once and a
 * new marker resets the streak.
 */
export function shouldNudgeTopicMarker(input: {
  turnsSinceLastMarker: number;
  nudgeTurns?: number;
  alreadySentForStreak: boolean;
}): boolean {
  return decideTopicNudge(input).due;
}

export type TopicNudgeReason =
  | "due"
  | "disabled"
  | "below_threshold"
  | "already_sent";

export interface TopicNudgeDecision {
  due: boolean;
  /** Why — structured, so a receipt or a log never has to guess. */
  reason: TopicNudgeReason;
  turnsSinceLastMarker: number;
  nudgeTurns: number;
}

/**
 * The same decision as `shouldNudgeTopicMarker`, with the reason kept.
 *
 * `nudgeTurns = 0` disables the nudge (D-115). The threshold is compared
 * *before* the flag so a stale flag stays distinguishable: a flag that is set
 * while the stretch is below the threshold means the stretch it belonged to
 * ended (a new marker, or a trim), and the caller clears it. Reporting that as
 * "already_sent" would hide the reset.
 */
export function decideTopicNudge(input: {
  turnsSinceLastMarker: number;
  nudgeTurns?: number;
  alreadySentForStreak: boolean;
}): TopicNudgeDecision {
  const nudgeTurns = input.nudgeTurns ?? DEFAULT_TOPIC_NUDGE_TURNS;
  const turnsSinceLastMarker = Number.isFinite(input.turnsSinceLastMarker)
    ? Math.max(0, Math.trunc(input.turnsSinceLastMarker))
    : 0;
  const base = { turnsSinceLastMarker, nudgeTurns };
  if (nudgeTurns <= 0) return { ...base, due: false, reason: "disabled" };
  if (turnsSinceLastMarker < nudgeTurns) {
    return { ...base, due: false, reason: "below_threshold" };
  }
  return input.alreadySentForStreak
    ? { ...base, due: false, reason: "already_sent" }
    : { ...base, due: true, reason: "due" };
}

/**
 * User turns since the last marker's anchor, or since the start of the context
 * when there is no marker (or its anchor left the context). Feeds both the
 * frequency gate and the nudge.
 */
export function userTurnsSinceLastTopicMarker(
  messages: readonly LocalMessage[],
  markers: readonly LocalTopicMarker[],
): number {
  let anchorIndex = -1;
  for (let position = markers.length - 1; position >= 0; position -= 1) {
    const anchorMessageId = markers[position]?.anchorMessageId;
    if (!anchorMessageId) continue;
    const index = messages.findIndex(
      (message) => message.id === anchorMessageId,
    );
    if (index >= 0) {
      anchorIndex = index;
      break;
    }
  }
  let turns = 0;
  for (let index = anchorIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message && isLocalUserTurnMessage(message)) turns += 1;
  }
  return turns;
}
