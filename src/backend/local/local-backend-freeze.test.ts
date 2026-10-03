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
 *   V15 — application-point consolidation: an `agent.system` edit only
 *         registers a pending change; `/recompile` (the application point) is
 *         what applies it.
 *   V16 — a fork inherits the parent's applied prefix and model verbatim; a
 *         live model switch on the fork is registered, not applied (D-C).
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

/** Records the prompt AND the model each turn actually ran on. */
function recordingModelExecutor(
  sink: Array<{ prompt: string; model: string }>,
): HeadlessTurnExecutor {
  return {
    async execute(input) {
      sink.push({
        prompt: input.systemPrompt ?? "",
        model: input.agent.model,
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

describe("V15 agent.system changes register instead of applying", () => {
  test("updateAgent({system}) keeps the frozen prefix until /recompile", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "freeze-system-change-"));
    const systemPrompts: string[] = [];
    const executor = recordingExecutor(systemPrompts);
    const backend = new LocalBackend({
      storageDir,
      executor,
      memfsEnabled: false,
    });
    const agent = await backend.createAgent({
      name: "Local",
      system: "ORIGINAL SYSTEM {CORE_MEMORY}",
    } as never);
    const conversation = await backend.createConversation({
      agent_id: agent.id,
    } as never);
    await sendTurn(backend, conversation.id, agent.id, "first");

    await backend.updateAgent(agent.id, {
      system: "REPLACED SYSTEM {CORE_MEMORY}",
    } as never);

    // Registered, not applied: the snapshot survives and the report says so.
    // Deleting the snapshot here would silently rewrite the prefix (R-07).
    const pending = await backend.getContextPending(conversation.id, agent.id);
    expect(pending.hasSnapshot).toBe(true);
    expect(pending.systemChanged).toBe(true);
    expect(pending.hasPending).toBe(true);

    await sendTurn(backend, conversation.id, agent.id, "second");
    expect(systemPrompts).toHaveLength(2);
    expect(systemPrompts[1]).toBe(systemPrompts[0]);
    expect(systemPrompts[1]).toContain("ORIGINAL SYSTEM");

    // The application point applies it.
    await backend.recompileConversation(conversation.id, {
      agent_id: agent.id,
    } as never);
    await sendTurn(backend, conversation.id, agent.id, "third");
    expect(systemPrompts).toHaveLength(3);
    expect(systemPrompts[2]).toContain("REPLACED SYSTEM");
    expect(systemPrompts[2]).not.toContain("ORIGINAL SYSTEM");
  }, 60000);
});

describe("V16 fork inheritance", () => {
  test("a fork inherits the parent's prefix and model; a fork model switch only registers", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "freeze-fork-inherit-"));
    const turns: Array<{ prompt: string; model: string }> = [];
    const executor = recordingModelExecutor(turns);
    const backend = new LocalBackend({
      storageDir,
      executor,
      memfsEnabled: false,
    });
    const agent = await backend.createAgent({
      name: "Local",
      system: "base {CORE_MEMORY}",
      model: "anthropic/parent-model",
    } as never);
    const conversation = await backend.createConversation({
      agent_id: agent.id,
    } as never);
    await sendTurn(backend, conversation.id, agent.id, "first");

    const forked = await backend.forkConversation(conversation.id, {});
    await sendTurn(backend, forked.id, agent.id, "second");

    // D-C: a fork is a pure copy — same prefix bytes, same model.
    expect(turns).toHaveLength(2);
    expect(turns[1]?.prompt).toBe(turns[0]?.prompt);
    expect(turns[1]?.model).toBe(turns[0]?.model);
    expect(turns[1]?.model).toBe("anthropic/parent-model");

    // A live model switch on the fork is registered at the application point,
    // never applied from a turn.
    await backend.updateConversation(forked.id, {
      model: "openai/other-model",
    } as never);
    const pending = await backend.getContextPending(forked.id, agent.id);
    expect(pending.hasSnapshot).toBe(true);
    expect(pending.model.changed).toBe(true);
    expect(pending.hasPending).toBe(true);

    await sendTurn(backend, forked.id, agent.id, "third");
    expect(turns).toHaveLength(3);
    expect(turns[2]?.prompt).toBe(turns[0]?.prompt);
    expect(turns[2]?.model).toBe("anthropic/parent-model");
  }, 60000);
});
