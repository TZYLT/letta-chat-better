/**
 * Argument parsing and copy for `/compact` (feature ③, D-110 + D-119).
 *
 * Local compaction is no longer "summarize by ratio, automatically": the user
 * picks the topic block to keep, and the retention ratio survives only as a hard
 * upper bound and as the fallback suggestion when nothing has been marked. The
 * cloud backend keeps its own mode-based behaviour, so mode words still parse —
 * the local path is what rejects them.
 *
 * Everything here is pure: the CLI and the listener share the parsing and the
 * receipts, and tests cover them without a backend.
 */
import type { LocalTopicTrimOutcome } from "@/backend/local/local-topic-trim";

/** Mode words the cloud backend still accepts. */
export const COMPACT_MODE_ARGUMENTS = [
  "all",
  "sliding_window",
  "self_compact_all",
  "self_compact_sliding_window",
] as const;

export type CompactModeArgument = (typeof COMPACT_MODE_ARGUMENTS)[number];

export type CompactCommandRequest =
  | { kind: "help" }
  | { kind: "auto" }
  | { kind: "block"; index: number }
  | { kind: "mode"; mode: CompactModeArgument }
  | { kind: "invalid"; message: string };

export const COMPACT_COMMAND_USAGE = [
  "/compact [n]",
  "",
  "Summarize the older part of this conversation and keep the rest.",
  "",
  "USAGE",
  "  /compact        — pick a topic block to keep (uses the ratio when nothing is marked)",
  "  /compact <n>    — keep block n straight away (works without a terminal)",
  "  /compact help   — show this help",
  "",
  "Local compaction never splits context by itself. `/topics` lists the blocks,",
  "and n counts from the oldest: block 1 keeps everything, so there is nothing",
  "to trim there. When no marker defines a boundary (nothing marked yet, or every",
  "marker anchored at or before the start of the context), `/compact` trims by the",
  "retention ratio instead of asking.",
].join("\n");

/**
 * What a trim did, or refused to do.
 *
 * `confirmedSuggestion` covers the picker's default row: the cut is still
 * topic-aligned (the suggestion *is* a block), but the user did not choose it —
 * the retention ratio did — and the receipt has to say so (V9, `ratio_suggestion`).
 */
export function formatTopicTrimReceipt(
  outcome: LocalTopicTrimOutcome,
  options: { confirmedSuggestion?: boolean } = {},
): string {
  if (!outcome.executed) return formatTopicTrimRefusal(outcome);

  const confirmedSuggestion = options.confirmedSuggestion === true;
  const source = confirmedSuggestion
    ? outcome.ratioCapApplied
      ? "ratio_cap (the suggested block kept too much, so the ratio cut earlier)"
      : "ratio_suggestion (the block the retention ratio points at, confirmed as it was)"
    : {
        topic_pick: "the topic block you picked",
        ratio_suggestion:
          "the retention ratio (no marker defines a boundary here, so it decided)",
        ratio_cap: "the retention ratio (the picked block kept too much)",
      }[outcome.source];
  const lines = [
    "Context trimmed.",
    `  kept:       ${outcome.numMessagesAfter} messages (~${outcome.retainedTokens} tokens), starting at ${outcome.firstKeptMessageId ?? "the summary"}`,
    `  summarized: ${outcome.summarizedMessageCount} messages (~${outcome.summarizedTokens} tokens)`,
    `  cut point:  ${source}`,
  ];
  if (outcome.summarizedTitles.length > 0) {
    lines.push(`  topics:     ${outcome.summarizedTitles.join(", ")}`);
  }
  if (outcome.source === "topic_pick" && outcome.rewindTurns > 0) {
    lines.push(
      `  boundary:   rewound ${outcome.rewindTurns} user turn${outcome.rewindTurns === 1 ? "" : "s"} from the marker, so the new topic keeps its opening`,
    );
  }
  if (outcome.boundaryAdjusted) {
    lines.push(
      "  adjusted:   the requested cut point was moved to avoid splitting a tool call",
    );
  }
  if (outcome.ratioCapApplied) {
    lines.push(
      `  cap:        kept at most ~${outcome.retentionCapTokens ?? 0} tokens (${outcome.requestedRetentionTokens} were requested)`,
    );
  }
  lines.push(
    `  before:     ${outcome.numMessagesBefore} messages in context`,
    "",
    "The evicted messages stay on disk: /search still finds them, and the summary replaces them in context.",
    "(warning: this evicts the provider cache and increases cost on the next turn)",
  );
  return lines.join("\n");
}

