/**
 * Unit coverage for the topic-trim shell (D-104).
 *
 * The planner itself is covered by `topic-compaction.test.ts`; what matters here
 * is the shell's contract: a trim that cannot honor the pick must write nothing
 * (no summary call, no rewrite, no frozen-prefix refresh, no mod event), and a
 * trim that does run must hand the summarizer the picked region and persist the
 * audit metadata a reader needs to tell a topic cut from a plain one.
 */
import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { LocalCompactionStats } from "@/backend/local/compaction";
import type { LocalConversationRewriteInput } from "@/backend/local/local-context-rewrite";
import {
  emptyLocalUsage,
  type LocalMessage,
} from "@/backend/local/local-message";
import {
  type LocalTopicTrimPorts,
  listLocalTopics,
  retentionCapTokensFor,
  topicSectionPrompt,
  trimLocalConversationToTopic,
} from "@/backend/local/local-topic-trim";
import type { LocalTopicMarker } from "@/backend/local/topic-compaction";

/**
 * A summarizer stand-in that resolves without any network or credentials: the
 * shell only needs `complete` to be reachable, never actually called for real.
 */
const SUMMARIZER_AGENT = {
  id: "agent-1",
  name: "Local",
  description: null,
  system: "",
  tags: [],
  model: "opencode-go/glm-5.2",
  model_settings: {},
} as never;

function summaryAssistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "opencode-go",
    model: "glm-5.2",
    usage: emptyLocalUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function textForTokens(tokens: number): string {
  return "x".repeat(tokens * 4);
}

function userMessage(id: string, tokens = 100): LocalMessage {
  return {
    id,
    role: "user",
    content: [{ type: "text", text: textForTokens(tokens) }],
    timestamp: 0,
  } as LocalMessage;
}

function assistantMessage(id: string, tokens = 100): LocalMessage {
  return {
    id,
    role: "assistant",
    content: [{ type: "text", text: textForTokens(tokens) }],
    timestamp: 0,
  } as LocalMessage;
}

/** `turns` turns of 100 tokens each: `u1, a1, u2, a2, …`. */
function conversation(turns: number): LocalMessage[] {
  const messages: LocalMessage[] = [];
  for (let turn = 1; turn <= turns; turn += 1) {
    messages.push(userMessage(`u${turn}`));
    messages.push(assistantMessage(`a${turn}`));
  }
  return messages;
}

