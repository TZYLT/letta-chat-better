/**
 * Store-level coverage for topic markers: how they are appended, read back, and
 * kept out of the context they annotate.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { ConversationMessageCreateBody } from "@/backend";
import { LocalStore } from "@/backend/local/local-store";

const temporaryDirectories: string[] = [];
const agentId = "agent-topic-markers";

async function createStorageDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-topic-markers-"));
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

function freshStore(storageDir: string): LocalStore {
  return new LocalStore(agentId, { storageDir });
}

function transcriptPath(storageDir: string): string {
  const key = Buffer.from(`default:${agentId}`).toString("base64url");
  return join(storageDir, "conversations", key, "messages.jsonl");
}

function conversationRecordPath(storageDir: string): string {
  const key = Buffer.from(`default:${agentId}`).toString("base64url");
  return join(storageDir, "conversations", key, "conversation.json");
}

/** One user turn plus its assistant reply. */
function appendTurn(store: LocalStore, text: string): void {
  store.appendTurnInput("default", {
    agent_id: agentId,
    messages: [{ role: "user", content: text }],
  } as ConversationMessageCreateBody);
  store.appendStreamChunk("default", agentId, {
    message_type: "assistant_message",
    content: [{ type: "text", text: `reply: ${text}` }],
  } as LettaStreamingResponse);
}

async function transcriptRows(
  storageDir: string,
): Promise<Record<string, unknown>[]> {
  return (await readFile(transcriptPath(storageDir), "utf8"))
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("appendTopicMarker", () => {
  test("appends a topic row without touching the context", async () => {
    const storageDir = await createStorageDirectory();
    const store = freshStore(storageDir);
    appendTurn(store, "first");
    const before = store.listLocalMessages("default", agentId);
    const beforeIds = JSON.parse(
      await readFile(conversationRecordPath(storageDir), "utf8"),
    ).in_context_message_ids as string[];

    const result = store.contextRewrites.appendTopicMarker({
      conversationId: "default",
      agentId,
      title: "first topic",
      summary: "what happened",
      createdBy: "agent",
    });

    expect(result.marker.anchorMessageId).toBe(before.at(-1)?.id ?? null);
    expect(result.marker.title).toBe("first topic");
    expect(result.contextMessageCount).toBe(before.length);
    expect(result.turnsSincePrevious).toBe(1);

    // The marker must not become conversation content.
    expect(store.listLocalMessages("default", agentId)).toEqual(before);
    const afterRecord = JSON.parse(
      await readFile(conversationRecordPath(storageDir), "utf8"),
    );
    expect(afterRecord.in_context_message_ids).toEqual(beforeIds);

    const rows = await transcriptRows(storageDir);
    expect(rows.at(-1)).toMatchObject({
      type: "topic",
      title: "first topic",
      summary: "what happened",
      createdBy: "agent",
      anchorMessageId: before.at(-1)?.id,
      turnsSincePrevious: 1,
    });
    expect(store.contextRewrites.readTopicMarkers("default", agentId)).toEqual([
      result.marker,
    ]);
  });

  test("the next message chains its parentId from the topic row", async () => {
    const storageDir = await createStorageDirectory();
    const store = freshStore(storageDir);
    appendTurn(store, "first");
    const marker = store.contextRewrites.appendTopicMarker({
      conversationId: "default",
      agentId,
      title: "first topic",
      createdBy: "user",
    });

    appendTurn(store, "second");

    const rows = await transcriptRows(storageDir);
    const lastMessageRow = rows.at(-1);
    expect(lastMessageRow?.type).toBe("message");
    expect(lastMessageRow?.parentId).toBe(marker.entryId);
  });

  test("counts user turns since the previous marker", async () => {
    const storageDir = await createStorageDirectory();
    const store = freshStore(storageDir);
    appendTurn(store, "a");
    appendTurn(store, "b");
    const first = store.contextRewrites.appendTopicMarker({
      conversationId: "default",
      agentId,
      title: "first",
      createdBy: "agent",
    });
    appendTurn(store, "c");
    appendTurn(store, "d");
    appendTurn(store, "e");
    const second = store.contextRewrites.appendTopicMarker({
      conversationId: "default",
      agentId,
      title: "second",
      createdBy: "agent",
    });

    expect(first.turnsSincePrevious).toBe(2);
    expect(second.turnsSincePrevious).toBe(3);
    expect(
      store.contextRewrites
        .readTopicMarkers("default", agentId)
        .map((m) => m.title),
    ).toEqual(["first", "second"]);
  });

  test("records a missing anchor for an empty context", async () => {
    const storageDir = await createStorageDirectory();
    const store = freshStore(storageDir);
    const result = store.contextRewrites.appendTopicMarker({
      conversationId: "default",
      agentId,
      title: "nothing yet",
      createdBy: "user",
    });

    expect(result.marker.anchorMessageId).toBeNull();
    expect(result.contextMessageCount).toBe(0);
    expect(
      store.contextRewrites.readTopicMarkers("default", agentId),
    ).toHaveLength(1);
  });

  test("fails loudly without a storage directory", () => {
    const store = new LocalStore(agentId);
    expect(() =>
      store.contextRewrites.appendTopicMarker({
        conversationId: "default",
        agentId,
        title: "nowhere to write",
        createdBy: "user",
      }),
    ).toThrow(/storage directory/);
  });
});

describe("readTopicMarkers", () => {
  test("survives a reload and a compaction", async () => {
    const storageDir = await createStorageDirectory();
    const store = freshStore(storageDir);
    appendTurn(store, "a");
    appendTurn(store, "b");
    store.contextRewrites.appendTopicMarker({
      conversationId: "default",
      agentId,
      title: "kept topic",
      createdBy: "agent",
    });

    // Reload: markers come off the transcript, not memory.
    const reopened = freshStore(storageDir);
    expect(
      reopened.contextRewrites
        .readTopicMarkers("default", agentId)
        .map((m) => m.title),
    ).toEqual(["kept topic"]);

    const messages = reopened.listLocalMessages("default", agentId);
    reopened.contextRewrites.rewriteInContext({
      conversationId: "default",
      agentId,
      summary: "summary",
      packedSummary: "packed",
      remainingMessages: messages.slice(-1),
    });

    // A trim keeps every marker: only the messages leave the context.
    expect(
      reopened.contextRewrites
        .readTopicMarkers("default", agentId)
        .map((m) => m.title),
    ).toEqual(["kept topic"]);
    expect(reopened.listLocalMessages("default", agentId)).toHaveLength(2);
  });

  test("skips damaged rows instead of failing the conversation", async () => {
    const storageDir = await createStorageDirectory();
    const store = freshStore(storageDir);
    appendTurn(store, "a");
    store.contextRewrites.appendTopicMarker({
      conversationId: "default",
      agentId,
      title: "good",
      createdBy: "agent",
    });
    const path = transcriptPath(storageDir);
    const original = await readFile(path, "utf8");
    await rm(path);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      path,
      `${original}{"type":"topic","id":"broken"}\n{"type":"topic","id":"t2","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","title":"good2","createdBy":"agent","anchorMessageId":null,"turnsSincePrevious":0}\n`,
    );

    const reopened = freshStore(storageDir);
    expect(
      reopened.contextRewrites
        .readTopicMarkers("default", agentId)
        .map((m) => m.title),
    ).toEqual(["good", "good2"]);
  });
});
