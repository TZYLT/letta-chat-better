/**
 * Backend-level coverage for listTopics / trimConversationToTopic (D-104).
 *
 * The trim is the one path that may rewrite a conversation's context on a user's
 * behalf, so the claims under test are: the picked boundary is honored, the kept
 * region is exactly what the plan chose, the trim lands as a "compaction"
 * application point (transcript row + refreshed frozen prefix), and a pick that
 * cannot be honored changes nothing at all.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { ConversationMessageCreateBody } from "@/backend";
import type {
  HeadlessTurnExecutor,
  HeadlessTurnExecutorInput,
} from "@/backend/dev/headless-turn-executor";
import { LocalBackend } from "@/backend/local/local-backend";
import { emptyLocalUsage } from "@/backend/local/local-message";
import { searchLocalTranscriptMessages } from "@/backend/local/transcript-search";
import { settingsManager } from "@/settings-manager";

const temporaryDirectories: string[] = [];

async function createStorageDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-topic-trim-backend-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.5",
    usage: emptyLocalUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/** One assistant message per user turn, so each turn is two context messages. */
function oneTurnExecutor(): HeadlessTurnExecutor {
  return {
    async execute(_input: HeadlessTurnExecutorInput) {
      const chunks: LettaStreamingResponse[] = [
        {
          message_type: "assistant_message",
          content: [{ type: "text", text: "ok" }],
        } as LettaStreamingResponse,
        {
          message_type: "stop_reason",
          stop_reason: "end_turn",
        } as LettaStreamingResponse,
      ];
      return {
        controller: new AbortController(),
        async *[Symbol.asyncIterator]() {
          for (const chunk of chunks) yield chunk;
        },
      } as never;
    },
  };
}

/**
 * ~100 tokens of user content per turn, so a 2,000-token window (600-token
 * retention cap) leaves a trim with something real to cut.
 */
function turnContent(label: string): string {
  return `${label} ${"x".repeat(400)}`;
}

interface Fixture {
  backend: LocalBackend;
  conversationId: string;
  agentId: string;
  sendTurn: (content: string) => Promise<void>;
}

async function fixture(input: {
  storageDir: string;
  contextWindow?: number;
  summarizerCalls?: { count: number };
}): Promise<Fixture> {
  const backend = new LocalBackend({
    storageDir: input.storageDir,
    executor: oneTurnExecutor(),
    complete: async () => {
      if (input.summarizerCalls) input.summarizerCalls.count += 1;
      return assistantMessage("summary of the evicted topic");
    },
    memfsEnabled: false,
  });
  const agent = await backend.createAgent({
    name: "Topics",
    model: "openai/gpt-5.5",
    model_settings: {
      provider_type: "openai",
      context_window_limit: input.contextWindow ?? 2_000,
    },
  } as never);
  const conversation = await backend.createConversation({
    agent_id: agent.id,
  } as never);
  return {
    backend,
    conversationId: conversation.id,
    agentId: agent.id,
    async sendTurn(content: string) {
      const stream = await backend.createConversationMessageStream(
        conversation.id,
        {
          agent_id: agent.id,
          messages: [{ role: "user", content: turnContent(content) }],
        } as ConversationMessageCreateBody,
      );
      for await (const _chunk of stream) {
        // drain
      }
    },
  };
}

async function inContext(backend: LocalBackend, fixtureInput: Fixture) {
  const page = await backend.listConversationMessages(
    fixtureInput.conversationId,
    { agent_id: fixtureInput.agentId, order: "asc" },
  );
  return page.getPaginatedItems() as unknown as { id: string; role: string }[];
}

/**
 * The public message list projects messages for display; the compaction metadata
 * that proves "this row is the trim's summary" only exists on the stored record.
 */
function storedMessages(backend: LocalBackend, input: Fixture) {
  const store = (
    backend as unknown as {
      store: {
        listLocalMessages: (
          conversationId: string,
          agentId: string,
        ) => { id: string; role: string; metadata?: unknown }[];
      };
    }
  ).store;
  return store.listLocalMessages(input.conversationId, input.agentId);
}

/** The compiled snapshot is where "the prefix was refreshed" is observable. */
function frozenReason(backend: LocalBackend, input: Fixture): unknown {
  const store = (
    backend as unknown as {
      store: {
        getCompiledSystemPrompt: (
          conversationId: string,
          agentId: string,
        ) => { frozenReason?: unknown } | undefined;
      };
    }
  ).store;
  return store.getCompiledSystemPrompt(input.conversationId, input.agentId)
    ?.frozenReason;
}

