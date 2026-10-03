import { describe, expect, test } from "bun:test";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  SimpleStreamOptions,
  Usage,
} from "@earendil-works/pi-ai";
import { LocalContextOverflowError } from "@/backend/dev/context-window-overflow";
import {
  PiStreamAdapter,
  type PiStreamFunction,
} from "@/backend/dev/pi-stream-adapter";
import type {
  ProviderStreamEvent,
  ProviderTurnInput,
} from "@/backend/dev/provider-turn-executor";
import { emptyLocalUsage } from "@/backend/local/local-message";

const CONTEXT_WINDOW = 100_000;

function usage(totalTokens: number, output = 100): Usage {
  return {
    input: Math.max(0, totalTokens - output),
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

type CompletedStopReason = "length" | "stop" | "toolUse";

function assistantMessage(
  input: {
    text?: string;
    stopReason?: CompletedStopReason;
    usage?: Usage;
  } = {},
): AssistantMessage & { stopReason: CompletedStopReason } {
  return {
    role: "assistant",
    content: [{ type: "text", text: input.text ?? "done" }],
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    model: "us.anthropic.claude-sonnet-4-6",
    usage: input.usage ?? emptyLocalUsage(),
    stopReason: input.stopReason ?? "stop",
    timestamp: Date.now(),
  };
}

function streamFromMessage(
  finalMessage: AssistantMessage & { stopReason: CompletedStopReason },
): ReturnType<PiStreamFunction> {
  const event: AssistantMessageEvent = {
    type: "done",
    reason: finalMessage.stopReason,
    message: finalMessage,
  };
  async function* iterator() {
    yield event;
  }
  return Object.assign(iterator(), {
    result: async () => finalMessage,
  });
}

function streamFromError(errorMessage: string): ReturnType<PiStreamFunction> {
  const error: AssistantMessage = {
    ...assistantMessage(),
    content: [],
    stopReason: "error",
    errorMessage,
  };
  const event: AssistantMessageEvent = {
    type: "error",
    reason: "error",
    error,
  };
  async function* iterator() {
    yield event;
  }
  return Object.assign(iterator(), {
    result: async () => error,
  });
}

function turnInput(
  input: { content?: string; contextWindow?: number; maxTokens?: number } = {},
): ProviderTurnInput {
  return {
    conversationId: "local-conv-context-pressure",
    agentId: "agent-local-context-pressure",
    agent: {
      id: "agent-local-context-pressure",
      name: "Local",
      description: null,
      system: "system",
      tags: [],
      model: "bedrock/us.anthropic.claude-sonnet-4-6",
      model_settings: {
        provider_type: "bedrock",
        context_window_limit: input.contextWindow ?? CONTEXT_WINDOW,
        ...(input.maxTokens !== undefined
          ? { max_tokens: input.maxTokens }
          : {}),
      },
    },
    body: { messages: [] } as never,
    history: [],
    uiMessages: [
      {
        id: "ui-msg-context-pressure",
        role: "user",
        content: input.content ?? "hello",
        timestamp: Date.now(),
      },
    ],
    clientTools: [],
    clientSkills: [],
  };
}

async function collectEvents(
  stream: AsyncIterable<ProviderStreamEvent>,
): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** The adapter reports a refusal by throwing; the executor turns that into chunks. */
async function collectError(
  stream: AsyncIterable<ProviderStreamEvent>,
): Promise<unknown> {
  try {
    await collectEvents(stream);
    return undefined;
  } catch (error) {
    return error;
  }
}

function compactionEvent(events: ProviderStreamEvent[]) {
  return events.find(
    (event) =>
      event.type === "letta-chunk" &&
      (event.chunk as { event_type?: string }).event_type === "compaction",
  );
}

describe("PiStreamAdapter context pressure", () => {
  test("refuses an over-threshold request instead of rewriting context", async () => {
    let providerCalls = 0;
    const stream: PiStreamFunction = () => {
      providerCalls += 1;
      return streamFromMessage(assistantMessage());
    };
    const adapter = new PiStreamAdapter({ stream });

    // ~96k tokens against a 100k window: past the reserve the harness keeps
    // free, so the request is refused before it reaches the provider.
    const error = await collectError(
      adapter.stream(turnInput({ content: "x".repeat(96_000 * 4) })),
    );

    expect(providerCalls).toBe(0);
    expect(error).toBeInstanceOf(LocalContextOverflowError);
    expect(String(error)).toContain("Run /compact to choose a cut point");
  });

  test("sends a soft-pressure request unchanged", async () => {
    let providerCalls = 0;
    let providerMessages = 0;
    const stream: PiStreamFunction = (_model, context) => {
      providerCalls += 1;
      providerMessages = context.messages.length;
      return streamFromMessage(assistantMessage());
    };
    const adapter = new PiStreamAdapter({ stream });

    // ~78k of 100k is inside the advisory tier: worth offering a trim, never
    // worth blocking or rewriting the request on its own.
    const events = await collectEvents(
      adapter.stream(turnInput({ content: "x".repeat(78_000 * 4) })),
    );

    expect(providerCalls).toBe(1);
    expect(providerMessages).toBe(1);
    expect(compactionEvent(events)).toBeUndefined();
  });

  test("terminates on a provider-reported overflow without retrying", async () => {
    let providerCalls = 0;
    const stream: PiStreamFunction = () => {
      providerCalls += 1;
      return streamFromError(
        "prompt is too long: 500000 tokens > 272000 maximum",
      );
    };
    const adapter = new PiStreamAdapter({ stream });

    const error = await collectError(adapter.stream(turnInput()));

    expect(providerCalls).toBe(1);
    expect(String(error)).toContain("prompt is too long");
  });

  test("keeps an explicit one-token output limit a normal length stop", async () => {
    let capturedOptions:
      | (SimpleStreamOptions & Record<string, unknown>)
      | undefined;
    const stream: PiStreamFunction = (
      _model: Model<string>,
      _context,
      options,
    ) => {
      capturedOptions = options;
      return streamFromMessage(
        assistantMessage({ stopReason: "length", usage: usage(2, 1) }),
      );
    };
    const adapter = new PiStreamAdapter({ stream });

    const events = await collectEvents(
      adapter.stream(turnInput({ maxTokens: 1 })),
    );

    expect(capturedOptions?.maxTokens).toBe(1);
    expect(compactionEvent(events)).toBeUndefined();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider-part",
        part: expect.objectContaining({ type: "done", reason: "length" }),
      }),
    );
  });
});
