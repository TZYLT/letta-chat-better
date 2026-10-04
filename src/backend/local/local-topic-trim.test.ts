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
}

function harness(input: {
  messages: LocalMessage[];
  markers?: LocalTopicMarker[];
  contextWindow?: number;
  percentage?: number;
}): Harness {
  const rewrites: LocalConversationRewriteInput[] = [];
  const events: string[] = [];
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
  };
}

describe("retentionCapTokensFor", () => {
  test("caps at the ratio of a known window", () => {
    expect(retentionCapTokensFor(100_000, 0.3)).toBe(30_000);
    expect(retentionCapTokensFor(1_000, 0.3)).toBe(300);
  });

  test("an unknown or useless window has no cap", () => {
    expect(retentionCapTokensFor(undefined, 0.3)).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(retentionCapTokensFor(0, 0.3)).toBe(Number.POSITIVE_INFINITY);
    expect(retentionCapTokensFor(Number.NaN, 0.3)).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(retentionCapTokensFor(1_000, Number.NaN)).toBe(0);
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
    expect(list.retentionCapTokens).toBe(300);
  });

  test("an unmarked context is one block with no cap when the window is unknown", () => {
    const list = listLocalTopics(
      harness({ messages: conversation(2), contextWindow: undefined }).ports,
      { conversationId: "default" },
    );

    expect(list.blocks).toHaveLength(1);
    expect(list.blocks[0]?.title).toBeNull();
    expect(list.markers).toEqual([]);
    expect(list.retentionCapTokens).toBe(Number.POSITIVE_INFINITY);
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
      retention_cap_tokens: 30_000,
    });
    // The id list is what makes the kept region real; the summary is prepended.
    expect(typeof rewrite?.summary).toBe("string");
  });

  test("the retention cap overrides a topic pick that keeps too much", async () => {
    const messages = conversation(6);
    const testHarness = harness({
      messages,
      markers: [marker("t1", "Topic A", "a6")],
      contextWindow: 1_000,
      percentage: 0.3,
    });
    const outcome = await trimLocalConversationToTopic(testHarness.ports, {
      conversationId: "default",
      pick: { kind: "topic", index: 2 },
    });

    expect(outcome.source).toBe("ratio_cap");
    expect(outcome.ratioCapApplied).toBe(true);
    expect(outcome.executed).toBe(true);
    // 300-token cap over 100-token messages: the last three messages, which
    // start on an assistant turn (that is the exact 300-token boundary).
    expect(outcome.retainedTokens).toBe(300);
    expect(outcome.requestedRetentionTokens).toBe(600);
    expect(outcome.retentionCapTokens).toBe(300);
    expect(outcome.firstKeptMessageId).toBe("a5");
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

  test("picking the first block writes nothing", async () => {
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

    expect(outcome.executed).toBe(false);
    expect(outcome.noopReason).toBe("nothing_before_boundary");
    expect(outcome.numMessagesBefore).toBe(outcome.numMessagesAfter);
    expect(testHarness.rewrites).toEqual([]);
    expect(testHarness.refreshes).toBe(0);
    expect(testHarness.events).toEqual([]);
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

  test("a window-less context reports no cap instead of a fake one", async () => {
    const testHarness = harness({
      messages: conversation(6),
      contextWindow: undefined,
    });
    const outcome = await trimLocalConversationToTopic(testHarness.ports, {
      conversationId: "default",
      pick: { kind: "ratio_suggestion" },
    });

    // No window means no retention target: the ratio helper would otherwise
    // suggest the very start of the context, which is a no-op dressed up as a cut.
    expect(outcome.executed).toBe(false);
    expect(outcome.noopReason).toBe("nothing_before_boundary");
    expect(outcome.retentionCapTokens).toBeNull();
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
    expect(stats.trim?.retention_cap_tokens).toBe(30_000);
  });
});
