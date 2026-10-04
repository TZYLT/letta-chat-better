/**
 * Behavioural coverage for `/compact` (D-110 + D-119).
 *
 * The command is where "the user picks the cut point" actually happens, so the
 * claims under test are: a numbered pick trims and reports; a bare `/compact`
 * parks a request for the picker instead of trimming; an unmarked conversation
 * trims by ratio without a picker; mode arguments are refused locally; and a
 * non-local backend keeps the cloud path. The environment (command runner,
 * reminder state, description regeneration) is faked, because the point is the
 * ordering of the calls the command makes, not the terminal it renders into.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { ConversationMessageCreateBody } from "@/backend";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import type { HeadlessTurnExecutor } from "@/backend/dev/headless-turn-executor";
import { LocalBackend } from "@/backend/local/local-backend";
import {
  type CompactCommandContext,
  handleCompactCommand,
  isCompactCommand,
  offerTrimBeforeSend,
  type SendPressureContext,
} from "@/cli/app/submit-compact-commands";
import type { ActiveOverlay, AppCommandRunner } from "@/cli/app/types";
import {
  COMPACT_COMMAND_USAGE,
  COMPACT_MODE_LOCAL_UNSUPPORTED,
} from "@/cli/helpers/compact-command";
import {
  type ContextTracker,
  createContextTracker,
} from "@/cli/helpers/context-tracker";
import { takeTopicTrimRequest } from "@/cli/helpers/topic-trim-request";
import {
  createSharedReminderState,
  type SharedReminderState,
} from "@/reminders/state";

const temporaryDirectories: string[] = [];

async function createStorageDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "compact-command-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  __testSetBackend(null);
  takeTopicTrimRequest();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function lettaStreamFromChunks(
  chunks: LettaStreamingResponse[],
): Stream<LettaStreamingResponse> {
  return {
    controller: new AbortController(),
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  } as unknown as Stream<LettaStreamingResponse>;
}

const okExecutor: HeadlessTurnExecutor = {
  async execute() {
    return lettaStreamFromChunks([
      {
        message_type: "assistant_message",
        content: [{ type: "text", text: "ok" }],
      } as LettaStreamingResponse,
      {
        message_type: "stop_reason",
        stop_reason: "end_turn",
      } as LettaStreamingResponse,
    ]);
  },
};

interface RecordedCommand {
  input: string;
  output: string;
  succeeded: boolean;
  failed: boolean;
}

/** A command runner stand-in that records what the flow told the user. */
function recordingRunner(commands: RecordedCommand[]): AppCommandRunner {
  const start = (input: string, output: string) => {
    const record: RecordedCommand = {
      input,
      output,
      succeeded: false,
      failed: false,
    };
    commands.push(record);
    return {
      id: `cmd-${commands.length}`,
      input,
      update: (update: { output: string }) => {
        record.output = update.output;
      },
      finish: (output: string, success = true) => {
        record.output = output;
        record.succeeded = success;
      },
      fail: (output: string) => {
        record.output = output;
        record.failed = true;
      },
    };
  };
  return { start, getHandle: () => null } as unknown as AppCommandRunner;
}

interface Harness {
  ctx: CompactCommandContext & SendPressureContext;
  commands: RecordedCommand[];
  overlays: ActiveOverlay[];
  reminderState: SharedReminderState;
  tracker: ContextTracker;
  descriptions: () => number;
}

