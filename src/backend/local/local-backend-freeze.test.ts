import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { ConversationMessageCreateBody } from "@/backend";
import type { HeadlessTurnExecutor } from "@/backend/dev/headless-turn-executor";
import { LocalBackend } from "@/backend/local/local-backend";

/**
 * Prefix-freeze acceptance scenarios at the LocalBackend boundary:
 *   V9  — a restart (fresh backend on the same storage dir) still uses the
 *         applied snapshot for the same conversation.
 *   V11 — degradation: a missing snapshot compiles fresh, and an unavailable
 *         memory repo never rewrites the frozen prefix.
 */

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // drain
  }
}

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

function recordingExecutor(sink: string[]): HeadlessTurnExecutor {
  return {
    async execute(input) {
      sink.push(input.systemPrompt ?? "");
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

async function sendTurn(
  backend: LocalBackend,
  conversationId: string,
  agentId: string,
  content: string,
): Promise<void> {
  await drain(
    await backend.createConversationMessageStream(conversationId, {
      agent_id: agentId,
      messages: [{ role: "user", content }],
    } as ConversationMessageCreateBody),
  );
}

async function commitMemory(
  memoryDir: string,
  fileName: string,
  contents: string,
): Promise<void> {
  await writeFile(join(memoryDir, fileName), contents, "utf8");
  execFileSync("git", ["add", fileName], { cwd: memoryDir });
  execFileSync("git", ["commit", "-m", `test change ${fileName}`], {
    cwd: memoryDir,
  });
}

/** Locate the compiled snapshot on disk (its directory name is opaque). */
async function findCompiledSnapshotPath(
  storageDir: string,
): Promise<string | undefined> {
  const conversationsDir = join(storageDir, "conversations");
  const entries = await readdir(conversationsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(conversationsDir, entry.name, "system-prompt.json");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

describe("V9 cross-restart", () => {
  test("a fresh backend on the same storage dir reuses the frozen snapshot", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "freeze-restart-"));
    const systemPrompts: string[] = [];
    const executor = recordingExecutor(systemPrompts);
    const backendA = new LocalBackend({
      storageDir,
      executor,
      memfsEnabled: false,
    });
    const agent = await backendA.createAgent({
      name: "Local",
      system: "base {CORE_MEMORY}",
    } as never);
    const conversation = await backendA.createConversation({
      agent_id: agent.id,
    } as never);
    await sendTurn(backendA, conversation.id, agent.id, "first");

    // "Restart": a brand-new backend instance reading the same storage dir.
    const backendB = new LocalBackend({
      storageDir,
      executor,
      memfsEnabled: false,
    });
    await sendTurn(backendB, conversation.id, agent.id, "second");

    expect(systemPrompts).toHaveLength(2);
    expect(systemPrompts[1]).toBe(systemPrompts[0]);
  }, 60000);
});

describe("V11 degradation", () => {
  test("a missing snapshot compiles fresh from the latest committed memory", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "freeze-missing-snap-"));
    const systemPrompts: string[] = [];
    const executor = recordingExecutor(systemPrompts);
    const backendA = new LocalBackend({ storageDir, executor });
    const agent = await backendA.createAgent({
      name: "Local",
      system: "base {CORE_MEMORY}",
    } as never);
    const conversation = await backendA.createConversation({
      agent_id: agent.id,
    } as never);
    await sendTurn(backendA, conversation.id, agent.id, "first");

    const memoryDir = join(storageDir, "memfs", agent.id, "memory");
    await commitMemory(
      memoryDir,
      "persona.md",
      '---\nname: "Persona"\ndescription: "Who the agent is"\n---\nApplied only after the snapshot is rebuilt.\n',
    );

    // Simulate snapshot loss, then restart so nothing is cached in memory.
    const snapshotPath = await findCompiledSnapshotPath(storageDir);
    expect(snapshotPath).toBeDefined();
    await rm(snapshotPath ?? "", { force: true });

    const backendB = new LocalBackend({ storageDir, executor });
    await sendTurn(backendB, conversation.id, agent.id, "second");

    expect(systemPrompts).toHaveLength(2);
    expect(systemPrompts[0]).not.toContain(
      "Applied only after the snapshot is rebuilt.",
    );
    expect(systemPrompts[1]).toContain(
      "Applied only after the snapshot is rebuilt.",
    );
    expect(systemPrompts[1]).not.toBe(systemPrompts[0]);
  }, 60000);

  test("an unavailable memory repo never rewrites the frozen prefix", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "freeze-broken-mem-"));
    const systemPrompts: string[] = [];
    const executor = recordingExecutor(systemPrompts);
    const backend = new LocalBackend({ storageDir, executor });
    const agent = await backend.createAgent({
      name: "Local",
      system: "base {CORE_MEMORY}",
    } as never);
    const conversation = await backend.createConversation({
      agent_id: agent.id,
    } as never);
    await sendTurn(backend, conversation.id, agent.id, "first");

    // Break the memory repo: revision reads now fail.
    const memoryDir = join(storageDir, "memfs", agent.id, "memory");
    await rm(join(memoryDir, ".git"), { recursive: true, force: true });

    await sendTurn(backend, conversation.id, agent.id, "second");

    // Prefix is untouched and the turn still completes.
    expect(systemPrompts).toHaveLength(2);
    expect(systemPrompts[1]).toBe(systemPrompts[0]);

    // Pending computation stays best-effort: it reports no drift, never throws.
    const pending = await backend.getContextPending(conversation.id, agent.id);
    expect(pending.memory.unappliedCommits).toEqual([]);
    expect(pending.hasPending).toBe(false);
  }, 60000);
});
