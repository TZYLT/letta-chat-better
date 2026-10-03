import { describe, expect, test } from "bun:test";
import {
  CONTEXT_OVERFLOW_GUIDANCE,
  CONTEXT_OVERFLOW_MESSAGE,
  LocalContextOverflowError,
} from "@/backend/dev/context-window-overflow";
import {
  isRetryableLocalProviderError,
  normalizeLocalProviderError,
} from "@/backend/dev/local-provider-errors";

describe("LocalProviderErrors", () => {
  test("classifies Codex Responses server_error events as retryable LLM errors", () => {
    const error = new Error(
      'Codex error: {"type":"error","error":{"type":"server_error","code":"server_error","message":"An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 940a060b-50b3-4800-a2bc-6a3937b9553c in your message.","param":null},"sequence_number":6}',
    );

    expect(isRetryableLocalProviderError(error)).toBe(true);
    expect(normalizeLocalProviderError(error)).toMatchObject({
      error_type: "llm_error",
      retryable: true,
      stop_reason: "llm_api_error",
    });
  });

  test("classifies Codex WebSocket 1006 closes as retryable LLM errors", () => {
    const error = new Error("WebSocket closed 1006 Connection ended");

    expect(isRetryableLocalProviderError(error)).toBe(true);
    expect(normalizeLocalProviderError(error)).toMatchObject({
      error_type: "llm_error",
      retryable: true,
      stop_reason: "llm_api_error",
    });
  });

  test("keeps ChatGPT usage limits non-retryable", () => {
    const error = new Error(
      'Codex error: {"type":"error","error":{"type":"usage_limit_reached","code":"usage_limit_reached","message":"The usage limit has been reached","plan_type":"team"}}',
    );

    expect(isRetryableLocalProviderError(error)).toBe(false);
    expect(normalizeLocalProviderError(error)).toMatchObject({
      retryable: false,
      stop_reason: "error",
    });
  });

  test("tells the operator what to do about a provider-reported overflow", () => {
    const error = new Error(
      "prompt is too long: 500000 tokens > 272000 maximum",
    );

    expect(isRetryableLocalProviderError(error)).toBe(false);
    expect(normalizeLocalProviderError(error)).toMatchObject({
      message: CONTEXT_OVERFLOW_MESSAGE,
      detail: expect.stringContaining("prompt is too long"),
      retryable: false,
      stop_reason: "error",
    });
  });

  test("keeps the preflight numbers when the harness itself refused the turn", () => {
    const error = new LocalContextOverflowError(
      `Context is at about 84,000 of "gpt-5.5"'s 100,000-token window. ${CONTEXT_OVERFLOW_GUIDANCE}`,
    );

    expect(isRetryableLocalProviderError(error)).toBe(false);
    const info = normalizeLocalProviderError(error);
    expect(info.message).toContain("84,000");
    expect(info.message).toContain(CONTEXT_OVERFLOW_GUIDANCE);
    expect(info.stop_reason).toBe("error");
  });
});
