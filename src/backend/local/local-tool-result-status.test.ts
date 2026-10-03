/**
 * An approval result for a tool call carries the client's `status`. The store
 * must persist it as `isError` so the provider payload reports `is_error`
 * instead of telling the model a failed call succeeded.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { ConversationMessageCreateBody } from "@/backend";
import { LocalStore } from "@/backend/local/local-store";

const temporaryDirectories: string[] = [];

async function createStorageDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-tool-result-status-"));
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

/** Queues one pending tool call, leaving the store awaiting an approval. */
function storeWithPendingToolCall(
  agentId: string,
  toolCallId: string,
  storageDir?: string,
): LocalStore {
  const store = new LocalStore(agentId, storageDir ? { storageDir } : {});
  store.appendTurnInput("default", {
    agent_id: agentId,
    messages: [{ role: "user", content: "run the tool" }],
  } as ConversationMessageCreateBody);
  store.appendStreamChunk("default", agentId, {
    message_type: "approval_request_message",
    tool_call: { tool_call_id: toolCallId, name: "Bash", arguments: "{}" },
  } as LettaStreamingResponse);
  store.appendStreamChunk("default", agentId, {
    message_type: "stop_reason",
    stop_reason: "requires_approval",
  } as LettaStreamingResponse);
  return store;
}

function resolveApproval(
  store: LocalStore,
  agentId: string,
  approvals: unknown[],
): void {
  store.appendTurnInput("default", {
    agent_id: agentId,
    messages: [{ type: "approval", approvals }],
  } as unknown as ConversationMessageCreateBody);
}

function localToolResult(
  store: LocalStore,
  agentId: string,
  toolCallId: string,
): { isError: boolean } {
  const message = store
    .listLocalMessages("default", agentId)
    .find(
      (candidate) =>
        candidate.role === "toolResult" && candidate.toolCallId === toolCallId,
    );
  if (message?.role !== "toolResult") {
    throw new Error(`Missing tool result for ${toolCallId}`);
  }
  return message;
}

/** The projection the UI and the transcript readers consume. */
function projectedToolResult(
  store: LocalStore,
  agentId: string,
  toolCallId: string,
): { status?: unknown; tool_return?: unknown } {
  const message = store
    .listConversationMessages("default", {
      agent_id: agentId,
      order: "asc",
    })
    .find(
      (candidate) =>
        (candidate as { tool_call_id?: unknown }).tool_call_id === toolCallId,
    );
  if (!message) throw new Error(`Missing projected message for ${toolCallId}`);
  return message as unknown as { status?: unknown; tool_return?: unknown };
}

describe("local tool result status", () => {
  test("persists an errored tool approval as an error result", async () => {
    const storageDir = await createStorageDirectory();
    const agentId = "agent-local-tool-result-error";
    const toolCallId = "tool-call-failed";
    const store = storeWithPendingToolCall(agentId, toolCallId, storageDir);

    resolveApproval(store, agentId, [
      {
        type: "tool",
        tool_call_id: toolCallId,
        status: "error",
        tool_return: "Error executing tool: EPERM",
      },
    ]);

    expect(localToolResult(store, agentId, toolCallId).isError).toBe(true);
    expect(projectedToolResult(store, agentId, toolCallId)).toMatchObject({
      status: "error",
      tool_return: "Error executing tool: EPERM",
    });

    // The flag has to survive the write/read cycle, not just the live object.
    const reloaded = new LocalStore(agentId, { storageDir });
    expect(localToolResult(reloaded, agentId, toolCallId).isError).toBe(true);
  });

  test("keeps a successful tool approval non-error", () => {
    const agentId = "agent-local-tool-result-success";
    const toolCallId = "tool-call-succeeded";
    const store = storeWithPendingToolCall(agentId, toolCallId);

    resolveApproval(store, agentId, [
      {
        type: "tool",
        tool_call_id: toolCallId,
        status: "success",
        tool_return: "README contents",
      },
    ]);

    expect(localToolResult(store, agentId, toolCallId).isError).toBe(false);
    expect(projectedToolResult(store, agentId, toolCallId)).toMatchObject({
      status: "success",
      tool_return: "README contents",
    });
  });

  test("treats a tool approval without a status as non-error", () => {
    const agentId = "agent-local-tool-result-unstated";
    const toolCallId = "tool-call-unstated";
    const store = storeWithPendingToolCall(agentId, toolCallId);

    resolveApproval(store, agentId, [
      { type: "tool", tool_call_id: toolCallId, tool_return: "output" },
    ]);

    expect(localToolResult(store, agentId, toolCallId).isError).toBe(false);
  });
});
