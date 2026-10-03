/**
 * Reader coverage for topic markers. The scan is the one reader that has to
 * walk far enough back to find markers a trim left behind, so it needs its own
 * bounds and damage-tolerance tests rather than a case inside the transcript
 * projection suite.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLocalTranscriptTopicEntries } from "@/backend/local/local-transcript-topics";

const temporaryDirectories: string[] = [];

async function createStorageDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-transcript-topics-"));
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

function messageRow(id: string, text: string): Record<string, unknown> {
  return {
    type: "message",
    id: `entry-${id}`,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      id,
      role: "user",
      content: [{ type: "text", text }],
      timestamp: 0,
    },
  };
}

function topicRow(input: {
  id: string;
  title: string;
  createdBy?: "agent" | "user";
}): Record<string, unknown> {
  return {
    type: "topic",
    id: input.id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    title: input.title,
    createdBy: input.createdBy ?? "agent",
    anchorMessageId: "msg-1",
    turnsSincePrevious: 3,
  };
}

async function writeTranscript(
  storageDir: string,
  lines: readonly string[],
): Promise<string> {
  const messagesPath = join(storageDir, "messages.jsonl");
  await writeFile(messagesPath, `${lines.join("\n")}\n`);
  return messagesPath;
}

describe("readLocalTranscriptTopicEntries", () => {
  test("reads markers oldest first and skips corrupt or malformed rows", async () => {
    const storageDir = await createStorageDirectory();
    const messagesPath = await writeTranscript(storageDir, [
      JSON.stringify(topicRow({ id: "topic-1", title: "first" })),
      "{not json",
      JSON.stringify({ type: "topic", id: "topic-broken", title: 7 }),
      JSON.stringify(messageRow("msg-1", "two")),
      JSON.stringify(
        topicRow({ id: "topic-2", title: "second", createdBy: "user" }),
      ),
    ]);

    const entries = readLocalTranscriptTopicEntries(messagesPath);

    expect(entries.map((entry) => entry.id)).toEqual(["topic-1", "topic-2"]);
    expect(entries[0]?.createdBy).toBe("agent");
    expect(entries[1]?.createdBy).toBe("user");
  });

  test("keeps a multi-byte title intact across chunk boundaries", async () => {
    const storageDir = await createStorageDirectory();
    const title = "上下文管理：话题边界与回退".repeat(6);
    const messagesPath = await writeTranscript(storageDir, [
      JSON.stringify(messageRow("msg-1", "中文内容也要能跨块读取")),
      JSON.stringify(topicRow({ id: "topic-1", title })),
    ]);

    // A 5-byte window splits characters mid-sequence; the title must still come
    // back byte-exact.
    const entries = readLocalTranscriptTopicEntries(messagesPath, {
      chunkBytes: 5,
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.title).toBe(title);
  });

  test("yields a final line written without a trailing newline", async () => {
    const storageDir = await createStorageDirectory();
    const messagesPath = join(storageDir, "messages.jsonl");
    await writeFile(
      messagesPath,
      JSON.stringify(topicRow({ id: "topic-1", title: "last" })),
    );

    expect(
      readLocalTranscriptTopicEntries(messagesPath).map((entry) => entry.id),
    ).toEqual(["topic-1"]);
  });

  test("returns nothing for a missing or empty transcript", async () => {
    const storageDir = await createStorageDirectory();
    expect(
      readLocalTranscriptTopicEntries(join(storageDir, "messages.jsonl")),
    ).toEqual([]);

    const emptyPath = join(storageDir, "empty.jsonl");
    await writeFile(emptyPath, "");
    expect(readLocalTranscriptTopicEntries(emptyPath)).toEqual([]);
  });
});
