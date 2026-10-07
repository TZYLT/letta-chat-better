import { afterAll, describe, expect, mock, test } from "bun:test";

const warmSearchCacheMock = mock((_body: Record<string, unknown>) =>
  Promise.resolve({
    collection: "messages",
    status: "ACCEPTED",
    warmed: true,
  }),
);

mock.module("../backend/api/search", () => ({
  searchMessages: mock(() => Promise.resolve([])),
  warmSearchCache: warmSearchCacheMock,
}));

const {
  buildMessageSearchRequestBody,
  buildSearchTargetPlan,
  getMessageText,
  warmMessageSearchCache,
} = await import("@/cli/components/MessageSearch");

afterAll(() => {
  mock.restore();
});

describe("warmMessageSearchCache", () => {
  // The warm request targets the Cloud tpuf search cache. The only backend has
  // no such cache, so the helper must return its no-op without posting
  // anything — asserting the *absence* of the request is the point of the case
  // now. `backend/message-search.test.ts` covers the same short-circuit at the
  // backend seam.
  test("does not post a cache-warm request on the local backend", async () => {
    const response = await warmMessageSearchCache();

    expect(warmSearchCacheMock).not.toHaveBeenCalled();
    expect(response).toEqual({
      collection: "messages",
      status: "local-backend-noop",
      warmed: false,
    });
  });
});

describe("buildSearchTargetPlan", () => {
  test("prefetches adjacent modes and ranges instead of blocking on every combination", () => {
    expect(
      buildSearchTargetPlan("hybrid", "agent", {
        agentId: "agent-1",
        conversationId: "conv-1",
      }),
    ).toEqual({
      primary: { mode: "hybrid", range: "agent" },
      prefetch: [
        { mode: "fts", range: "agent" },
        { mode: "vector", range: "agent" },
        { mode: "hybrid", range: "all" },
        { mode: "hybrid", range: "conv" },
      ],
    });
  });

  test("skips unavailable ranges when there is no current conversation", () => {
    expect(
      buildSearchTargetPlan("hybrid", "agent", {
        agentId: "agent-1",
      }),
    ).toEqual({
      primary: { mode: "hybrid", range: "agent" },
      prefetch: [
        { mode: "fts", range: "agent" },
        { mode: "vector", range: "agent" },
        { mode: "hybrid", range: "all" },
      ],
    });
  });

  test("skips equivalent mode prefetches when search modes are text-only", () => {
    expect(
      buildSearchTargetPlan("hybrid", "agent", {
        agentId: "agent-1",
        conversationId: "conv-1",
        textOnlyModes: true,
      }),
    ).toEqual({
      primary: { mode: "hybrid", range: "agent" },
      prefetch: [
        { mode: "hybrid", range: "all" },
        { mode: "hybrid", range: "conv" },
      ],
    });
  });
});

describe("buildMessageSearchRequestBody", () => {
  test("includes agent id for current-conversation searches", () => {
    expect(
      buildMessageSearchRequestBody(" needle ", "fts", "conv", {
        agentId: "agent-1",
        conversationId: "default",
        limit: 25,
      }),
    ).toEqual({
      query: "needle",
      search_mode: "fts",
      limit: 25,
      agent_id: "agent-1",
      conversation_id: "default",
    });
  });
});

describe("message text formatting", () => {
  test("does not assume tool returns are strings", () => {
    expect(
      getMessageText({
        message_type: "tool_return_message",
        name: "tool",
        tool_return: { nested: ["value"] },
      } as never),
    ).toBe('tool: {"nested":["value"]}');
  });
});
