/**
 * Backend-level coverage for topic markers.
 *
 * `markTopic` is the write seam shared by the `TopicMark` tool and `/topic`. Its
 * correctness claim is negative: appending a marker must not change a single
 * byte of the next request's `client_tools` or system prompt (V4), because those
 * live in the frozen prefix and a marker that perturbed them would invalidate
 * the provider cache.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { ConversationMessageCreateBody } from "@/backend";
import type { HeadlessTurnExecutor } from "@/backend/dev/headless-turn-executor";
import { LocalBackend } from "@/backend/local/local-backend";

const temporaryDirectories: string[] = [];

async function createStorageDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-backend-topics-"));
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

interface RecordedPrefix {
  systemPrompt: string;
  clientTools: string;
}

/** Records the exact prefix each turn ran on. */
function recordingExecutor(sink: RecordedPrefix[]): HeadlessTurnExecutor {
  return {
    async execute(input) {
      sink.push({
        systemPrompt: input.systemPrompt ?? "",
        clientTools: JSON.stringify(input.clientTools ?? null),
      });
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
}

async function inContextMessages(
  backend: LocalBackend,
  agentId: string,
): Promise<unknown[]> {
  const page = await backend.listConversationMessages("default", {
    agent_id: agentId,
    order: "asc",
  });
  return page.getPaginatedItems();
}

async function createAgent(backend: LocalBackend) {
  return await backend.createAgent({
    name: "Local",
    system: "base {CORE_MEMORY}",
    model: "openai/gpt-5.6-sol",
  });
}

async function sendTurn(
  backend: LocalBackend,
  conversationId: string,
  agentId: string,
  content: string,
  clientTools: unknown[],
): Promise<void> {
  const stream = await backend.createConversationMessageStream(conversationId, {
    agent_id: agentId,
    messages: [{ role: "user", content }],
    client_tools: clientTools,
  } as unknown as ConversationMessageCreateBody);
  for await (const _chunk of stream) {
    // drain
  }
}

/** A stand-in for the turn's real tool payload; the backend treats it as bytes. */
const TOOL_DECLARATIONS = [{ name: "Read" }, { name: "TopicMark" }];

function transcriptPath(storageDir: string, agentId: string): string {
  const key = Buffer.from(`default:${agentId}`).toString("base64url");
  return join(storageDir, "conversations", key, "messages.jsonl");
}

async function topicRows(
  storageDir: string,
  agentId: string,
): Promise<Record<string, unknown>[]> {
  const text = await readFile(transcriptPath(storageDir, agentId), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row.type === "topic");
}

describe("LocalBackend.markTopic", () => {
  test("writes a marker without changing the next request's prefix", async () => {
    const storageDir = await createStorageDirectory();
    const prefix: RecordedPrefix[] = [];
    const backend = new LocalBackend({
      storageDir,
      executor: recordingExecutor(prefix),
      memfsEnabled: false,
    });
    const agent = await createAgent(backend);

    await sendTurn(
      backend,
      "default",
      agent.id,
      "first question",
      TOOL_DECLARATIONS,
    );
    const inContextBefore = await inContextMessages(backend, agent.id);

    const result = backend.markTopic({
      conversationId: "default",
      agentId: agent.id,
      title: "Deployment pipeline",
      summary: "How releases are cut",
      createdBy: "agent",
    });
    expect(result.marker.title).toBe("Deployment pipeline");
    expect(result.contextMessageCount).toBeGreaterThan(0);
    expect(result.marker.anchorMessageId).not.toBeNull();

    // The marker is metadata: it never becomes conversation content.
    expect(await inContextMessages(backend, agent.id)).toEqual(inContextBefore);

    await sendTurn(
      backend,
      "default",
      agent.id,
      "second question",
      TOOL_DECLARATIONS,
    );

    // V4: the marker must not perturb the frozen prefix in any way.
    expect(prefix).toHaveLength(2);
    // Guard against a vacuous comparison: both turns must carry the real
    // declaration set, marker tool included.
    expect(JSON.parse(prefix[0]?.clientTools ?? "null")).toEqual(
      TOOL_DECLARATIONS,
    );
    expect(prefix[1]?.clientTools).toBe(prefix[0]?.clientTools);
    expect(prefix[1]?.systemPrompt).toBe(prefix[0]?.systemPrompt);

    expect(await topicRows(storageDir, agent.id)).toMatchObject([
      { title: "Deployment pipeline", summary: "How releases are cut" },
    ]);
  });

  test("reads markers back, including after a backend restart", async () => {
    const storageDir = await createStorageDirectory();
    const backend = new LocalBackend({
      storageDir,
      executor: recordingExecutor([]),
      memfsEnabled: false,
    });
    const agent = await createAgent(backend);
    await sendTurn(
      backend,
      "default",
      agent.id,
      "first question",
      TOOL_DECLARATIONS,
    );
    const first = backend.markTopic({
      conversationId: "default",
      agentId: agent.id,
      title: "First topic",
      createdBy: "agent",
    });

    await sendTurn(
      backend,
      "default",
      agent.id,
      "second question",
      TOOL_DECLARATIONS,
    );
    const second = backend.markTopic({
      conversationId: "default",
      agentId: agent.id,
      title: "Second topic",
      createdBy: "user",
    });

    expect(backend.listTopicMarkers("default", agent.id)).toEqual([
      first.marker,
      second.marker,
    ]);

    const reopened = new LocalBackend({
      storageDir,
      executor: recordingExecutor([]),
      memfsEnabled: false,
    });
    expect(reopened.listTopicMarkers("default", agent.id)).toEqual([
      first.marker,
      second.marker,
    ]);
  });

  test("resolves the owning agent when no agent id is given", async () => {
    const storageDir = await createStorageDirectory();
    const backend = new LocalBackend({
      storageDir,
      executor: recordingExecutor([]),
      memfsEnabled: false,
    });
    const agent = await createAgent(backend);
    await sendTurn(
      backend,
      "default",
      agent.id,
      "first question",
      TOOL_DECLARATIONS,
    );

    const result = backend.markTopic({
      conversationId: "default",
      title: "No explicit agent",
      createdBy: "user",
    });
    expect(backend.listTopicMarkers("default")).toEqual([result.marker]);
  });

  test("reports an empty context instead of anchoring to nothing", async () => {
    const storageDir = await createStorageDirectory();
    const backend = new LocalBackend({
      storageDir,
      executor: recordingExecutor([]),
      memfsEnabled: false,
    });
    const agent = await createAgent(backend);

    const result = backend.markTopic({
      conversationId: "default",
      agentId: agent.id,
      title: "Nothing to anchor",
      createdBy: "user",
    });
    // Callers must refuse the mark: there is no in-context message to point at.
    expect(result.contextMessageCount).toBe(0);
    expect(result.marker.anchorMessageId).toBeNull();
  });
});