function harness(input: {
  conversationId: string;
  agentId: string;
  contextWindow?: number;
  contextTokens?: number;
}): Harness {
  const commands: RecordedCommand[] = [];
  const overlays: ActiveOverlay[] = [];
  const state = { descriptions: 0 };
  const reminderState = createSharedReminderState();
  const tracker = createContextTracker();
  tracker.lastContextTokens = input.contextTokens ?? 0;
  const ctx: CompactCommandContext & SendPressureContext = {
    agentDescription: null,
    agentId: input.agentId,
    agentName: "Local",
    agentStateRef: { current: null },
    appendTaskNotificationEvents: () => true,
    commandRunner: recordingRunner(commands),
    contextTrackerRef: { current: tracker },
    conversationIdRef: { current: input.conversationId },
    effectiveContextWindowSize: input.contextWindow,
    generateConversationDescription: async () => {
      state.descriptions += 1;
    },
    setActiveOverlay: (value) => {
      overlays.push(typeof value === "function" ? null : value);
    },
    setCommandRunning: () => {},
    setReflectionArenaChoicePending: () => {},
    sharedReminderStateRef: { current: reminderState },
  };
  return {
    ctx,
    commands,
    overlays,
    reminderState,
    tracker,
    descriptions: () => state.descriptions,
  };
}

