import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Letta } from "@letta-ai/letta-client";
import { WebSocketServer } from "ws";
import { sendMessageStreamWithBackend } from "@/agent/message";
import type { Backend } from "@/backend";
import { runWithRuntimeContext } from "@/runtime-context";
import { __clearExecSessionsForTests } from "@/tools/impl/exec-command";
import { backgroundProcesses } from "@/tools/impl/process_manager";
import {
  executeTool,
  prepareToolExecutionContextForSpecificTools,
  releaseToolExecutionContext,
} from "@/tools/manager";
import { clearPendingMessages } from "@/utils/message-queue-bridge";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { createRuntime } from "./lifecycle";
import { getOrCreateConversationPermissionModeStateRef } from "./permission-mode";
import {
  clearProcessServices,
  installProcessEventRouting,
} from "./process-services";
import { setActiveRuntime } from "./runtime";
import { LocalListenerTransport } from "./transport";
import { handleApprovalStop } from "./turn-approval";

/**
 * `sendMessageStreamWithBackend` needs a backend, and these tests only need its
 * message-stream transport (a real HTTP round trip to the mock SSE server in the
 * test). The API backend class that used to provide it was deleted with the
 * Cloud backend, so the one method the transport needs lives here.
 */
function createTestStreamBackend(client: Letta): Backend {
  const backend = {
    async createConversationMessageStream(
      conversationId: string,
      body: Parameters<Backend["createConversationMessageStream"]>[1],
      options?: Parameters<Backend["createConversationMessageStream"]>[2],
    ) {
      const { data } = await client.conversations.messages
        .create(conversationId, body, options)
        .withResponse();
      return data;
    },
  };
  return backend as unknown as Backend;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Notification did not arrive");
    await Bun.sleep(10);
  }
}

afterEach(() => {
  for (const process of backgroundProcesses.values()) {
    process.completionNotificationSuppressed = true;
    process.process.kill("SIGKILL");
  }
  backgroundProcesses.clear();
  __clearExecSessionsForTests();
  clearPendingMessages();
  setActiveRuntime(null);
});

