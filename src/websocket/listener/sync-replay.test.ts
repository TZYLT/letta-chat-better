import { describe, expect, test } from "bun:test";
import type { ApprovalDecision } from "@/agent/approval-execution";
import { clearPendingMessages } from "@/utils/message-queue-bridge";
import {
  markListenerConnectionInitialized,
  openListenerConnection,
} from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { recoverApprovalStateForSync } from "./recovery-sync";
import { replaySyncStateForRuntime } from "./sync-replay";
import type { LocalTransport } from "./transport";
import type {
  ConversationRuntime,
  IncomingMessage,
  StartListenerOptions,
} from "./types";

class MockTransport implements LocalTransport {
  readonly kind = "local" as const;
  readonly bufferedAmount = 0;
  readonly sent: string[] = [];

  isOpen(): boolean {
    return true;
  }

  send(data: string): void {
    this.sent.push(data);
  }
}

const scope = {
  agent_id: "agent-sync-replay-fixture",
  conversation_id: "conv-sync-replay-fixture",
} as const;

// The source's yielded MessageChannel call: replay-unsafe, so sync recovery
// classifies it as a stale denial with nothing waiting on a human.
const sourceYieldedApproval = {
  toolCallId: "call-message-channel-1",
  toolName: "MessageChannel",
  toolArgs: '{"action":"send","channel":"slack","message":"hi"}',
};

function connectRuntime(): {
  runtime: ConversationRuntime;
  transport: MockTransport;
} {
  clearPendingMessages();
  const runtime = getOrCreateScopedRuntime(
    createRuntime(),
    "agent-sync-replay-fixture",
    "conv-sync-replay-fixture",
  );
  const transport = new MockTransport();
  const options: StartListenerOptions = {
    connectionId: "cloud-relay",
    wsUrl: "local://cloud-relay",
    deviceId: "test-device",
    connectionName: "cloud-relay",
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
  openListenerConnection({
    runtime: runtime.listener,
    connectionId: options.connectionId,
    writer: transport,
    options,
  });
  markListenerConnectionInitialized(runtime.listener, options.connectionId);
  return { runtime, transport };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for the recovered continuation");
}

async function sync(
  runtime: ConversationRuntime,
  transport: MockTransport,
  processed: IncomingMessage[],
): Promise<void> {
  await replaySyncStateForRuntime(runtime.listener, transport as never, scope, {
    scheduleWarmupsAfterSync: () => {},
    // The execution owner's own sync: stale denials may resume the turn.
    recoverApprovals: true,
    resumeInterruptedTurn: true,
    forceDeviceStatus: true,
    connectionId: "cloud-relay",
    recoverApprovalStateForSync: async (
      scopedRuntime,
      recoveredScope,
      _deps,
      recoverOpts,
    ) => {
      return recoverApprovalStateForSync(
        scopedRuntime,
        recoveredScope,
        {
          getBackend: (() => ({
            retrieveAgent: async () => ({ id: "agent-sync-replay-fixture" }),
          })) as never,
          getResumeDataFromBackend: (async () => ({
            pendingApproval: sourceYieldedApproval,
            pendingApprovals: [sourceYieldedApproval],
            messageHistory: [],
          })) as never,
        },
        recoverOpts,
      );
    },
    recoveredContinuationDependencies: {
      ensureSecretsHydrated: async () => {},
      prepareToolExecutionContext: async () =>
        ({
          toolset: "codex",
          toolsetPreference: "auto",
          preparedToolContext: {
            contextId: "context-1",
            loadedToolNames: [],
            clientTools: [],
            clientSkills: [],
          },
        }) as never,
      executeApprovalBatch: (async (decisions: ApprovalDecision[]) =>
        decisions.map((decision) => ({
          type: "approval" as const,
          tool_call_id: decision.approval.toolCallId,
          approve: false,
          reason: decision.type === "deny" ? decision.reason : undefined,
        }))) as never,
    },
    processIncomingMessage: async (
      message,
      _socket,
      ownerRuntime,
      _onStatusChange,
      _connectionId,
      _batchId,
      turnLease,
    ) => {
      processed.push(message);
      if (turnLease) ownerRuntime.turnLifecycle.finish(turnLease, "end_turn");
    },
  });
}

describe("sync replay of an interrupted turn", () => {
  test("the execution owner's sync resumes the turn recovery denied as stale", async () => {
    const { runtime, transport } = connectRuntime();
    const processed: IncomingMessage[] = [];

    await sync(runtime, transport, processed);
    await waitFor(() => processed.length === 1);

    expect(processed[0]?.messages[0]).toMatchObject({
      type: "approval",
      approvals: [
        expect.objectContaining({
          tool_call_id: "call-message-channel-1",
          approve: false,
        }),
      ],
    });
  });
});
