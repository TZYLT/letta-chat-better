/**
 * Copy and parsing coverage for `/compact` (D-110 + D-119).
 *
 * The receipts are what a user reads after a destructive-feeling operation, so
 * every structured fact the planner produces — the source of the cut, the
 * rewound boundary, the ratio cap, the evicted topics — has an assertion here.
 */
import { describe, expect, test } from "bun:test";
import type { LocalTopicTrimOutcome } from "@/backend/local/local-topic-trim";
import {
  COMPACT_COMMAND_USAGE,
  COMPACT_MODE_ARGUMENTS,
  COMPACT_MODE_LOCAL_UNSUPPORTED,
  formatCompactPlanningFailure,
  formatContextPressureHint,
  formatNoMarkerCompactHint,
  formatTopicTrimReceipt,
  parseCompactCommandArgs,
} from "@/cli/helpers/compact-command";

function outcome(
  overrides: Partial<LocalTopicTrimOutcome> = {},
): LocalTopicTrimOutcome {
  return {
    executed: true,
    source: "topic_pick",
    topicTitle: null,
    summarizedTitles: ["Alpha"],
    boundaryAdjusted: false,
    ratioCapApplied: false,
    rewindTurns: 2,
    numMessagesBefore: 12,
    numMessagesAfter: 7,
    summarizedMessageCount: 6,
    requestedRetentionTokens: 600,
    retainedTokens: 600,
    retentionCapTokens: 30_000,
    firstKeptMessageId: "msg-u4",
    stats: {},
    ...overrides,
  };
}

describe("parseCompactCommandArgs", () => {
  test("no arguments means the interactive path", () => {
    expect(parseCompactCommandArgs([])).toEqual({ kind: "auto" });
  });

  test("help is its own request", () => {
    expect(parseCompactCommandArgs(["help"])).toEqual({ kind: "help" });
  });

  test("a positive number is a block pick", () => {
    expect(parseCompactCommandArgs(["3"])).toEqual({ kind: "block", index: 3 });
    expect(parseCompactCommandArgs(["007"])).toEqual({
      kind: "block",
      index: 7,
    });
  });

  test("block numbers start at one", () => {
    expect(parseCompactCommandArgs(["0"])).toEqual({
      kind: "invalid",
      message: "Block numbers start at 1.",
    });
  });

  test("mode words still parse, so the cloud path keeps working", () => {
    for (const mode of COMPACT_MODE_ARGUMENTS) {
      expect(parseCompactCommandArgs([mode])).toEqual({ kind: "mode", mode });
    }
  });

  test("junk and extra arguments are refused by name", () => {
    expect(parseCompactCommandArgs(["nope"])).toEqual({
      kind: "invalid",
      message: 'Unknown argument "nope".',
    });
    expect(parseCompactCommandArgs(["3", "4"])).toEqual({
      kind: "invalid",
      message: 'Unexpected argument "4".',
    });
  });
});

describe("formatTopicTrimReceipt", () => {
  test("reports the kept region, the evicted topics, and the source", () => {
    const receipt = formatTopicTrimReceipt(outcome());

    expect(receipt).toContain("Context trimmed.");
    expect(receipt).toContain("kept:       7 messages (~600 tokens)");
    expect(receipt).toContain("starting at msg-u4");
    expect(receipt).toContain("summarized: 6 messages (~600 tokens)");
    expect(receipt).toContain("cut point:  the topic block you picked");
    expect(receipt).toContain("topics:     Alpha");
    expect(receipt).toContain("rewound 2 user turns from the marker");
    expect(receipt).toContain("before:     12 messages in context");
    expect(receipt).toContain("evicts the provider cache");
    expect(receipt).not.toContain("cap:");
  });

  test("a single rewound turn is not pluralised", () => {
    const receipt = formatTopicTrimReceipt(outcome({ rewindTurns: 1 }));
    expect(receipt).toContain("rewound 1 user turn from the marker");
    expect(receipt).not.toContain("turns from the marker");
  });

  test("names the ratio when the cap decided, with both numbers", () => {
    const receipt = formatTopicTrimReceipt(
      outcome({
        source: "ratio_cap",
        ratioCapApplied: true,
        retentionCapTokens: 300,
        requestedRetentionTokens: 600,
      }),
    );

    expect(receipt).toContain(
      "cut point:  the retention ratio (the picked block kept too much)",
    );
    expect(receipt).toContain(
      "cap:        kept at most ~300 tokens (600 were requested)",
    );
    // A ratio cap is not a rewound marker boundary.
    expect(receipt).not.toContain("rewound");
  });

  test("says so when the ratio decided because nothing was marked", () => {
    const receipt = formatTopicTrimReceipt(
      outcome({ source: "ratio_suggestion", summarizedTitles: [] }),
    );
    expect(receipt).toContain(
      "cut point:  the retention ratio (nothing was marked)",
    );
    expect(receipt).not.toContain("topics:");
  });

  test("reports a boundary that had to move to stay legal", () => {
    const receipt = formatTopicTrimReceipt(outcome({ boundaryAdjusted: true }));
    expect(receipt).toContain("moved to avoid splitting a tool call");
  });

  test("confirming the suggested row is reported as the ratio's suggestion (V9)", () => {
    const suggested = formatTopicTrimReceipt(outcome(), {
      confirmedSuggestion: true,
    });
    expect(suggested).toContain(
      "cut point:  ratio_suggestion (the block the retention ratio points at",
    );
    expect(suggested).not.toContain("the topic block you picked");

    const capped = formatTopicTrimReceipt(
      outcome({ ratioCapApplied: true, source: "ratio_cap" }),
      { confirmedSuggestion: true },
    );
    expect(capped).toContain(
      "cut point:  ratio_cap (the suggested block kept too much",
    );
  });

  test("a refusal explains itself instead of reporting numbers", () => {
    const nothingToTrim = formatTopicTrimReceipt(
      outcome({
        executed: false,
        noopReason: "nothing_before_boundary",
      }),
    );
    expect(nothingToTrim).toContain("Nothing to trim");
    expect(nothingToTrim).not.toContain("kept:");

    expect(
      formatTopicTrimReceipt(
        outcome({ executed: false, noopReason: "empty_context" }),
      ),
    ).toContain("nothing in this conversation's context");
    expect(
      formatTopicTrimReceipt(
        outcome({ executed: false, noopReason: "unknown_block" }),
      ),
    ).toContain("Run /topics");
  });
});

