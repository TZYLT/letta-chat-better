import { expect, test } from "bun:test";
import { runWithRuntimeContext, updateRuntimeContext } from "@/runtime-context";
import { resolveNotificationScope } from "./task-notifications";

test("notification scope keeps its conversation after the turn changes", () => {
  runWithRuntimeContext({}, () => {
    const scope = resolveNotificationScope({
      agentId: "agent-a",
      conversationId: "conv-a",
    });
    updateRuntimeContext({
      agentId: "agent-b",
      conversationId: "conv-b",
    });
    expect(scope).toEqual({
      agentId: "agent-a",
      conversationId: "conv-a",
    });
  });
});