function marker(
  id: string,
  title: string,
  anchorMessageId: string,
): LocalTopicMarker {
  return {
    id,
    title,
    createdBy: "agent",
    anchorMessageId,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

interface Harness {
  ports: LocalTopicTrimPorts;
  rewrites: LocalConversationRewriteInput[];
  refreshes: number;
  events: string[];
  /** Conversations whose one-shot nudge streak the trim ended. */
  streakClearedFor: string[];
}

function harness(input: {
  messages: LocalMessage[];
  markers?: LocalTopicMarker[];
  contextWindow?: number;
  percentage?: number;
}): Harness {
  const rewrites: LocalConversationRewriteInput[] = [];
  const events: string[] = [];
  const streakClearedFor: string[] = [];
  const state = { refreshes: 0 };
  const ports: LocalTopicTrimPorts = {
    resolveAgentId: () => "agent-1",
    listMessages: () => input.messages,
    readMarkers: () => input.markers ?? [],
    contextWindow: () => input.contextWindow,
    resolveSummarizerAgent: () => SUMMARIZER_AGENT,
    compactionSettings: () => ({
      slidingWindowPercentage: input.percentage ?? 0.3,
    }),
    rewrite: (rewriteInput) => {
      rewrites.push(rewriteInput);
      return {
        numMessagesBefore: input.messages.length,
        numMessagesAfter: 1 + (rewriteInput.remainingMessages?.length ?? 0),
        summaryMessage: { id: "summary" } as LocalMessage,
      };
    },
    clearTopicNudgeStreak: (conversationId) => {
      streakClearedFor.push(conversationId);
    },
    refreshFrozenPrefix: async () => {
      state.refreshes += 1;
    },
    onCompactionStart: () => {
      events.push("start");
    },
    onCompactionEnd: (_conversationId, _agentId, _trigger, stats) => {
      events.push(`end:${String(stats.messages_count_after)}`);
    },
    complete: async () => summaryAssistantMessage("summary"),
    storageDir: "memory",
  };
  return {
    ports,
    rewrites,
    get refreshes() {
      return state.refreshes;
    },
    events,
    streakClearedFor,
  };
}

describe("retentionCapTokensFor", () => {
  test("keeps (1 - rate) of the length being compressed", () => {
    // The base is the transcript being compressed, not the model's window.
    expect(retentionCapTokensFor(100_000, 0.3)).toBe(70_000);
    expect(retentionCapTokensFor(1_000, 0.3)).toBe(700);
  });

  test("an unmeasurable length has no target", () => {
    expect(retentionCapTokensFor(undefined, 0.3)).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(retentionCapTokensFor(0, 0.3)).toBe(Number.POSITIVE_INFINITY);
    expect(retentionCapTokensFor(Number.NaN, 0.3)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  test("an unusable rate is normalized the way the planner normalizes it (M-3)", () => {
    // The sliding-window planner reads the same setting: `NaN`/missing is the
    // default 0.3, `<= 0` is its smallest step (0.1), and anything above 1
    // compresses everything. The cap must not disagree with it.
    expect(retentionCapTokensFor(1_000, Number.NaN)).toBe(700);
    expect(retentionCapTokensFor(1_000, 0)).toBe(900);
    expect(retentionCapTokensFor(1_000, -2)).toBe(900);
    expect(retentionCapTokensFor(1_000, 1.5)).toBe(0);
  });
});

describe("topicSectionPrompt", () => {
  test("passes the prompt through when nothing marked is evicted", () => {
    expect(topicSectionPrompt("base", [])).toBe("base");
  });

  test("names every evicted topic, oldest first", () => {
    const prompt = topicSectionPrompt("base", ["Auth", "Deploy"]);
    expect(prompt.startsWith("base\n")).toBe(true);
    expect(prompt).toContain("- Auth\n- Deploy");
  });

  test("the section requirement comes before the base prompt's output rule (L-15)", () => {
    const prompt = topicSectionPrompt(
      "Context.\n\nKeep your summary under 300 words. Only output the summary.",
      ["Auth"],
    );

    expect(prompt.indexOf("one section per topic")).toBeLessThan(
      prompt.indexOf("Only output the summary."),
    );
    expect(prompt).toContain("- Auth");
  });
});

describe("listLocalTopics", () => {
  test("cuts blocks at effective boundaries and flags dead anchors", () => {
    const messages = conversation(6);
    const list = listLocalTopics(
      harness({
        messages,
        markers: [
          marker("t1", "Topic A", "a6"),
          marker("t2", "Gone", "trimmed-away"),
        ],
        contextWindow: 1_000,
        percentage: 0.3,
      }).ports,
      { conversationId: "default" },
    );

    // Rewind 2 from turn 6 lands on turn 4; the second marker's anchor is gone,
    // so it is absorbed into the first block instead of emitting an empty one.
    expect(list.blocks.map((block) => block.boundaryMessageId)).toEqual([
      "u1",
      "u4",
    ]);
    expect(list.blocks[0]?.absorbedTitles).toEqual(["Gone"]);
    expect(list.blocks[1]?.title).toBeNull();
    expect(list.markers.map((view) => view.anchorInContext)).toEqual([
      true,
      false,
    ]);
    expect(list.contextMessageCount).toBe(12);
    expect(list.contextTokens).toBe(1_200);
    expect(list.contextWindow).toBe(1_000);
    // 1,200 transcript tokens compressed at 0.3: the target keeps 840.
    expect(list.retentionCapTokens).toBe(840);
  });

  test("an unmarked context is one block, with its target from the transcript (not the window)", () => {
    const list = listLocalTopics(
      harness({ messages: conversation(2), contextWindow: undefined }).ports,
      { conversationId: "default" },
    );

    expect(list.blocks).toHaveLength(1);
    expect(list.blocks[0]?.title).toBeNull();
    expect(list.markers).toEqual([]);
    // 4 messages x 100 tokens = 400; the window is unknown and irrelevant here.
    expect(list.retentionCapTokens).toBe(280);
    expect(list.contextWindow).toBeUndefined();
  });
});

describe("trimLocalConversationToTopic", () => {
  test("picking a later block summarizes the earlier topic and keeps the rest", async () => {
    const messages = conversation(6);
    const testHarness = harness({
      messages,
      markers: [marker("t1", "Topic A", "a6")],
      contextWindow: 100_000,
    });
    const outcome = await trimLocalConversationToTopic(testHarness.ports, {
      conversationId: "default",
      pick: { kind: "topic", index: 2 },
    });

    expect(outcome.executed).toBe(true);
    expect(outcome.source).toBe("topic_pick");
    expect(outcome.topicTitle).toBeNull();
    expect(outcome.summarizedTitles).toEqual(["Topic A"]);
    expect(outcome.rewindTurns).toBe(2);
    expect(outcome.firstKeptMessageId).toBe("u4");
    expect(outcome.summarizedMessageCount).toBe(6);
    expect(outcome.numMessagesAfter).toBe(7);
    expect(testHarness.refreshes).toBe(1);
    expect(testHarness.events).toEqual(["start", "end:7"]);

    const rewrite = testHarness.rewrites[0];
    expect(rewrite?.remainingMessages?.map((message) => message.id)).toEqual([
      "u4",
      "a4",
      "u5",
      "a5",
      "u6",
      "a6",
    ]);
    expect(rewrite?.stats?.trim).toEqual({
      source: "topic_pick",
      topic_title: null,
      summarized_titles: ["Topic A"],
      rewind_turns: 2,
      requested_retention_tokens: 600,
      retention_tokens: 600,
      retention_cap_tokens: 840,
    });
    // The id list is what makes the kept region real; the summary is prepended.
    expect(typeof rewrite?.summary).toBe("string");
  });

  test("the rate overrides a topic pick that keeps more than it allows", async () => {
    const messages = conversation(6);
    const testHarness = harness({
      messages,
      markers: [marker("t1", "Topic A", "a6")],
      percentage: 0.6,
    });
    const outcome = await trimLocalConversationToTopic(testHarness.ports, {
      conversationId: "default",
      pick: { kind: "topic", index: 2 },
    });

    expect(outcome.source).toBe("ratio_cap");
    expect(outcome.ratioCapApplied).toBe(true);
    expect(outcome.executed).toBe(true);
    // 1,200 tokens at 0.6 keeps 480: the largest suffix inside that is four
    // 100-token messages, which start on the user turn u5.
    expect(outcome.retainedTokens).toBe(400);
    expect(outcome.requestedRetentionTokens).toBe(600);
    expect(outcome.retentionCapTokens).toBe(480);
    expect(outcome.firstKeptMessageId).toBe("u5");
  });

  test("a ratio suggestion needs no markers at all", async () => {
    const testHarness = harness({
      messages: conversation(6),
      contextWindow: 1_000,
    });
    const outcome = await trimLocalConversationToTopic(testHarness.ports, {
      conversationId: "default",
      pick: { kind: "ratio_suggestion" },
    });

    expect(outcome.executed).toBe(true);
    expect(outcome.source).toBe("ratio_suggestion");
    expect(outcome.summarizedTitles).toEqual([]);
    expect(outcome.rewindTurns).toBe(0);
    expect(testHarness.rewrites).toHaveLength(1);
  });

  test("picking the first block is cut down to the rate instead of writing nothing", async () => {
    const messages = conversation(6);
    const testHarness = harness({
      messages,
      markers: [marker("t1", "Topic A", "a6")],
      contextWindow: 100_000,
    });
    const outcome = await trimLocalConversationToTopic(testHarness.ports, {
      conversationId: "default",
      pick: { kind: "topic", index: 1 },
    });

    // Block 1 keeps the whole context; the rate caps what any cut may keep, so
    // the pick resolves to the rate's own boundary (1,200 x 0.7 = 840 tokens).
    expect(outcome.executed).toBe(true);
    expect(outcome.source).toBe("ratio_cap");
    expect(outcome.ratioCapApplied).toBe(true);
    expect(outcome.requestedRetentionTokens).toBe(1_200);
    expect(outcome.retainedTokens).toBe(800);
    expect(outcome.firstKeptMessageId).toBe("u3");
    expect(testHarness.rewrites).toHaveLength(1);
    expect(testHarness.refreshes).toBe(1);
  });

  test("an unknown block writes nothing", async () => {
    const testHarness = harness({
      messages: conversation(6),
      contextWindow: 100_000,
    });
    const outcome = await trimLocalConversationToTopic(testHarness.ports, {
      conversationId: "default",
      pick: { kind: "topic", index: 7 },
    });

    expect(outcome.noopReason).toBe("unknown_block");
    expect(testHarness.rewrites).toEqual([]);
    expect(testHarness.events).toEqual([]);
  });

  test("an empty context writes nothing", async () => {
    const testHarness = harness({ messages: [], contextWindow: 1_000 });
    const outcome = await trimLocalConversationToTopic(testHarness.ports, {
      conversationId: "default",
      pick: { kind: "ratio_suggestion" },
    });

    expect(outcome.noopReason).toBe("empty_context");
    expect(outcome.retainedTokens).toBe(0);
    expect(testHarness.rewrites).toEqual([]);
  });

  test("a successful trim ends the unmarked nudge streak (M-4)", async () => {
    const testHarness = harness({
      messages: conversation(6),
      contextWindow: 1_000,
    });
    const outcome = await trimLocalConversationToTopic(testHarness.ports, {
      conversationId: "conv-9",
      pick: { kind: "ratio_suggestion" },
    });

    expect(outcome.executed).toBe(true);
    expect(testHarness.streakClearedFor).toEqual(["conv-9"]);
  });

  test("a refused trim leaves the nudge streak alone (M-4)", async () => {
    const testHarness = harness({ messages: [], contextWindow: 1_000 });
    const outcome = await trimLocalConversationToTopic(testHarness.ports, {
      conversationId: "conv-9",
      pick: { kind: "topic", index: 1 },
    });

    expect(outcome.executed).toBe(false);
    expect(testHarness.streakClearedFor).toEqual([]);
  });

  test("a window-less context still compresses: the target comes from the transcript", async () => {
    const testHarness = harness({
      messages: conversation(6),
      contextWindow: undefined,
    });
    const outcome = await trimLocalConversationToTopic(testHarness.ports, {
      conversationId: "default",
      pick: { kind: "ratio_suggestion" },
    });

    // 1,200 tokens at the default 0.3 rate: keep 840, compress the older 360.
    expect(outcome.executed).toBe(true);
    expect(outcome.retentionCapTokens).toBe(840);
    expect(outcome.contextWindow).toBeUndefined();
  });

  test("the summarizer runs on the topic-section prompt", async () => {
    const messages = conversation(6);
    const prompts: string[] = [];
    const testHarness = harness({
      messages,
      markers: [marker("t1", "Topic A", "a6")],
      contextWindow: 100_000,
    });
    // Capture the prompt the shell hands to the summarizer by faking `complete`.
    const ports: LocalTopicTrimPorts = {
      ...testHarness.ports,
      complete: async (_model, context) => {
        prompts.push(context.systemPrompt ?? "");
        return summaryAssistantMessage("SUM");
      },
    };
    const outcome = await trimLocalConversationToTopic(ports, {
      conversationId: "default",
      pick: { kind: "topic", index: 2 },
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("- Topic A");
    expect(prompts[0]).toContain("one section per topic");
    expect(outcome.executed).toBe(true);
  });

  test("an unmarked region keeps the plain prompt", async () => {
    const prompts: string[] = [];
    const testHarness = harness({
      messages: conversation(6),
      contextWindow: 1_000,
    });
    await trimLocalConversationToTopic(
      {
        ...testHarness.ports,
        complete: async (_model, context) => {
          prompts.push(context.systemPrompt ?? "");
          return summaryAssistantMessage("SUM");
        },
      },
      { conversationId: "default", pick: { kind: "ratio_suggestion" } },
    );

    expect(prompts[0]).not.toContain("one section per topic");
  });
});

describe("trim stats shape", () => {
  test("the persisted stats carry the trim audit fields", async () => {
    const testHarness = harness({
      messages: conversation(6),
      markers: [marker("t1", "Topic A", "a6")],
      contextWindow: 100_000,
    });
    await trimLocalConversationToTopic(testHarness.ports, {
      conversationId: "default",
      pick: { kind: "topic", index: 2 },
      trigger: "manual",
    });

    const stats = testHarness.rewrites[0]?.stats as LocalCompactionStats;
    expect(stats.trigger).toBe("manual");
    expect(stats.messages_count_before).toBe(12);
    expect(stats.messages_count_after).toBe(7);
    expect(stats.context_window).toBe(100_000);
    expect(stats.trim?.retention_cap_tokens).toBe(840);
  });
});