describe("formatNoMarkerCompactHint", () => {
  test("points at both marking channels while the agent can mark", () => {
    const hint = formatNoMarkerCompactHint(true);
    expect(hint).toContain("retention ratio decided the cut point");
    expect(hint).toContain("TopicMark");
  });

  test("explains the switch when the agent cannot mark", () => {
    const hint = formatNoMarkerCompactHint(false);
    expect(hint).toContain("switched off");
    expect(hint).not.toContain("TopicMark");
  });
});

describe("formatContextPressureHint", () => {
  test("a soft tier only advises", () => {
    const hint = formatContextPressureHint({
      level: "soft",
      contextTokens: 750,
      contextWindow: 1_000,
      hasBlocks: false,
    });
    expect(hint).toContain("about 75%");
    expect(hint).toContain("750 of 1000 tokens");
    expect(hint).toContain("/compact moves older topics");
    expect(hint).not.toContain("past the point");
  });

  test("a hard tier with blocks points at the picker", () => {
    const hint = formatContextPressureHint({
      level: "hard",
      contextTokens: 900,
      contextWindow: 1_000,
      hasBlocks: true,
    });
    expect(hint).toContain("Pick a topic block to keep before sending");
    expect(hint).toContain("Esc to send anyway");
  });

  test("a hard tier with nothing marked says how to mark one", () => {
    const hint = formatContextPressureHint({
      level: "hard",
      contextTokens: 950,
      contextWindow: 1_000,
      hasBlocks: false,
    });
    expect(hint).toContain(
      "past the point where a turn this large can be sent",
    );
    expect(hint).toContain("/compact to trim by the retention ratio");
    expect(hint).toContain("/topic <title>");
  });
});

describe("formatCompactPlanningFailure", () => {
  test("translates the planner's 'too little context' errors", () => {
    expect(
      formatCompactPlanningFailure(
        new Error("Not enough messages for sliding window compaction."),
      ),
    ).toContain("too short to summarize");
    expect(
      formatCompactPlanningFailure(
        new Error("No assistant message found for sliding window compaction."),
      ),
    ).toContain("too short to summarize");
    expect(
      formatCompactPlanningFailure(
        new Error(
          "Assistant message index 3 is at the end of the message buffer, skipping compaction.",
        ),
      ),
    ).toContain("newest messages are already the whole context");
  });

  test("passes an unrelated failure through unchanged", () => {
    expect(formatCompactPlanningFailure(new Error("provider exploded"))).toBe(
      "provider exploded",
    );
    expect(formatCompactPlanningFailure("plain string")).toBe("plain string");
  });
});

describe("command copy", () => {
  test("the usage documents the picker, the number, and the no-op block", () => {
    expect(COMPACT_COMMAND_USAGE).toContain("/compact <n>");
    expect(COMPACT_COMMAND_USAGE).toContain("works without a terminal");
    expect(COMPACT_COMMAND_USAGE).toContain("block 1 keeps everything");
    expect(COMPACT_COMMAND_USAGE).not.toContain("self_compact");
  });

  test("the local mode refusal names the strategy", () => {
    expect(COMPACT_MODE_LOCAL_UNSUPPORTED).toContain("sliding_window");
    expect(COMPACT_MODE_LOCAL_UNSUPPORTED).toContain("/compact help");
  });
});
