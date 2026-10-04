/**
 * `/topic` coverage: the receipt copy, the usage paths, and the one semantic
 * that differs from the tool — a user mark is notified about the agent-side
 * spacing but never blocked by it.
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
  formatTopicCommandReceipt,
  handleTopicCommand,
  parseTopicCommandArgs,
  TOPIC_COMMAND_LOCAL_ONLY,
  TOPIC_COMMAND_USAGE,
} from "@/cli/commands/topic";
import { settingsManager } from "@/settings-manager";

const temporaryDirectories: string[] = [];

async function createStorageDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "topic-command-"));
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

async function backendWithTurns(turns: number): Promise<{
  backend: LocalBackend;
  agentId: string;
  scope: { agentId: string; conversationId: string };
}> {
  const backend = new LocalBackend({
    storageDir: await createStorageDirectory(),
    executor: okExecutor,
    memfsEnabled: false,
  });
  const agent = await backend.createAgent({
    name: "Local",
    system: "base {CORE_MEMORY}",
  });
  for (let turn = 0; turn < turns; turn += 1) {
    const stream = await backend.createConversationMessageStream("default", {
      agent_id: agent.id,
      messages: [{ role: "user", content: `question ${turn}` }],
    } as ConversationMessageCreateBody);
    for await (const _chunk of stream) {
      // drain
    }
  }
  return {
    backend,
    agentId: agent.id,
    scope: { agentId: agent.id, conversationId: "default" },
  };
}

describe("parseTopicCommandArgs", () => {
  test("joins unquoted arguments into the title", () => {
    expect(parseTopicCommandArgs(["a", "b", "c"])).toEqual({ title: "a b c" });
    expect(parseTopicCommandArgs(["solo"])).toEqual({ title: "solo" });
  });

  test("splits a quoted title from the summary", () => {
    expect(parseTopicCommandArgs(['"T"', "s"])).toEqual({
      title: "T",
      summary: "s",
    });
    expect(parseTopicCommandArgs(['"T"'])).toEqual({ title: "T" });
    // An empty quoted title is an empty title, so validation can reject it.
    expect(parseTopicCommandArgs(['""', "s"])).toEqual({
      title: "",
      summary: "s",
    });
  });

  test("falls back to the whole line on an unbalanced quote", () => {
    expect(parseTopicCommandArgs(['"T', "s"])).toEqual({ title: '"T s' });
  });
});

describe("formatTopicCommandReceipt", () => {
  test("labels the first marker as first", () => {
    const receipt = formatTopicCommandReceipt({
      title: "Auth token refresh bug",
      markerId: "e-1",
      anchorMessageId: "ui-msg-9",
      contextMessageCount: 9,
      turnsSincePrevious: null,
      spacingTurns: 5,
    });
    expect(receipt).toContain("id:       e-1");
    expect(receipt).toContain("the newest of 9 in-context messages");
    expect(receipt).toContain("none (this is the first marker)");
    expect(receipt).not.toContain("note:");
  });

  test("notes a recent marker without refusing it", () => {
    const receipt = formatTopicCommandReceipt({
      title: "T",
      markerId: "e-2",
      anchorMessageId: "ui-msg-9",
      contextMessageCount: 9,
      turnsSincePrevious: 2,
      spacingTurns: 5,
    });
    expect(receipt).toContain("2 user turns ago");
    expect(receipt).toContain("user marks are never blocked");
  });

  test("drops the note past the spacing", () => {
    const receipt = formatTopicCommandReceipt({
      title: "T",
      markerId: "e-3",
      anchorMessageId: "ui-msg-9",
      contextMessageCount: 9,
      turnsSincePrevious: 6,
      spacingTurns: 5,
    });
    expect(receipt).toContain("6 user turns ago");
    expect(receipt).not.toContain("note:");
  });
});

describe("handleTopicCommand", () => {
  test("prints usage with no arguments or with help", async () => {
    expect(await handleTopicCommand([])).toBe(TOPIC_COMMAND_USAGE);
    expect(await handleTopicCommand(["help"])).toBe(TOPIC_COMMAND_USAGE);
  });

  test("rejects an over-long title before touching the backend", async () => {
    const { backend, agentId, scope } = await backendWithTurns(1);
    const result = await handleTopicCommand(["x".repeat(61)], scope, {
      backend,
    });
    expect(result).toContain("maximum is 60");
    expect(backend.listTopicMarkers("default", agentId)).toEqual([]);
  });

  test("reports the local-only rule on a non-local backend", async () => {
    __testSetBackend(new FakeHeadlessBackend());
    expect(await handleTopicCommand(["Anything"], { agentId: "agent-x" })).toBe(
      TOPIC_COMMAND_LOCAL_ONLY,
    );
  });

  test("treats the whole line as the title", async () => {
    const { backend, agentId, scope } = await backendWithTurns(1);
    const result = await handleTopicCommand(
      ["Auth", "token", "refresh", "bug"],
      scope,
      { backend },
    );
    expect(result).toContain("title:    Auth token refresh bug");
    expect(result).not.toContain("summary:");
    expect(backend.listTopicMarkers("default", agentId)).toMatchObject([
      { title: "Auth token refresh bug", createdBy: "user" },
    ]);
  });

  test("splits a quoted title from its summary", async () => {
    const { backend, agentId, scope } = await backendWithTurns(1);
    const result = await handleTopicCommand(
      ['"Deploy pipeline"', "How", "releases", "are", "cut"],
      scope,
      { backend },
    );
    expect(result).toContain("title:    Deploy pipeline");
    expect(result).toContain("summary:  How releases are cut");
    expect(backend.listTopicMarkers("default", agentId)).toMatchObject([
      { title: "Deploy pipeline", createdBy: "user" },
    ]);
  });

  test("never blocks a user mark the agent-side gate would refuse", async () => {
    const { backend, agentId, scope } = await backendWithTurns(1);
    const first = await handleTopicCommand(["First topic"], scope, { backend });
    expect(first).toContain("id:");

    // One user turn later the agent gate would reject outright (1 < 5); the
    // command still writes, and only reports the spacing.
    const second = await handleTopicCommand(["Second topic"], scope, {
      backend,
    });
    expect(second).toContain("id:");
    expect(second).toContain("sooner than the 5-user-turn spacing");
    expect(backend.listTopicMarkers("default", agentId)).toMatchObject([
      { title: "First topic" },
      { title: "Second topic" },
    ]);
  });

  test("quotes the configured agent-side spacing (D-115)", async () => {
    const originalHome = process.env.HOME;
    const home = await createStorageDirectory();
    process.env.HOME = home;
    await settingsManager.reset();
    await settingsManager.initialize();
    try {
      settingsManager.updateSettings({ topicMarkerRejectTurns: 20 });
      const { backend, scope } = await backendWithTurns(1);
      await handleTopicCommand(["First topic"], scope, { backend });
      const result = await handleTopicCommand(["Second topic"], scope, {
        backend,
      });

      // Still written — the user is never blocked — but the note now names the
      // threshold the agent gate is actually using.
      expect(result).toContain("id:");
      expect(result).toContain("sooner than the 20-user-turn spacing");
    } finally {
      await settingsManager.reset();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  test("refuses to anchor on an empty context", async () => {
    const backend = new LocalBackend({
      storageDir: await createStorageDirectory(),
      executor: okExecutor,
      memfsEnabled: false,
    });
    const agent = await backend.createAgent({
      name: "Local",
      system: "base {CORE_MEMORY}",
    });
    const result = await handleTopicCommand(
      ["Nothing here"],
      { agentId: agent.id, conversationId: "default" },
      { backend },
    );
    expect(result).toContain("nothing in this conversation's context");
    expect(backend.listTopicMarkers("default", agent.id)).toEqual([]);
  });

  test("keeps working while agent topic marking is switched off", async () => {
    const originalHome = process.env.HOME;
    const home = await createStorageDirectory();
    process.env.HOME = home;
    await settingsManager.reset();
    await settingsManager.initialize();
    try {
      // The switch constrains the agent-side channel only (V18): the user's own
      // marker is not a rate-limited or gated operation.
      settingsManager.updateSettings({ topicMarkingEnabled: false });
      const { backend, agentId, scope } = await backendWithTurns(1);

      const result = await handleTopicCommand(["User topic"], scope, {
        backend,
      });
      expect(result).toContain("id:");
      expect(backend.listTopicMarkers("default", agentId)).toMatchObject([
        { title: "User topic", createdBy: "user" },
      ]);
    } finally {
      await settingsManager.reset();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });
});