/** A local conversation with `turns` turns of ~100 tokens each. */
async function localConversation(
  turns: number,
  markAfter?: { afterTurn: number; title: string },
): Promise<{
  backend: LocalBackend;
  agentId: string;
  conversationId: string;
  markTopic: (title: string) => void;
}> {
  const backend = new LocalBackend({
    storageDir: await createStorageDirectory(),
    executor: okExecutor,
    complete: async () =>
      ({
        role: "assistant",
        content: [{ type: "text", text: "summary" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.5",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
        },
        stopReason: "stop",
        timestamp: Date.now(),
      }) as never,
    memfsEnabled: false,
  });
  const agent = await backend.createAgent({
    name: "Local",
    model: "openai/gpt-5.5",
    model_settings: {
      provider_type: "openai",
      context_window_limit: 2_000,
    },
  } as never);
  const conversation = await backend.createConversation({
    agent_id: agent.id,
  } as never);
  for (let turn = 0; turn < turns; turn += 1) {
    const stream = await backend.createConversationMessageStream(
      conversation.id,
      {
        agent_id: agent.id,
        messages: [
          { role: "user", content: `turn ${turn} ${"x".repeat(400)}` },
        ],
      } as ConversationMessageCreateBody,
    );
    for await (const _chunk of stream) {
      // drain
    }
    if (markAfter && turn + 1 === markAfter.afterTurn) {
      backend.markTopic({
        conversationId: conversation.id,
        agentId: agent.id,
        title: markAfter.title,
        createdBy: "agent",
      });
    }
  }
  __testSetBackend(backend);
  return {
    backend,
    agentId: agent.id,
    conversationId: conversation.id,
    markTopic(title: string) {
      backend.markTopic({
        conversationId: conversation.id,
        agentId: agent.id,
        title,
        createdBy: "agent",
      });
    },
  };
}

describe("isCompactCommand", () => {
  test("matches the command and its arguments only", () => {
    expect(isCompactCommand("/compact")).toBe(true);
    expect(isCompactCommand("  /compact 2 ")).toBe(true);
    expect(isCompactCommand("/compaction")).toBe(false);
    expect(isCompactCommand("/topics")).toBe(false);
  });
});

describe("handleCompactCommand", () => {
  test("help prints the new usage and touches no backend", async () => {
    const h = harness({ conversationId: "c", agentId: "a" });

    await handleCompactCommand("/compact help", h.ctx);

    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]?.succeeded).toBe(true);
    expect(h.commands[0]?.output).toBe(COMPACT_COMMAND_USAGE);
    expect(h.commands[0]?.output).toContain("/compact <n>");
  });

  test("an invalid argument is refused with the usage", async () => {
    const h = harness({ conversationId: "c", agentId: "a" });

    await handleCompactCommand("/compact nope", h.ctx);

    expect(h.commands[0]?.failed).toBe(true);
    expect(h.commands[0]?.output).toContain('Unknown argument "nope"');
  });

  test("a numbered pick trims, reports, and marks the context changed", async () => {
    const local = await localConversation(8);
    local.markTopic("Alpha");
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
    });
    // Pretend the one-shot execution-context reminders were already sent: a
    // compaction must re-arm them, because it evicted what they described.
    h.reminderState.hasSentAgentInfo = true;
    h.reminderState.hasSentSessionContext = true;

    await handleCompactCommand("/compact 2", h.ctx);

    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]?.failed).toBe(false);
    expect(h.commands[0]?.output).toContain("Context trimmed.");
    expect(h.commands[0]?.output).toContain(
      "cut point:  the topic block you picked",
    );
    expect(h.commands[0]?.output).toContain("topics:     Alpha");
    expect(h.commands[0]?.output).toContain("evicts the provider cache");
    // A compaction owes the reminder runtime and the description a refresh.
    expect(h.reminderState.hasSentAgentInfo).toBe(false);
    expect(h.reminderState.hasSentSessionContext).toBe(false);
    expect(h.reminderState.pendingSessionContextReason).toBe("post_compaction");
    expect(h.descriptions()).toBe(1);
    // No picker was involved.
    expect(h.overlays).toEqual([]);
    expect(takeTopicTrimRequest()).toBeNull();
  });

  test("an out-of-range block is refused by name", async () => {
    const local = await localConversation(4);
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
    });

    await handleCompactCommand("/compact 9", h.ctx);

    expect(h.commands[0]?.failed).toBe(true);
    expect(h.commands[0]?.output).toContain("There is no topic block 9");
  });

  test("picking the first block reports that nothing can be trimmed", async () => {
    const local = await localConversation(8);
    local.markTopic("Alpha");
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
    });

    await handleCompactCommand("/compact 1", h.ctx);

    expect(h.commands[0]?.succeeded).toBe(true);
    expect(h.commands[0]?.output).toContain("Nothing to trim");
    expect(h.descriptions()).toBe(0);
  });

  test("a bare /compact with markers parks a picker request instead of trimming", async () => {
    // The marker closes a topic early, so the ratio suggestion lands in the
    // second block: the cursor's default is a block the user can pick.
    const local = await localConversation(8, { afterTurn: 4, title: "Alpha" });
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
    });

    await handleCompactCommand("/compact", h.ctx);

    expect(h.commands).toEqual([]);
    expect(h.overlays).toEqual(["compaction"]);
    const request = takeTopicTrimRequest();
    expect(request).not.toBeNull();
    expect(request?.blocks.map((block) => block.title)).toEqual([
      "Alpha",
      null,
    ]);
    expect(request?.suggestionIndex).toBe(2);

    // The pick runs the trim the picker promised, and clears the overlay first.
    request?.onPick(2);
    await Bun.sleep(0);
    expect(h.overlays.at(-1)).toBeNull();
    expect(h.commands[0]?.output).toContain("Context trimmed.");
  });

  test("a bare /compact with no markers trims by ratio and says so (D-119)", async () => {
    const local = await localConversation(8);
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
    });

    await handleCompactCommand("/compact", h.ctx);

    // No picker: one ratio-driven trim, with the hint that explains why.
    expect(h.overlays).toEqual([]);
    expect(takeTopicTrimRequest()).toBeNull();
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]?.output).toContain("Context trimmed.");
    expect(h.commands[0]?.output).toContain(
      "cut point:  the retention ratio (nothing was marked)",
    );
    expect(h.commands[0]?.output).toContain(
      "retention ratio decided the cut point",
    );
  });

  test("a mode argument is refused locally", async () => {
    const local = await localConversation(4);
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
    });

    await handleCompactCommand("/compact sliding_window", h.ctx);

    expect(h.commands[0]?.failed).toBe(true);
    expect(h.commands[0]?.output).toBe(COMPACT_MODE_LOCAL_UNSUPPORTED);
  });

  test("a non-local backend keeps the cloud path and rejects block numbers", async () => {
    __testSetBackend(new FakeHeadlessBackend());
    const h = harness({ conversationId: "default", agentId: "agent-x" });

    await handleCompactCommand("/compact 3", h.ctx);
    expect(h.commands[0]?.failed).toBe(true);
    expect(h.commands[0]?.output).toContain("requires the local backend");
  });
});

