/**
 * `TopicMark` coverage: argument validation, the receipt copy, and — the part
 * that matters — that a refused marker writes nothing at all.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import { settingsManager } from "@/settings-manager";
import {
  formatTopicMarkReceipt,
  TOPIC_MARK_REMOTE_UNSUPPORTED,
  TOPIC_MARK_SUMMARY_MAX_LENGTH,
  TOPIC_MARK_TITLE_MAX_LENGTH,
  topic_mark,
  validateTopicMarkArgs,
} from "@/tools/impl/topic-mark";

const temporaryDirectories: string[] = [];

async function createStorageDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "topic-mark-tool-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  __testSetBackend(null);
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function lettaStreamFromChunks(
  chunks: LettaStreamingResponse[],
): Stream<LettaStreamingResponse> {
  const controller = new AbortController();
  return {
    controller,
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

async function newLocalBackend(): Promise<LocalBackend> {
  return new LocalBackend({
    storageDir: await createStorageDirectory(),
    executor: okExecutor,
    memfsEnabled: false,
  });
}

/** Sends one user turn so the conversation has something to anchor to. */
async function sendTurn(
  backend: LocalBackend,
  agentId: string,
  content: string,
): Promise<void> {
  const stream = await backend.createConversationMessageStream("default", {
    agent_id: agentId,
    messages: [{ role: "user", content }],
  } as ConversationMessageCreateBody);
  for await (const _chunk of stream) {
    // drain
  }
}

/**
 * A conversation with `turns` user turns already in context.
 *
 * The gate measures from the previous marker's anchor, or from the start of the
 * context when there is none — so a conversation needs enough turns of its own
 * before its first marker is allowed.
 */
async function backendWithTurns(turns: number): Promise<{
  backend: LocalBackend;
  agentId: string;
}> {
  const backend = await newLocalBackend();
  const agent = await backend.createAgent({
    name: "Local",
    system: "base {CORE_MEMORY}",
  });
  for (let turn = 0; turn < turns; turn += 1) {
    await sendTurn(backend, agent.id, `question ${turn}`);
  }
  return { backend, agentId: agent.id };
}

/** Enough turns that the frequency gate stops rejecting a first marker. */
const TURNS_PAST_REJECT_THRESHOLD = 5;

describe("validateTopicMarkArgs", () => {
  test("requires a non-empty title", () => {
    for (const title of [undefined, "", "   ", "\n\t ", 42, null]) {
      expect(validateTopicMarkArgs({ title }).ok).toBe(false);
    }
    expect(validateTopicMarkArgs({ title: "  Auth tokens  " })).toEqual({
      ok: true,
      title: "Auth tokens",
    });
  });

  test("rejects an over-long title at the boundary", () => {
    const max = "x".repeat(TOPIC_MARK_TITLE_MAX_LENGTH);
    expect(validateTopicMarkArgs({ title: max }).ok).toBe(true);
    expect(validateTopicMarkArgs({ title: `${max}x` }).ok).toBe(false);
  });

  test("collapses a summary and rejects an over-long one", () => {
    expect(
      validateTopicMarkArgs({ title: "T", summary: "  two\n\nlines  " }),
    ).toEqual({ ok: true, title: "T", summary: "two lines" });
    // An all-whitespace summary is "no summary", not an empty string.
    expect(validateTopicMarkArgs({ title: "T", summary: "   " })).toEqual({
      ok: true,
      title: "T",
    });
    const max = "y".repeat(TOPIC_MARK_SUMMARY_MAX_LENGTH);
    expect(validateTopicMarkArgs({ title: "T", summary: max }).ok).toBe(true);
    expect(validateTopicMarkArgs({ title: "T", summary: `${max}y` }).ok).toBe(
      false,
    );
  });

  test("rejects a non-string summary", () => {
    expect(validateTopicMarkArgs({ title: "T", summary: 7 }).ok).toBe(false);
  });
});

describe("formatTopicMarkReceipt", () => {
  test("records without complaint when accepted", () => {
    const receipt = formatTopicMarkReceipt({
      verdict: { status: "accepted", turnsUntilAllowed: 0 },
      title: "Deployment pipeline",
      contextMessageCount: 12,
    });
    expect(receipt).toContain('"Deployment pipeline"');
    expect(receipt).toContain("newest of 12 in-context messages");
    expect(receipt).not.toContain("rejected");
  });

  test("warns but still records", () => {
    const receipt = formatTopicMarkReceipt({
      verdict: { status: "warned", turnsUntilAllowed: 4 },
      title: "Deployment pipeline",
      contextMessageCount: 12,
    });
    expect(receipt).toContain("recorded");
    expect(receipt).toContain("sooner after the previous marker");
  });

  test("states the wait and that nothing was written when rejected", () => {
    const plural = formatTopicMarkReceipt({
      verdict: { status: "rejected", turnsUntilAllowed: 3 },
      title: "Too soon",
      contextMessageCount: 5,
    });
    expect(plural).toContain("Wait 3 more user turns");
    expect(plural).toContain("Nothing was written");
    const singular = formatTopicMarkReceipt({
      verdict: { status: "rejected", turnsUntilAllowed: 1 },
      title: "Too soon",
      contextMessageCount: 5,
    });
    expect(singular).toContain("Wait 1 more user turn ");
  });
});

