import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
} from "@earendil-works/pi-ai";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { ConversationMessageCreateBody } from "@/backend";
import type { PiStreamFunction } from "@/backend/dev/pi-stream-adapter";
import { LocalBackend } from "@/backend/local/local-backend";
import { emptyLocalUsage } from "@/backend/local/local-message";

const CONTEXT_OVERFLOW_COPY = "Run /compact to choose a cut point";

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.5",
    usage: emptyLocalUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function streamFromMessage(
  message: AssistantMessage,
): ReturnType<PiStreamFunction> {
  const event: AssistantMessageEvent = {
    type: "done",
    reason: "stop",
    message,
  };
  async function* iterator() {
    yield event;
  }
  return Object.assign(iterator(), {
    result: async () => message,
  });
}

async function collect(
  stream: AsyncIterable<LettaStreamingResponse>,
): Promise<LettaStreamingResponse[]> {
  const chunks: LettaStreamingResponse[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function compactionChunks(chunks: LettaStreamingResponse[]) {
  return chunks.filter(
    (chunk) =>
      (chunk as { event_type?: string }).event_type === "compaction" ||
      (chunk as { message_type?: string }).message_type === "summary_message",
  );
}

function inContextRoles(backend: LocalBackend, conversationId: string) {
  return (
    backend as unknown as {
      store: { listLocalMessages: (id: string) => Array<{ role: string }> };
    }
  ).store
    .listLocalMessages(conversationId)
    .map((message) => message.role);
}

describe("LocalBackend context pressure", () => {
  test("refuses an over-threshold turn instead of compacting before dispatch", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-context-pressure-"),
    );
    try {
      const providerContexts: Context[] = [];
      let summarizerCalls = 0;
      const stream: PiStreamFunction = (_model, context) => {
        providerContexts.push(context);
        return streamFromMessage(assistantMessage("provider response"));
      };
      const complete = async (): Promise<AssistantMessage> => {
        summarizerCalls += 1;
        return assistantMessage("compacted before dispatch");
      };
      const backend = new LocalBackend({
        storageDir,
        stream,
        complete,
        memfsEnabled: false,
      });
      const agent = await backend.createAgent({
        name: "Context Pressure",
        model: "openai/gpt-5.5",
        model_settings: {
          provider_type: "openai",
          context_window_limit: 1_000,
        },
      } as never);
      const conversation = await backend.createConversation({
        agent_id: agent.id,
      } as never);

      const chunks = await collect(
        await backend.createConversationMessageStream(conversation.id, {
          agent_id: agent.id,
          messages: [{ role: "user", content: "x".repeat(4_000) }],
        } as ConversationMessageCreateBody),
      );

      // Nothing is dispatched and nothing is rewritten: the operator is told to
      // trim explicitly (I1). A silent compaction here is exactly the behaviour
      // this feature removes.
      expect(providerContexts).toHaveLength(0);
      expect(summarizerCalls).toBe(0);
      expect(compactionChunks(chunks)).toHaveLength(0);
      expect(chunks).toContainEqual(
        expect.objectContaining({
          message_type: "error_message",
          message: expect.stringContaining(CONTEXT_OVERFLOW_COPY),
        }),
      );
      expect(chunks).toContainEqual(
        expect.objectContaining({
          message_type: "stop_reason",
          stop_reason: "error",
        }),
      );
      // The turn's own message is persisted (it was accepted before the
      // provider call), and it is the only in-context message: no summary was
      // written in place of anything.
      expect(inContextRoles(backend, conversation.id)).toEqual(["user"]);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("honors a persisted context window nested in conversation model settings", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-conversation-context-pressure-"),
    );
    try {
      const initialBackend = new LocalBackend({
        storageDir,
        memfsEnabled: false,
      });
      const agent = await initialBackend.createAgent({
        name: "Context Pressure",
        model: "openai/gpt-5.5",
        model_settings: {
          provider_type: "openai",
          context_window_limit: 100_000,
        },
      } as never);
      const conversation = await initialBackend.createConversation({
        agent_id: agent.id,
        model: "openai/gpt-5.5",
        model_settings: {
          provider_type: "openai",
          context_window_limit: 1_000,
        },
      } as never);

      const providerContexts: Context[] = [];
      const stream: PiStreamFunction = (_model, context) => {
        providerContexts.push(context);
        return streamFromMessage(assistantMessage("provider response"));
      };
      const backend = new LocalBackend({
        storageDir,
        stream,
        complete: async () => assistantMessage("compacted after reload"),
        memfsEnabled: false,
      });
      const reloadedConversation = (await backend.retrieveConversation(
        conversation.id,
      )) as unknown as {
        model_settings?: { context_window_limit?: number } | null;
      };
      expect(reloadedConversation.model_settings?.context_window_limit).toBe(
        1_000,
      );

      const chunks = await collect(
        await backend.createConversationMessageStream(conversation.id, {
          agent_id: agent.id,
          messages: [{ role: "user", content: "x".repeat(4_000) }],
        } as ConversationMessageCreateBody),
      );

      // The conversation's 1,000-token window (not the agent's 100,000) is what
      // decides: the same payload that overflows here would fit the agent's.
      expect(providerContexts).toHaveLength(0);
      expect(chunks).toContainEqual(
        expect.objectContaining({
          message_type: "error_message",
          message: expect.stringContaining(CONTEXT_OVERFLOW_COPY),
        }),
      );
      expect(compactionChunks(chunks)).toHaveLength(0);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