function transcriptPath(
  storageDir: string,
  conversationId: string,
  agentId: string,
): string {
  // Mirrors `LocalStore.conversationKey`: only the default conversation is
  // keyed by agent, because every other conversation id is already unique.
  const key =
    conversationId === "default"
      ? `default:${agentId}`
      : `conversation:${conversationId}`;
  return join(
    storageDir,
    "conversations",
    Buffer.from(key).toString("base64url"),
    "messages.jsonl",
  );
}

function rowsWithType(raw: string, type: string): Record<string, unknown>[] {
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row.type === type);
}

describe("LocalBackend.listTopics", () => {
  test("reports blocks cut at effective boundaries and no markers when unmarked", async () => {
    const storageDir = await createStorageDirectory();
    const f = await fixture({ storageDir });
    for (const turn of ["one", "two", "three", "four"]) await f.sendTurn(turn);

    const unmarked = f.backend.listTopics(f.conversationId, f.agentId);
    expect(unmarked.markers).toEqual([]);
    expect(unmarked.blocks).toHaveLength(1);
    expect(unmarked.blocks[0]?.title).toBeNull();
    expect(unmarked.blocks[0]?.messageCount).toBe(unmarked.contextMessageCount);
    expect(unmarked.retentionCapTokens).toBe(600);

    // A marker at the end of turn 4 rewinds two turns, so the block ends on
    // turn 3's start and the trailing "current topic" block keeps turn 3 on.
    f.backend.markTopic({
      conversationId: f.conversationId,
      agentId: f.agentId,
      title: "Alpha",
      createdBy: "agent",
    });

    const marked = f.backend.listTopics(f.conversationId, f.agentId);
    expect(marked.blocks).toHaveLength(2);
    expect(marked.blocks[0]?.title).toBe("Alpha");
    expect(marked.blocks[0]?.rewindTurns).toBe(0);
    expect(marked.blocks[1]?.title).toBeNull();
    expect(marked.blocks[1]?.rewindTurns).toBe(2);
    expect(marked.markers).toEqual([
      {
        marker: expect.objectContaining({ title: "Alpha" }),
        anchorInContext: true,
      },
    ]);
  });
});