describe("topic_mark", () => {
  test("refuses to run on a non-local backend", async () => {
    __testSetBackend(new FakeHeadlessBackend());
    expect(await topic_mark({ title: "Anything" })).toEqual({
      content: TOPIC_MARK_REMOTE_UNSUPPORTED,
      status: "error",
    });
  });

  test("does not reach the backend when the arguments are invalid", async () => {
    const { backend, agentId } = await backendWithTurns(1);
    const result = await topic_mark(
      { title: "   " },
      { backend, agentId, conversationId: "default" },
    );
    expect(result.status).toBe("error");
    expect(backend.listTopicMarkers("default", agentId)).toEqual([]);
  });

  test("records a marker once the gate opens", async () => {
    const { backend, agentId } = await backendWithTurns(
      TURNS_PAST_REJECT_THRESHOLD,
    );
    const result = await topic_mark(
      { title: "Deployment pipeline", summary: "How releases are cut" },
      { backend, agentId, conversationId: "default" },
    );
    expect(result.status).toBe("success");
    expect(result.content).toContain('"Deployment pipeline"');
    expect(backend.listTopicMarkers("default", agentId)).toMatchObject([
      { title: "Deployment pipeline", createdBy: "agent" },
    ]);
  });

  test("refuses a mark that is too soon and writes nothing", async () => {
    const { backend, agentId } = await backendWithTurns(1);
    const result = await topic_mark(
      { title: "Too soon" },
      { backend, agentId, conversationId: "default" },
    );
    expect(result.status).toBe("error");
    expect(result.content).toContain("rejected");
    expect(backend.listTopicMarkers("default", agentId)).toEqual([]);
  });

  test("refuses a second marker in the same turn and writes nothing", async () => {
    const { backend, agentId } = await backendWithTurns(
      TURNS_PAST_REJECT_THRESHOLD,
    );
    const deps = { backend, agentId, conversationId: "default" };
    const first = await topic_mark({ title: "First topic" }, deps);
    expect(first.status).toBe("success");

    // Nothing advanced the context in between, so the gate sees zero user
    // turns since the previous marker: this is the "one marker per turn" rule.
    const second = await topic_mark({ title: "Second topic" }, deps);
    expect(second.status).toBe("error");
    expect(second.content).toContain("rejected");
    expect(backend.listTopicMarkers("default", agentId)).toMatchObject([
      { title: "First topic" },
    ]);
  });

  test("refuses to anchor on an empty context", async () => {
    const backend = await newLocalBackend();
    const agent = await backend.createAgent({
      name: "Local",
      system: "base {CORE_MEMORY}",
    });
    const result = await topic_mark(
      { title: "Nothing here" },
      { backend, agentId: agent.id, conversationId: "default" },
    );
    expect(result.status).toBe("error");
    expect(result.content).toContain("nothing in the context");
    expect(backend.listTopicMarkers("default", agent.id)).toEqual([]);
  });
});

/**
 * D-115: the gate's thresholds are settings, not constants. Five turns is the
 * default reject boundary, so it is exactly where a configured threshold has to
 * be observable.
 */
describe("topic_mark gate thresholds from settings", () => {
  const originalHome = process.env.HOME;
  let testHomeDir: string;

  beforeEach(async () => {
    await settingsManager.reset();
    testHomeDir = await mkdtemp(join(tmpdir(), "topic-mark-settings-"));
    process.env.HOME = testHomeDir;
    await settingsManager.initialize();
  });

  afterEach(async () => {
    await settingsManager.reset();
    await rm(testHomeDir, { recursive: true, force: true });
    process.env.HOME = originalHome;
  });

  test("a raised reject threshold refuses a mark the defaults would warn about", async () => {
    settingsManager.updateSettings({
      topicMarkerRejectTurns: 20,
      topicMarkerWarnTurns: 30,
    });
    const { backend, agentId } = await backendWithTurns(
      TURNS_PAST_REJECT_THRESHOLD,
    );

    const result = await topic_mark(
      { title: "Too soon for this config" },
      { backend, agentId, conversationId: "default" },
    );

    expect(result.status).toBe("error");
    expect(result.content).toContain("Wait 15 more user turns");
    expect(backend.listTopicMarkers("default", agentId)).toEqual([]);
  });

  test("0 turns the reject threshold off", async () => {
    settingsManager.updateSettings({
      topicMarkerRejectTurns: 0,
      topicMarkerWarnTurns: 0,
    });
    // One turn: the defaults would refuse this outright.
    const { backend, agentId } = await backendWithTurns(1);

    const result = await topic_mark(
      { title: "Immediate" },
      { backend, agentId, conversationId: "default" },
    );

    expect(result.status).toBe("success");
    expect(result.content).not.toContain("sooner after the previous marker");
    expect(backend.listTopicMarkers("default", agentId)).toMatchObject([
      { title: "Immediate" },
    ]);
  });
});
