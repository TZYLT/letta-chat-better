/**
 * The one-shot no-marker nudge (feature ③, D-114) against a real store.
 *
 * The port-level tests pin the decision; these pin the two things only a store
 * can show: the flag really lands in `conversation.json` (so a restart cannot
 * re-nudge) and only a new marker — not the passage of time — re-arms it. The
 * threshold is driven through settings, which is also the wiring check.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { ConversationMessageCreateBody } from "@/backend";
import type { HeadlessTurnExecutor } from "@/backend/dev/headless-turn-executor";
import { LocalBackend } from "@/backend/local/local-backend";
import { settingsManager } from "@/settings-manager";

const temporaryDirectories: string[] = [];

async function createStorageDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-topic-nudge-"));
  temporaryDirectories.push(directory);
  return directory;
}

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

/** Three user turns keeps these tests small; the threshold is a setting. */
const NUDGE_TURNS = 3;

interface Fixture {
  backend: LocalBackend;
  conversationId: string;
  agentId: string;
  sendTurn: (content: string) => Promise<void>;
  markTopic: (title: string) => void;
  consume: () => ReturnType<LocalBackend["consumeTopicNudge"]>;
}

async function fixture(storageDir: string): Promise<Fixture> {
  const backend = new LocalBackend({
    storageDir,
    executor: okExecutor,
    memfsEnabled: false,
  });
  const agent = await backend.createAgent({
    name: "Nudge",
    model: "openai/gpt-5.5",
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
          messages: [{ role: "user", content }],
        } as ConversationMessageCreateBody,
      );
      for await (const _chunk of stream) {
        // drain
      }
    },
    markTopic(title: string) {
      backend.markTopic({
        conversationId: conversation.id,
        agentId: agent.id,
        title,
        createdBy: "agent",
      });
    },
    consume: () => backend.consumeTopicNudge(conversation.id, agent.id),
  };
}

function conversationRecordPath(
  storageDir: string,
  conversationId: string,
): string {
  return join(
    storageDir,
    "conversations",
    Buffer.from(`conversation:${conversationId}`).toString("base64url"),
    "conversation.json",
  );
}

describe("LocalBackend.consumeTopicNudge", () => {
  const originalHome = process.env.HOME;
  let testHomeDir: string;

  beforeEach(async () => {
    await settingsManager.reset();
    testHomeDir = await mkdtemp(join(tmpdir(), "topic-nudge-settings-"));
    process.env.HOME = testHomeDir;
    await settingsManager.initialize();
    settingsManager.updateSettings({ topicNudgeTurns: NUDGE_TURNS });
  });

  afterEach(async () => {
    await settingsManager.reset();
    await rm(testHomeDir, { recursive: true, force: true });
    process.env.HOME = originalHome;
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  test("nudges once at the threshold and not again for the same stretch", async () => {
    const storageDir = await createStorageDirectory();
    const f = await fixture(storageDir);
    for (const turn of ["one", "two"]) await f.sendTurn(turn);

    // Below the threshold: nothing, and nothing recorded.
    expect(f.consume()).toMatchObject({
      due: false,
      reason: "below_threshold",
      turnsSinceLastMarker: 2,
      nudgeTurns: NUDGE_TURNS,
    });

    await f.sendTurn("three");
    expect(f.consume()).toMatchObject({ due: true, reason: "due" });
    expect(f.consume()).toMatchObject({ due: false, reason: "already_sent" });

    const durable = JSON.parse(
      await readFile(
        conversationRecordPath(storageDir, f.conversationId),
        "utf8",
      ),
    );
    expect(durable.context_management).toEqual({ nudge_sent_for_streak: true });
  });

  test("a restart does not nudge the same stretch again", async () => {
    const storageDir = await createStorageDirectory();
    const f = await fixture(storageDir);
    for (const turn of ["one", "two", "three"]) await f.sendTurn(turn);
    expect(f.consume().due).toBe(true);

    const reopened = new LocalBackend({
      storageDir,
      executor: okExecutor,
      memfsEnabled: false,
    });
    expect(
      reopened.consumeTopicNudge(f.conversationId, f.agentId),
    ).toMatchObject({ due: false, reason: "already_sent" });
  });

  test("a new marker re-arms the nudge for the next stretch", async () => {
    const storageDir = await createStorageDirectory();
    const f = await fixture(storageDir);
    for (const turn of ["one", "two", "three"]) await f.sendTurn(turn);
    expect(f.consume().due).toBe(true);

    // The marker starts a new stretch, which clears the flag it inherited.
    f.markTopic("Alpha");
    expect(f.consume()).toMatchObject({
      due: false,
      reason: "below_threshold",
      turnsSinceLastMarker: 0,
    });

    for (const turn of ["four", "five", "six"]) await f.sendTurn(turn);
    expect(f.consume()).toMatchObject({ due: true, reason: "due" });
  });

  test("topicNudgeTurns = 0 disables the nudge entirely", async () => {
    settingsManager.updateSettings({ topicNudgeTurns: 0 });
    const storageDir = await createStorageDirectory();
    const f = await fixture(storageDir);
    for (const turn of ["one", "two", "three", "four"]) await f.sendTurn(turn);

    expect(f.consume()).toMatchObject({
      due: false,
      reason: "disabled",
      nudgeTurns: 0,
    });
    const durable = JSON.parse(
      await readFile(
        conversationRecordPath(storageDir, f.conversationId),
        "utf8",
      ),
    );
    expect(durable.context_management).toBeUndefined();
  });
});
