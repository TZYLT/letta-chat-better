import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { ConversationMessageCreateBody } from "@/backend";
import type { HeadlessTurnExecutor } from "@/backend/dev/headless-turn-executor";
import { LocalBackend } from "@/backend/local/local-backend";
import { emptyLocalUsage } from "@/backend/local/local-message";

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

function assistantMessage(input: {
  content: AssistantMessage["content"];
  stopReason: AssistantMessage["stopReason"];
  responseId: string;
}): AssistantMessage {
  return {
    role: "assistant",
    content: input.content,
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.5",
    responseId: input.responseId,
    usage: emptyLocalUsage(),
    stopReason: input.stopReason,
    timestamp: Date.now(),
  };
}

function turnExecutor(): HeadlessTurnExecutor {
  return {
    async execute() {
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

describe("local compaction without the all fallback", () => {
  test("keeps the custom compaction prompt when sliding-window planning fails", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-compaction-no-fallback-plan-"),
    );
    try {
      const customPrompt = "CUSTOM-SUMMARY-PROMPT: summarize as haiku";
      const systemPromptsSeen: Array<string | undefined> = [];
      const complete = async (
        _model: unknown,
        context: Context,
      ): Promise<AssistantMessage> => {
        systemPromptsSeen.push(context.systemPrompt);
        return assistantMessage({
          responseId: `summary-${systemPromptsSeen.length}`,
          stopReason: "stop",
          content: [{ type: "text", text: "Compacted summary." }],
        });
      };
      const backend = new LocalBackend({
        storageDir,
        executor: turnExecutor(),
        complete,
        memfsEnabled: false,
      });
      const agent = await backend.createAgent({ name: "Local" } as never);
      await backend.updateAgent(agent.id, {
        compaction_settings: { mode: "sliding_window", prompt: customPrompt },
      } as never);
      const conversation = await backend.createConversation({
        agent_id: agent.id,
      } as never);
      await drain(
        await backend.createConversationMessageStream(conversation.id, {
          agent_id: agent.id,
          messages: [{ role: "user", content: "only message" }],
        } as ConversationMessageCreateBody),
      );

      // Fewer than four messages, so sliding-window planning has no cutoff it
      // is allowed to take. The planner's error is the answer now (D-107): there
      // is no second strategy to silently escalate to.
      await expect(
        backend.compactConversationMessages(conversation.id, {
          agent_id: agent.id,
        } as never),
      ).rejects.toThrow("Not enough messages for sliding window compaction.");
      expect(systemPromptsSeen).toHaveLength(0);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("does not summarize the whole context when the trim left it over the window", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-compaction-no-fallback-overflow-"),
    );
    try {
      const customPrompt = "CUSTOM-SUMMARY-PROMPT: summarize as haiku";
      const systemPromptsSeen: Array<string | undefined> = [];
      const complete = async (
        _model: unknown,
        context: Context,
      ): Promise<AssistantMessage> => {
        systemPromptsSeen.push(context.systemPrompt);
        // A long summary keeps the post-compaction estimate above the tiny
        // configured context window: the deleted `all` fallback used to answer
        // that by summarizing everything.
        return assistantMessage({
          responseId: `summary-${systemPromptsSeen.length}`,
          stopReason: "stop",
          content: [{ type: "text", text: "x".repeat(8000) }],
        });
      };
      const backend = new LocalBackend({
        storageDir,
        executor: turnExecutor(),
        complete,
        memfsEnabled: false,
      });
      const agent = await backend.createAgent({
        name: "Local",
        model_settings: { context_window_limit: 1000 },
      } as never);
      await backend.updateAgent(agent.id, {
        compaction_settings: { mode: "sliding_window", prompt: customPrompt },
      } as never);
      const conversation = await backend.createConversation({
        agent_id: agent.id,
      } as never);
      for (const content of ["first", "second"]) {
        await drain(
          await backend.createConversationMessageStream(conversation.id, {
            agent_id: agent.id,
            messages: [{ role: "user", content }],
          } as ConversationMessageCreateBody),
        );
      }

      await backend.compactConversationMessages(conversation.id, {
        agent_id: agent.id,
      } as never);

      // Exactly one summarizer call, with the user's prompt: the sliding-window
      // trim happened and its result stands even though the estimate is still
      // above the window. Only the operator may escalate (I1).
      expect(systemPromptsSeen).toHaveLength(1);
      expect(systemPromptsSeen[0]).toBe(customPrompt);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
