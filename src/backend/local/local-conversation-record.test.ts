/**
 * Pre-flight pins for feature-③ (context management) state that must survive
 * `conversation.json` round-trips. The local conversation record is loaded with
 * a spread (`parsePersistedLocalConversation`) and persisted by serializing the
 * whole in-memory object, so a conversation-level field the store does not know
 * about — like the coming `context_management` nudge flag — must survive
 * load → mutate → persist. If that ever stops holding, the one-shot topic
 * marker nudge would re-fire after every restart.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationMessageCreateBody } from "@/backend";
import { parsePersistedLocalConversation } from "@/backend/local/local-conversation-record";
import { LocalStore } from "@/backend/local/local-store";

const temporaryDirectories: string[] = [];

async function createStorageDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-conversation-record-"));
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

const agentId = "agent-record-round-trip";

function recordPath(storageDir: string, conversationId = "default"): string {
  // Mirrors LocalStore#conversationKey: only the default conversation is keyed
  // by agent id.
  const key =
    conversationId === "default"
      ? `default:${agentId}`
      : `conversation:${conversationId}`;
  return join(
    storageDir,
    "conversations",
    Buffer.from(key).toString("base64url"),
    "conversation.json",
  );
}

function sendUserMessage(store: LocalStore, text: string): void {
  store.appendTurnInput("default", {
    agent_id: agentId,
    messages: [{ role: "user", content: text }],
  } as ConversationMessageCreateBody);
}

describe("parsePersistedLocalConversation", () => {
  test("keeps fields the store does not know about", () => {
    const parsed = parsePersistedLocalConversation(
      JSON.stringify({
        id: "conv-1",
        agent_id: "agent-1",
        in_context_message_ids: [],
        context_management: { nudge_sent_for_streak: true },
        future_field: { nested: [1, 2, 3] },
      }),
      () => "agent-1",
    );

    expect(parsed).toBeDefined();
    expect(
      (parsed as unknown as Record<string, unknown>).context_management,
    ).toEqual({ nudge_sent_for_streak: true });
    expect((parsed as unknown as Record<string, unknown>).future_field).toEqual(
      { nested: [1, 2, 3] },
    );
  });

  test("resolves an agent-free record's execution agent id", () => {
    const parsed = parsePersistedLocalConversation(
      JSON.stringify({
        id: "conv-free",
        agent_id: null,
        agent_free: true,
        in_context_message_ids: [],
      }),
      (conversationId) => `execution-${conversationId}`,
    );

    expect(parsed?.agent_id).toBe("execution-conv-free");
  });

  test("rejects a record with no usable owner", () => {
    expect(
      parsePersistedLocalConversation(
        JSON.stringify({ id: "conv-2", agent_id: null }),
        () => "agent-1",
      ),
    ).toBeUndefined();
  });
});

describe("conversation record round-trip", () => {
  test("an unknown conversation field survives load, mutation, and persist", async () => {
    const storageDir = await createStorageDirectory();
    const store = new LocalStore(agentId, { storageDir });
    sendUserMessage(store, "first");

    // Simulate a newer build (or a future feature) writing conversation-level
    // state this build has no field for.
    const before = JSON.parse(await readFile(recordPath(storageDir), "utf8"));
    before.context_management = { nudge_sent_for_streak: true };
    await writeFile(recordPath(storageDir), JSON.stringify(before, null, 2));

    // Reopen: the field must load, then survive a store-initiated persist.
    const reopened = new LocalStore(agentId, { storageDir });
    sendUserMessage(reopened, "second");

    const after = JSON.parse(await readFile(recordPath(storageDir), "utf8"));
    expect(after.context_management).toEqual({
      nudge_sent_for_streak: true,
    });
    expect(after.in_context_message_ids).toHaveLength(2);
  });

  test("an unknown conversation field survives an update through the store", async () => {
    const storageDir = await createStorageDirectory();
    const store = new LocalStore(agentId, { storageDir });
    const created = store.createConversation({ agent_id: agentId });
    const path = recordPath(storageDir, created.id);

    const before = JSON.parse(await readFile(path, "utf8"));
    before.context_management = { nudge_sent_for_streak: true };
    await writeFile(path, JSON.stringify(before, null, 2));

    const reopened = new LocalStore(agentId, { storageDir });
    reopened.updateConversation(created.id, { summary: "renamed" });

    const after = JSON.parse(await readFile(path, "utf8"));
    expect(after.summary).toBe("renamed");
    expect(after.context_management).toEqual({
      nudge_sent_for_streak: true,
    });
  });
});