function formatTopicTrimRefusal(outcome: LocalTopicTrimOutcome): string {
  switch (outcome.noopReason) {
    case "empty_context":
    case "no_suggestion":
      return "There is nothing in this conversation's context to trim.";
    case "unknown_block":
      return "That topic block does not exist. Run /topics to list the current blocks.";
    default:
      // The cut point resolved to the start of the context. Which *reason* it did
      // decides the advice: only the ratio path means "the context already fits".
      if (outcome.source === "ratio_suggestion") {
        const cap = outcome.retentionCapTokens;
        const target = cap === null ? "" : ` (~${cap} tokens)`;
        // Not a dead end: the ratio has nothing to do only because everything the
        // transcript holds already fits its budget. A topic pick is not bound by
        // that — it just has to stay under the cap — so it can still cut.
        return `Nothing to trim: the transcript (~${outcome.retainedTokens} tokens) already fits inside the retention ratio${target}, so trimming by the ratio would write nothing. Run /topics and pick a block to keep to reclaim room anyway — a topic pick cuts even when the ratio has nothing to do. Nothing was written.`;
      }
      return "Nothing to trim: that cut point is the start of the context, so everything in it is already kept. Run /topics to see the blocks you can cut at. Nothing was written.";
  }
}

/**
 * `/compact` on a conversation that has no markers (D-119): the ratio decides,
 * so the command acts instead of opening a picker with one row.
 */
export function formatNoMarkerCompactHint(
  topicMarkingEnabled: boolean,
): string {
  return topicMarkingEnabled
    ? "No topic markers yet, so the retention ratio decided the cut point. Mark boundaries with /topic, or let the agent call TopicMark, to choose a cleaner point next time."
    : "No topic markers yet, so the retention ratio decided the cut point. Topic marking is switched off, so only your own /topic markers would define blocks.";
}

/**
 * `/compact` on a conversation whose markers define no block of their own (H-2):
 * a `/topic` placed in the first turns, or every marker anchor trimmed away. The
 * picker would have one disabled row, so the ratio decides — and the note has to
 * say *why*, because "no markers yet" would be false.
 */
export function formatSingleBlockCompactHint(input: {
  topicMarkingEnabled: boolean;
  liveMarkerAnchor: boolean;
}): string {
  const why = input.liveMarkerAnchor
    ? "The marker in this conversation sits at the very start of the current context, so there is no earlier block to summarize."
    : "Every marker's anchor has left the current context, so no marker defines a boundary here.";
  const wayOut =
    "Run /topic <title> to mark a fresh boundary; /compact can cut at it.";
  return input.topicMarkingEnabled
    ? `${why} The retention ratio decided the cut point instead. ${wayOut} The agent can also mark one with TopicMark when a topic ends.`
    : `${why} The retention ratio decided the cut point instead. ${wayOut} Topic marking is switched off, so only your own /topic markers define blocks.`;
}

/**
 * Advisory line for the pre-send pressure check (D-112). `soft` only informs;
 * `hard` is the tier the local backend refuses to cross, so with no blocks to
 * choose between the line has to say what to do about it.
 *
 * `hasBlocks` and `hasMarkers` are separate on purpose: markers that define no
 * boundary in the current context (a `/topic` in the first turns, or anchors
 * trimmed away) leave one block — and must not be described as "nothing has
 * marked a boundary yet" (H-2).
 *
 * `ratioHasWork` closes the other half of that gap: the two tiers compare the
 * **whole** context against the window (the provider's `context_tokens`, which
 * includes the compiled system prompt, memory and tool definitions), while the
 * trim planner compares the **transcript** against the retention ratio. With a
 * large prompt floor the tier can fire while the ratio path would write nothing,
 * so advising `/compact` there sends the user straight into
 * "Nothing to trim: … already fits inside the retention ratio".
 */