describe("LocalBackend.trimConversationToTopic", () => {
  test("summarizes the picked region, keeps the rest, and refreezes the prefix", async () => {
    const storageDir = await createStorageDirectory();
    const summarizerCalls = { count: 0 };
    const f = await fixture({ storageDir, summarizerCalls });
    for (const turn of ["one", "two", "three", "four", "five", "six"]) {
      await f.sendTurn(turn);
    }
    f.backend.markTopic({
      conversationId: f.conversationId,
      agentId: f.agentId,
      title: "Alpha",
      createdBy: "agent",
    });
    await f.sendTurn("seven");
    await f.sendTurn("eight");

    const before = await inContext(f.backend, f);
    expect(frozenReason(f.backend, f)).toBe("conversation_created");

    // The block list is "keep from here": picking the trailing block asks for
    // exactly the topic the marker closed to be summarized away.
    const blocks = f.backend.listTopics(f.conversationId, f.agentId).blocks;
    expect(blocks.map((block) => block.title)).toEqual(["Alpha", null]);

    const outcome = await f.backend.trimConversationToTopic({
      conversationId: f.conversationId,
      agentId: f.agentId,
      pick: { kind: "topic", index: 2 },
    });

    expect(outcome.executed).toBe(true);
    expect(outcome.source).toBe("topic_pick");
    expect(outcome.summarizedTitles).toEqual(["Alpha"]);
    expect(outcome.rewindTurns).toBe(2);
    expect(summarizerCalls.count).toBe(1);

    const after = await inContext(f.backend, f);
    expect(after.length).toBeLessThan(before.length);
    // The new first message is the summary the trim wrote, and the trim audit
    // rides on it exactly as it was persisted.
    const stored = storedMessages(f.backend, f);
    expect(
      (
        stored[0]?.metadata as {
          compaction?: { stats?: { trim?: unknown } };
        }
      )?.compaction?.stats?.trim,
    ).toMatchObject({
      source: "topic_pick",
      summarized_titles: ["Alpha"],
      rewind_turns: 2,
    });
    expect(outcome.firstKeptMessageId).toBe(after[1]?.id);
    expect(frozenReason(f.backend, f)).toBe("compaction");

    // The trim row is appended to the transcript, not rewritten over it.
    const raw = await readFile(
      transcriptPath(storageDir, f.conversationId, f.agentId),
      "utf8",
    );
    expect(rowsWithType(raw, "compaction")).toHaveLength(1);
    // Markers are metadata that survives the trim.
    expect(
      f.backend.listTopicMarkers(f.conversationId, f.agentId),
    ).toHaveLength(1);
  });

  test("survives a restart with the trimmed context and its markers", async () => {
    const storageDir = await createStorageDirectory();
    const f = await fixture({ storageDir });
    for (const turn of ["one", "two", "three", "four", "five", "six"]) {
      await f.sendTurn(turn);
    }
    f.backend.markTopic({
      conversationId: f.conversationId,
      agentId: f.agentId,
      title: "Alpha",
      createdBy: "agent",
    });
    await f.sendTurn("seven");
    await f.sendTurn("eight");

    const outcome = await f.backend.trimConversationToTopic({
      conversationId: f.conversationId,
      agentId: f.agentId,
      pick: { kind: "ratio_suggestion" },
    });
    expect(outcome.executed).toBe(true);
    const after = await inContext(f.backend, f);

    const reopened = new LocalBackend({
      storageDir,
      executor: oneTurnExecutor(),
      memfsEnabled: false,
    });
    const reloaded = await inContext(reopened, f);
    expect(reloaded.map((message) => message.id)).toEqual(
      after.map((message) => message.id),
    );
    // The marker's anchor survives a ratio trim (the newest messages are kept),
    // so it stays in the current context's block structure.
    const list = reopened.listTopics(f.conversationId, f.agentId);
    expect(list.markers.map((view) => view.marker.title)).toEqual(["Alpha"]);
    expect(list.markers.map((view) => view.anchorInContext)).toEqual([true]);
    // The trim is a transcript row, so it is still there after a reload.
    const raw = await readFile(
      transcriptPath(storageDir, f.conversationId, f.agentId),
      "utf8",
    );
    expect(rowsWithType(raw, "compaction")).toHaveLength(1);
    const trimRows = rowsWithType(raw, "topic");
    expect(trimRows).toHaveLength(1);
    expect(trimRows[0]?.title).toBe("Alpha");
  });

  test("picking the first block writes nothing", async () => {
    const storageDir = await createStorageDirectory();
    const summarizerCalls = { count: 0 };
    const f = await fixture({ storageDir, summarizerCalls });
    for (const turn of ["one", "two", "three", "four"]) await f.sendTurn(turn);

    const before = await inContext(f.backend, f);

    const outcome = await f.backend.trimConversationToTopic({
      conversationId: f.conversationId,
      agentId: f.agentId,
      pick: { kind: "topic", index: 1 },
    });

    expect(outcome.executed).toBe(false);
    expect(outcome.noopReason).toBe("nothing_before_boundary");
    expect(summarizerCalls.count).toBe(0);
    expect((await inContext(f.backend, f)).map((m) => m.id)).toEqual(
      before.map((m) => m.id),
    );
    // No application point ran, so the prefix is untouched.
    expect(frozenReason(f.backend, f)).toBe("conversation_created");
    const raw = await readFile(
      transcriptPath(storageDir, f.conversationId, f.agentId),
      "utf8",
    );
    expect(rowsWithType(raw, "compaction")).toEqual([]);
  });

  test("an unmarked conversation can still be trimmed by ratio (D-119)", async () => {
    const storageDir = await createStorageDirectory();
    const f = await fixture({ storageDir });
    for (const turn of ["one", "two", "three", "four", "five", "six"]) {
      await f.sendTurn(turn);
    }

    const outcome = await f.backend.trimConversationToTopic({
      conversationId: f.conversationId,
      agentId: f.agentId,
      pick: { kind: "ratio_suggestion" },
    });

    expect(outcome.executed).toBe(true);
    expect(outcome.source).toBe("ratio_suggestion");
    expect(outcome.topicTitle).toBeNull();
    expect(outcome.summarizedTitles).toEqual([]);
    expect(outcome.retainedTokens).toBeLessThanOrEqual(
      outcome.retentionCapTokens ?? Number.POSITIVE_INFINITY,
    );
  });

  test("a context below the retention cap has nothing worth trimming", async () => {
    const storageDir = await createStorageDirectory();
    const summarizerCalls = { count: 0 };
    const f = await fixture({ storageDir, summarizerCalls });
    await f.sendTurn("one");
    await f.sendTurn("two");

    const outcome = await f.backend.trimConversationToTopic({
      conversationId: f.conversationId,
      agentId: f.agentId,
      pick: { kind: "ratio_suggestion" },
    });

    expect(outcome.executed).toBe(false);
    expect(outcome.noopReason).toBe("nothing_before_boundary");
    expect(summarizerCalls.count).toBe(0);
  });

  test("a small window caps the kept region below the picked topic", async () => {
    const storageDir = await createStorageDirectory();
    const f = await fixture({ storageDir, contextWindow: 1_000 });
    for (const turn of ["one", "two", "three", "four"]) await f.sendTurn(turn);
    f.backend.markTopic({
      conversationId: f.conversationId,
      agentId: f.agentId,
      title: "Alpha",
      createdBy: "agent",
    });
    await f.sendTurn("five");

    // Rewind 2 from turn 4 puts block 1's boundary on turn 2, so the pick asks to
    // keep turns 2-5 (~400 tokens).
    const blocks = f.backend.listTopics(f.conversationId, f.agentId).blocks;
    expect(blocks.map((block) => block.title)).toEqual(["Alpha", null]);

    const outcome = await f.backend.trimConversationToTopic({
      conversationId: f.conversationId,
      agentId: f.agentId,
      pick: { kind: "topic", index: 2 },
    });

    // A 1,000-token window at 30% keeps at most 300 tokens, less than the picked
    // topic asked for: the cap wins and the receipt says so.
    expect(outcome.executed).toBe(true);
    expect(outcome.source).toBe("ratio_cap");
    expect(outcome.ratioCapApplied).toBe(true);
    expect(outcome.retentionCapTokens).toBe(300);
    expect(outcome.retainedTokens).toBeLessThanOrEqual(300);
    expect(outcome.requestedRetentionTokens).toBeGreaterThan(300);
  });
});