// Run the production producer, bridge, listener routing and approval continuation.
// A release file / WebSocket event controls completion; no timed race with a tool.
for (const producer of [
  "exec_command",
  "Bash",
  "Monitor",
  "WebSocket",
] as const) {
  test(`${producer}: completion during an active turn`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "notification-steering-"));
    const releaseFile = join(directory, "release");
    const script = join(directory, "wait.cjs");
    writeFileSync(
      script,
      `const fs = require('node:fs'); const timer = setInterval(() => {
          if (fs.existsSync(${JSON.stringify(releaseFile)})) {
            clearInterval(timer); console.log('background complete');
          }
        }, 10);`,
    );
    const listener = createRuntime();
    const scope = { agentId: "agent-1", conversationId: "conv-1" };
    const runtime = getOrCreateScopedRuntime(
      listener,
      scope.agentId,
      scope.conversationId,
    );
    const lease = runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: directory,
      initialStatus: "PROCESSING_API_RESPONSE",
    });
    const socket = new LocalListenerTransport();
    installProcessEventRouting({
      runtime: listener,
      processTransport: socket,
      opts: {
        connectionId: "conn-1",
        wsUrl: "ws://test",
        deviceId: "device-1",
        connectionName: "test",
        onConnected() {},
        onDisconnected() {},
        onError() {},
      },
      processQueuedTurn: async () => {
        throw new Error("Must not start an idle turn");
      },
    });
    const tool = producer === "WebSocket" ? "Monitor" : producer;
    const prepared = await prepareToolExecutionContextForSpecificTools([tool], {
      workingDirectory: directory,
      runtimeContext: scope,
    });
    const requests: Array<{ body: unknown }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requests.push({ body: await request.json() });
        return new Response(
          'data: {"message_type":"stop_reason","stop_reason":"end_turn"}\n\n',
          {
            headers: { "Content-Type": "text/event-stream" },
          },
        );
      },
    });
    const backend = createTestStreamBackend(
      new Letta({
        apiKey: "test-key",
        baseURL: server.url.toString(),
        maxRetries: 0,
      }),
    );
    const wsServer =
      producer === "WebSocket" ? new WebSocketServer({ port: 0 }) : undefined;
    try {
      const command = `"${process.execPath}" "${script}"`;
      const address = wsServer?.address();
      const source =
        producer === "WebSocket" && address && typeof address !== "string"
          ? { ws: { url: `ws://127.0.0.1:${address.port}` } }
          : { command };
      // The captured tool context, not the caller's current turn, owns this work.
      const result = await runWithRuntimeContext({}, () =>
        executeTool(
          tool,
          producer === "exec_command"
            ? {
                cmd: command,
                description: "Background check",
                yield_time_ms: 250,
              }
            : producer === "Bash"
              ? {
                  command,
                  description: "Background check",
                  run_in_background: true,
                }
              : {
                  ...source,
                  description: "Background check",
                  persistent: true,
                },
          { toolContextId: prepared.contextId },
        ),
      );
      expect(result.status).toBe("success");
      await runWithRuntimeContext({}, async () => {
        if (wsServer) {
          await waitFor(() => wsServer.clients.size > 0);
          for (const client of wsServer.clients)
            client.send("background complete");
        } else writeFileSync(releaseFile, "go");
        // Shell monitors emit an event and a terminal notice. Both must steer.
        await waitFor(
          () =>
            runtime.queueRuntime.length === (producer === "Monitor" ? 2 : 1),
        );
      });
      enqueueInboundUserMessage(runtime, {
        type: "message",
        ...scope,
        messages: [{ role: "user", content: "Change direction now" }],
      });
      const approval = {
        toolCallId: "call-next",
        toolName: "Bash",
        toolArgs: '{"command":"pwd"}',
      };
      const continuation = await handleApprovalStop({
        approvals: [approval],
        runtime,
        socket,
        ...scope,
        turnWorkingDirectory: directory,
        turnPermissionModeState: getOrCreateConversationPermissionModeStateRef(
          listener,
          scope.agentId,
          scope.conversationId,
        ),
        dequeuedBatchId: "batch-1",
        msgRunIds: [],
        turnInput: { messages: [] },
        pendingNormalizationInterruptedToolCallIds: [],
        turnToolContextId: prepared.contextId,
        turnLease: lease,
        processOwnedTurn: true,
        buildSendOptions: () => ({
          ...scope,
          streamTokens: true,
          background: true,
        }),
        dependencies: {
          classifyApprovals: async () => ({
            autoAllowed: [
              {
                approval,
                parsedArgs: {},
                context: null,
                permission: { decision: "allow" },
              },
            ],
            autoDenied: [],
            needsUserInput: [],
          }),
          executeApprovalBatch: async () => [
            {
              type: "tool",
              tool_call_id: approval.toolCallId,
              status: "success",
              tool_return: directory,
            },
          ],
          ensureSecretsHydrated: async () => {},
          sendApprovalContinuation: async (
            conversationId,
            messages,
            options,
          ) => {
            const stream = await sendMessageStreamWithBackend(
              backend,
              conversationId,
              messages,
              { ...options, preparedToolContext: prepared, skillSources: [] },
            );
            for await (const _event of stream) {
              /* Read the SDK response. */
            }
            return {
              kind: "terminal",
              drainResult: { stopReason: "end_turn", apiDurationMs: 0 },
            };
          },
        },
      });
      expect(continuation.kind).toBe("terminal");
      expect(runtime.turnLifecycle.kind).toBe("active");
      expect(requests).toHaveLength(1);
      const body = JSON.stringify(
        (requests[0]?.body as { messages: unknown[] }).messages,
      );
      expect(body).toContain("call-next");
      expect(body).toContain("background complete");
      expect(body).toContain("Change direction now");
      expect(body).toContain('"attribution":{}');
      expect(runtime.queueRuntime.length).toBe(0);
    } finally {
      clearProcessServices(listener);
      releaseToolExecutionContext(prepared.contextId);
      server.stop(true);
      for (const client of wsServer?.clients ?? []) client.terminate();
      wsServer?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);
}

test("an idle monitor notification starts its turn", async () => {
  const directory = mkdtempSync(join(tmpdir(), "monitor-acting-user-"));
  const script = join(directory, "complete.cjs");
  writeFileSync(script, "console.log('monitor complete');");
  const listener = createRuntime();
  setActiveRuntime(listener);
  const scope = { agentId: "agent-monitor", conversationId: "conv-monitor" };
  const receivedMessages: Array<unknown> = [];
  installProcessEventRouting({
    runtime: listener,
    processTransport: new LocalListenerTransport(),
    opts: {
      connectionId: "conn-monitor",
      wsUrl: "ws://test",
      deviceId: "device-monitor",
      connectionName: "test",
      onConnected() {},
      onDisconnected() {},
      onError() {},
    },
    processQueuedTurn: async (incoming) => {
      receivedMessages.push(incoming);
    },
  });
  const prepared = await prepareToolExecutionContextForSpecificTools(
    ["Monitor"],
    {
      workingDirectory: directory,
      runtimeContext: scope,
    },
  );

  try {
    const result = await runWithRuntimeContext({}, () =>
      executeTool(
        "Monitor",
        {
          command: `"${process.execPath}" "${script}"`,
          description: "Monitor acting user",
          timeout_ms: 5_000,
        },
        { toolContextId: prepared.contextId },
      ),
    );
    expect(result.status).toBe("success");
    await waitFor(() => receivedMessages.length > 0);
    expect(receivedMessages).toHaveLength(1);
  } finally {
    clearProcessServices(listener);
    releaseToolExecutionContext(prepared.contextId);
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