export function formatContextPressureHint(input: {
  level: "soft" | "hard";
  contextTokens: number;
  contextWindow: number;
  hasBlocks: boolean;
  hasMarkers: boolean;
  /** `ratioHasTrimmableContent(list)`: whether a ratio trim would write anything. */
  ratioHasWork: boolean;
  /** Tokens the trim planner measures: the in-context transcript only. */
  transcriptTokens: number;
  /** The transcript budget the retention ratio allows. */
  retentionCapTokens: number;
}): string {
  const percent = Math.round((input.contextTokens / input.contextWindow) * 100);
  const usage = `The context is at about ${percent}% of this model's window (${input.contextTokens} of ${input.contextWindow} tokens).`;
  const capText = Number.isFinite(input.retentionCapTokens)
    ? `~${input.retentionCapTokens}-token retention ratio`
    : "retention ratio";
  // Why the ratio path is a dead end, and the move that still reclaims room.
  const ratioDeadEnd = ` The transcript is ~${input.transcriptTokens} tokens, already inside the ${capText}, so a ratio trim would write nothing; the rest of the window is the system prompt, memory and tool definitions.`;
  const topicWayOut =
    " Mark a boundary with /topic <title> and keep the block after it to reclaim room anyway.";
  if (input.level === "soft") {
    if (!input.ratioHasWork) {
      return `${usage}${ratioDeadEnd}${topicWayOut}`;
    }
    return `${usage} /compact moves older topics into a summary when you want more room.`;
  }
  if (input.hasBlocks) {
    return `${usage} Pick a topic block to keep before sending, or press Esc to send anyway.`;
  }
  const why = input.hasMarkers
    ? "the markers in this conversation define no boundary inside the current context"
    : "nothing has marked a topic boundary yet";
  if (!input.ratioHasWork) {
    return `${usage} This is past the point where a turn this large can be sent, and ${why}.${ratioDeadEnd}${topicWayOut}`;
  }
  const wayOut = input.hasMarkers
    ? "/topic <title> to mark a fresh boundary"
    : "/topic <title> to mark a boundary for a cleaner cut";
  return `${usage} This is past the point where a turn this large can be sent, and ${why}. Run /compact to trim by the retention ratio, or ${wayOut}.`;
}

/**
 * Turn a planning failure into something actionable. Local compaction refuses
 * to plan when there is too little context to summarize, which used to surface
 * as the planner's own error text.
 */
export function formatCompactPlanningFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("Not enough messages") ||
    message.includes("No assistant message found")
  ) {
    return "Nothing to trim: this conversation is too short to summarize. Nothing was written.";
  }
  if (message.includes("at the end of the message buffer")) {
    return "Nothing to trim: the newest messages are already the whole context.";
  }
  return message;
}

/** Parse the arguments after the command word. */
export function parseCompactCommandArgs(
  args: readonly string[],
): CompactCommandRequest {
  const [first, ...rest] = args;
  if (first === undefined) return { kind: "auto" };
  if (first === "help") return { kind: "help" };
  if (rest.length > 0) {
    return {
      kind: "invalid",
      message: `Unexpected argument "${rest[0]}".`,
    };
  }
  if ((COMPACT_MODE_ARGUMENTS as readonly string[]).includes(first)) {
    return { kind: "mode", mode: first as CompactModeArgument };
  }
  if (/^\d+$/.test(first)) {
    const index = Number.parseInt(first, 10);
    if (index >= 1) return { kind: "block", index };
    return { kind: "invalid", message: "Block numbers start at 1." };
  }
  return { kind: "invalid", message: `Unknown argument "${first}".` };
}

/** Mode names are a cloud-backend feature; local compaction is always sliding-window. */
export const COMPACT_MODE_LOCAL_UNSUPPORTED =
  "Local compaction always uses the sliding_window strategy, so it takes no mode argument. Run /compact help.";