/**
 * G8: a trim is one-way by design. The evicted messages leave the context, stay
 * on disk, and `/search` still finds them; nothing puts them back. The name
 * scan at the end is a speed bump, not the guarantee — the guarantee is that no
 * such code path exists — but it fails loudly if someone adds one.
 */
describe("context trimming is one-way (G8)", () => {
  test("evicted messages leave the context but stay searchable", async () => {
    const storageDir = await createStorageDirectory();
    const f = await fixture({ storageDir });
    for (const turn of ["alpha", "bravo", "charlie", "delta", "echo"]) {
      await f.sendTurn(turn);
    }
    f.backend.markTopic({
      conversationId: f.conversationId,
      agentId: f.agentId,
      title: "Alpha",
      createdBy: "agent",
    });
    await f.sendTurn("foxtrot");
    await f.sendTurn("golf");

    const before = await inContext(f.backend, f);
    const evictedId = before[0]?.id ?? "";
    const outcome = await f.backend.trimConversationToTopic({
      conversationId: f.conversationId,
      agentId: f.agentId,
      pick: { kind: "topic", index: 2 },
    });
    expect(outcome.executed).toBe(true);
    const after = await inContext(f.backend, f);

    expect(evictedId).not.toBe("");
    expect(after.map((message) => message.id)).not.toContain(evictedId);

    // The transcript keeps it, so /search still finds the original text.
    const hits = searchLocalTranscriptMessages(storageDir, {
      query: "alpha",
      agent_id: f.agentId,
      conversation_id: f.conversationId,
      limit: 10,
    });
    expect(hits.map((hit) => hit.message_id)).toContain(evictedId);

    // No restore surface on the backend.
    expect(
      Object.getOwnPropertyNames(LocalBackend.prototype).filter((name) =>
        /restore|undo|untrim|revert/i.test(name),
      ),
    ).toEqual([]);
  });
});

/**
 * D-115: the rewind is a setting, and the backend is where its default is
 * resolved — otherwise every channel would have to pass the same number.
 */