describe("offerTrimBeforeSend (D-112)", () => {
  test("an uncrowded context says nothing and sends", async () => {
    const local = await localConversation(2);
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
      contextWindow: 1_000,
      contextTokens: 100,
    });
    let sent = 0;

    const deferred = await offerTrimBeforeSend(h.ctx, async () => {
      sent += 1;
    });

    expect(deferred).toBe(false);
    expect(h.commands).toEqual([]);
    await Promise.resolve();
    expect(sent).toBe(0);
  });

  test("a soft crossing prints one line and does not repeat it", async () => {
    const local = await localConversation(2);
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
      contextWindow: 1_000,
      contextTokens: 750,
    });

    expect(await offerTrimBeforeSend(h.ctx, async () => {})).toBe(false);
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]?.output).toContain("about 75%");
    expect(h.commands[0]?.output).toContain("/compact moves older topics");

    // Same tier again: no second line.
    expect(await offerTrimBeforeSend(h.ctx, async () => {})).toBe(false);
    expect(h.commands).toHaveLength(1);

    // Dropping back under the threshold re-arms the notice.
    h.tracker.lastContextTokens = 100;
    await offerTrimBeforeSend(h.ctx, async () => {});
    h.tracker.lastContextTokens = 750;
    await offerTrimBeforeSend(h.ctx, async () => {});
    expect(h.commands).toHaveLength(2);
  });

  test("a hard crossing with blocks parks the picker, then sends after the trim", async () => {
    const local = await localConversation(8, { afterTurn: 4, title: "Alpha" });
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
      contextWindow: 1_000,
      contextTokens: 900,
    });
    const sent: number[] = [];

    const deferred = await offerTrimBeforeSend(h.ctx, async () => {
      sent.push(1);
    });

    expect(deferred).toBe(true);
    expect(sent).toEqual([]);
    expect(h.overlays).toEqual(["compaction"]);
    // The hint for "pick something" is not printed: the picker is the message.
    expect(h.commands).toEqual([]);

    const request = takeTopicTrimRequest();
    expect(request?.suggestionIndex).toBe(2);
    request?.onPick(2);
    await Bun.sleep(0);
    // The trim reports itself, and the message the user typed is sent afterwards.
    expect(h.commands[0]?.output).toContain("Context trimmed.");
    expect(sent).toEqual([1]);
    expect(h.overlays.at(-1)).toBeNull();
  });

  test("skipping the picker still sends the message", async () => {
    const local = await localConversation(8, { afterTurn: 4, title: "Alpha" });
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
      contextWindow: 1_000,
      contextTokens: 900,
    });
    const sent: number[] = [];

    await offerTrimBeforeSend(h.ctx, async () => {
      sent.push(1);
    });
    takeTopicTrimRequest()?.onCancel?.();
    await Bun.sleep(0);

    expect(sent).toEqual([1]);
    // Nothing was trimmed: skip means "send as it is".
    expect(h.commands).toEqual([]);
  });

  test("a hard crossing with no markers warns instead of trimming", async () => {
    const local = await localConversation(8);
    const h = harness({
      conversationId: local.conversationId,
      agentId: local.agentId,
      contextWindow: 1_000,
      contextTokens: 900,
    });

    const deferred = await offerTrimBeforeSend(h.ctx, async () => {});

    expect(deferred).toBe(false);
    expect(h.overlays).toEqual([]);
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]?.output).toContain(
      "past the point where a turn this large can be sent",
    );
    expect(h.commands[0]?.output).toContain("/topic <title>");
  });

  test("a cloud backend is left alone", async () => {
    __testSetBackend(new FakeHeadlessBackend());
    const h = harness({
      conversationId: "default",
      agentId: "agent-x",
      contextWindow: 1_000,
      contextTokens: 900,
    });

    expect(await offerTrimBeforeSend(h.ctx, async () => {})).toBe(false);
    expect(h.commands).toEqual([]);
    expect(h.overlays).toEqual([]);
  });
});
