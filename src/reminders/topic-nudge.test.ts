/**
 * The reminder provider that delivers the no-marker nudge (feature ③, D-114).
 *
 * The provider is the one place a turn can put text in front of the model, so
 * what matters here is that it fires exactly when the backend says so, that the
 * user-visible notice is left where the TUI can find it, and that turning off
 * agent-side marking silences it — including the reminder threshold it belongs
 * to, which must not be consumed while the switch is off.
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
import {
  buildSharedReminderParts,
  sharedReminderProviders,
} from "@/reminders/engine";
import { createSharedReminderState } from "@/reminders/state";
import { settingsManager } from "@/settings-manager";

const NUDGE_TURNS = 2;
const temporaryDirectories: string[] = [];

async function createStorageDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reminder-topic-nudge-"));
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

/** A local conversation that has already run past the nudge threshold. */
async function unmarkedConversation(): Promise<{
  backend: LocalBackend;
  agentId: string;
  conversationId: string;
}> {
  const backend = new LocalBackend({
    storageDir: await createStorageDirectory(),
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
  for (let turn = 0; turn < NUDGE_TURNS; turn += 1) {
    const stream = await backend.createConversationMessageStream(
      conversation.id,
      {
        agent_id: agent.id,
        messages: [{ role: "user", content: `turn ${turn}` }],
      } as ConversationMessageCreateBody,
    );
    for await (const _chunk of stream) {
      // drain
    }
  }
  __testSetBackend(backend);
  return { backend, agentId: agent.id, conversationId: conversation.id };
}

function reminderContext(input: {
  agentId: string;
  conversationId?: string;
  state: ReturnType<typeof createSharedReminderState>;
}) {
  return {
    mode: "interactive" as const,
    agent: {
      id: input.agentId,
      name: null,
      conversationId: input.conversationId,
    },
    state: input.state,
    systemInfoReminderEnabled: false,
    skillSources: [],
  };
}

function buildNudge(input: {
  agentId: string;
  conversationId?: string;
  state: ReturnType<typeof createSharedReminderState>;
}): Promise<string | null> {
  return sharedReminderProviders["topic-nudge"](reminderContext(input));
}

describe("the topic-nudge reminder provider", () => {
  const originalHome = process.env.HOME;
  let testHomeDir: string;

  beforeEach(async () => {
    await settingsManager.reset();
    testHomeDir = await mkdtemp(join(tmpdir(), "topic-nudge-reminder-"));
    process.env.HOME = testHomeDir;
    await settingsManager.initialize();
    settingsManager.updateSettings({ topicNudgeTurns: NUDGE_TURNS });
  });

  afterEach(async () => {
    __testSetBackend(null);
    await settingsManager.reset();
    await rm(testHomeDir, { recursive: true, force: true });
    process.env.HOME = originalHome;
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  test("injects one reminder and parks the notice for the user", async () => {
    const local = await unmarkedConversation();
    const state = createSharedReminderState();

    const text = await buildNudge({ ...local, state });

    expect(text).toContain("<system-reminder>");
    expect(text).toContain(`${NUDGE_TURNS} user turns without a topic marker`);
    expect(text).toContain("TopicMark");
    expect(state.pendingTopicNudge).toEqual({
      turnsSinceLastMarker: NUDGE_TURNS,
      nudgeTurns: NUDGE_TURNS,
    });
  });

  test("stays silent for the rest of the stretch", async () => {
    const local = await unmarkedConversation();
    const state = createSharedReminderState();
    expect(await buildNudge({ ...local, state })).not.toBeNull();

    const second = createSharedReminderState();
    expect(await buildNudge({ ...local, state: second })).toBeNull();
    expect(second.pendingTopicNudge).toBeNull();
  });

  test("the engine hands it to the turn as a reminder part", async () => {
    const local = await unmarkedConversation();
    const state = createSharedReminderState();

    const { parts, appliedReminderIds } = await buildSharedReminderParts({
      mode: "interactive",
      agent: {
        id: local.agentId,
        name: null,
        conversationId: local.conversationId,
      },
      state,
      systemInfoReminderEnabled: false,
      skillSources: [],
    });

    expect(appliedReminderIds).toContain("topic-nudge");
    expect(parts.map((part) => part.text).join("\n")).toContain(
      `${NUDGE_TURNS} user turns without a topic marker`,
    );
    expect(state.pendingTopicNudge).toEqual({
      turnsSinceLastMarker: NUDGE_TURNS,
      nudgeTurns: NUDGE_TURNS,
    });
  });

  test("follows the marking switch and leaves the stretch unconsumed", async () => {
    const local = await unmarkedConversation();
    settingsManager.updateSettings({ topicMarkingEnabled: false });

    const state = createSharedReminderState();
    expect(await buildNudge({ ...local, state })).toBeNull();
    expect(state.pendingTopicNudge).toBeNull();

    // Turning it back on must still nudge the same stretch.
    settingsManager.updateSettings({ topicMarkingEnabled: true });
    expect(await buildNudge({ ...local, state })).not.toBeNull();
  });

  test("does nothing on the cloud backend", async () => {
    __testSetBackend(new FakeHeadlessBackend());
    const state = createSharedReminderState();

    expect(
      await buildNudge({
        agentId: "agent-cloud",
        conversationId: "conv",
        state,
      }),
    ).toBeNull();
    expect(state.pendingTopicNudge).toBeNull();
  });

  test("needs a conversation to measure", async () => {
    await unmarkedConversation();
    const state = createSharedReminderState();

    expect(await buildNudge({ agentId: "agent-1", state })).toBeNull();
  });
});