describe("the boundary rewind follows topicBoundaryRewindTurns (D-115)", () => {
  const originalHome = process.env.HOME;
  let testHomeDir: string;

  beforeEach(async () => {
    await settingsManager.reset();
    testHomeDir = await mkdtemp(join(tmpdir(), "topic-rewind-settings-"));
    process.env.HOME = testHomeDir;
    await settingsManager.initialize();
  });

  afterEach(async () => {
    await settingsManager.reset();
    await rm(testHomeDir, { recursive: true, force: true });
    process.env.HOME = originalHome;
  });

  /** Six turns with a marker at the end of the sixth, so a rewind can move. */
  async function markedConversation(): Promise<Fixture> {
    const f = await fixture({ storageDir: await createStorageDirectory() });
    for (const turn of ["one", "two", "three", "four", "five", "six"]) {
      await f.sendTurn(turn);
    }
    f.backend.markTopic({
      conversationId: f.conversationId,
      agentId: f.agentId,
      title: "Alpha",
      createdBy: "agent",
    });
    return f;
  }

  test("the effective boundary moves with the configured rewind", async () => {
    const f = await markedConversation();

    const byDefault = f.backend.listTopics(f.conversationId, f.agentId);
    expect(byDefault.blocks[1]?.rewindTurns).toBe(2);

    settingsManager.updateSettings({ topicBoundaryRewindTurns: 0 });
    const noRewind = f.backend.listTopics(f.conversationId, f.agentId);
    expect(noRewind.blocks[1]?.rewindTurns).toBe(0);
    expect(noRewind.blocks[1]?.startIndex ?? -1).toBeGreaterThan(
      byDefault.blocks[1]?.startIndex ?? -1,
    );
    expect(noRewind.blocks[1]?.messageCount ?? 0).toBeLessThan(
      byDefault.blocks[1]?.messageCount ?? 0,
    );

    settingsManager.updateSettings({ topicBoundaryRewindTurns: 3 });
    const rewound = f.backend.listTopics(f.conversationId, f.agentId);
    expect(rewound.blocks[1]?.rewindTurns).toBe(3);
    expect(rewound.blocks[1]?.startIndex ?? -1).toBeLessThan(
      byDefault.blocks[1]?.startIndex ?? -1,
    );
  });

  test("a trim keeps fewer messages when the rewind is off", async () => {
    const trimmed = async (rewindTurns: number) => {
      settingsManager.updateSettings({ topicBoundaryRewindTurns: rewindTurns });
      const f = await markedConversation();
      const outcome = await f.backend.trimConversationToTopic({
        conversationId: f.conversationId,
        agentId: f.agentId,
        pick: { kind: "topic", index: 2 },
      });
      expect(outcome.executed).toBe(true);
      expect(outcome.rewindTurns).toBe(rewindTurns);
      return outcome;
    };

    const tight = await trimmed(0);
    const loose = await trimmed(2);

    expect(tight.numMessagesBefore).toBe(loose.numMessagesBefore);
    expect(loose.numMessagesAfter).toBeGreaterThan(tight.numMessagesAfter);
  });
});

/**
 * M-4: a trim ends the unmarked stretch. The default threshold is 50 turns, so
 * the knob is driven through settings — the same wiring a user has — and the
 * kept region is deliberately left longer than the threshold.
 */
describe("a trim ends the nudge stretch (M-4)", () => {
  const originalHome = process.env.HOME;
  let testHomeDir: string;

  beforeEach(async () => {
    await settingsManager.reset();
    testHomeDir = await mkdtemp(join(tmpdir(), "topic-nudge-trim-settings-"));
    process.env.HOME = testHomeDir;
    await settingsManager.initialize();
    settingsManager.updateSettings({ topicNudgeTurns: 3 });
  });

  afterEach(async () => {
    await settingsManager.reset();
    await rm(testHomeDir, { recursive: true, force: true });
    process.env.HOME = originalHome;
  });

  test("the next nudge is due even though the kept region is still long", async () => {
    const f = await fixture({ storageDir: await createStorageDirectory() });
    for (const turn of ["one", "two", "three"]) await f.sendTurn(turn);
    f.backend.markTopic({
      conversationId: f.conversationId,
      agentId: f.agentId,
      title: "Alpha",
      createdBy: "agent",
    });
    for (const turn of ["four", "five", "six"]) await f.sendTurn(turn);

    // Three user turns past the marker, so the one-shot reminder has gone out.
    expect(
      f.backend.consumeTopicNudge(f.conversationId, f.agentId),
    ).toMatchObject({ due: true, reason: "due" });

    const outcome = await f.backend.trimConversationToTopic({
      conversationId: f.conversationId,
      agentId: f.agentId,
      pick: { kind: "topic", index: 2 },
      rewindTurns: 0,
    });
    expect(outcome.executed).toBe(true);

    // The kept region still holds the marker's anchor and the three later user
    // turns, so only the trim itself can have ended the stretch: without an
    // explicit reset this stays `already_sent` for the rest of the conversation.
    expect(
      f.backend.consumeTopicNudge(f.conversationId, f.agentId),
    ).toMatchObject({ due: true, reason: "due", turnsSinceLastMarker: 3 });
  });
});
