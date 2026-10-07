import { expect, test } from "bun:test";
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  addRoute,
  readRoutes,
} from "@/channels/routing";

// Deliberately reuse the same identifiers across consecutive tests. The shared
// preload, not a per-suite cleanup or a unique identifier, owns their isolation.
test("a channel route registered here is readable in this test", () => {
  __testOverrideLoadRoutes(() => null);
  __testOverrideSaveRoutes(() => {});
  addRoute("telegram", {
    chatId: "12345",
    agentId: "agent-1",
    conversationId: "conv-1",
    enabled: true,
    createdAt: new Date().toISOString(),
  });
  expect(readRoutes("telegram")).toEqual([
    expect.objectContaining({
      chatId: "12345",
      agentId: "agent-1",
      conversationId: "conv-1",
    }),
  ]);
});

test("the next test does not see the route registered above", () => {
  expect(readRoutes("telegram")).toEqual([]);
});
