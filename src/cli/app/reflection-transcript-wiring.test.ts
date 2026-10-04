import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("interactive reflection transcript wiring", () => {
  test("coordinator wires the reflection launcher into the post-turn check", () => {
    const coordinatorPath = fileURLToPath(
      new URL("./AppCoordinator.tsx", import.meta.url),
    );
    const source = readFileSync(coordinatorPath, "utf-8");

    expect(source).toContain("const maybeRunPostTurnReflection = useCallback(");
    expect(source).toContain("maybeLaunchPostTurnReflection({");
    expect(source).toContain("launchReflectionSubagent({");
    expect(source).toContain("description: AUTO_REFLECTION_DESCRIPTION");
  });

  test("conversation loop evaluates reflection after the transcript append on end_turn", () => {
    const conversationLoopPath = fileURLToPath(
      new URL("./use-conversation-loop.ts", import.meta.url),
    );
    const loopSource = readFileSync(conversationLoopPath, "utf-8");

    const endTurnIndex = loopSource.indexOf(
      'if (stopReasonToHandle === "end_turn")',
    );
    const appendIndex = loopSource.indexOf(
      "appendTranscriptDeltaJsonl(",
      endTurnIndex,
    );
    const reflectionIndex = loopSource.indexOf(
      "await maybeRunPostTurnReflection();",
      endTurnIndex,
    );

    expect(endTurnIndex).toBeGreaterThanOrEqual(0);
    expect(appendIndex).toBeGreaterThan(endTurnIndex);
    expect(reflectionIndex).toBeGreaterThan(appendIndex);
  });

  test("manual /compact restores context before launching reflection", () => {
    const compactPath = fileURLToPath(
      new URL("./submit-compact-commands.ts", import.meta.url),
    );
    const source = readFileSync(compactPath, "utf-8");
    // Both paths (the local trim and the cloud compaction) must finish the
    // context rewrite before the reminder is marked and reflection launches.
    const localTrimIndex = source.indexOf(
      "await backend.trimConversationToTopic({",
    );
    const cloudCompactIndex = source.indexOf(
      "await getBackend().compactConversationMessages(",
    );
    const afterIndex = source.lastIndexOf(
      "await afterCompaction(ctx, conversationId)",
    );
    // The reminder and the reflection launch belong to `afterCompaction`, so the
    // ordering is: context rewritten -> afterCompaction() -> mark -> reflect.
    const reminderIndex = source.indexOf(
      "markPostCompactionContextRemindersPending(",
    );
    const reflectionIndex = source.indexOf("launchReflectionArena({");

    expect(localTrimIndex).toBeGreaterThanOrEqual(0);
    expect(cloudCompactIndex).toBeGreaterThanOrEqual(0);
    expect(afterIndex).toBeGreaterThan(localTrimIndex);
    expect(afterIndex).toBeGreaterThan(cloudCompactIndex);
    expect(reminderIndex).toBeGreaterThanOrEqual(0);
    expect(reflectionIndex).toBeGreaterThan(reminderIndex);
    expect(source).toContain('triggerSource: "compaction-event"');

    const submitHandlerSource = readFileSync(
      fileURLToPath(new URL("./use-submit-handler.ts", import.meta.url)),
      "utf-8",
    );
    expect(submitHandlerSource).not.toContain(
      "queuePendingReflectionWorktreeReminders",
    );
    expect(submitHandlerSource).not.toContain(
      "pendingReflectionTrigger = true",
    );
  });

  test("successful TUI turns append user and assistant rows to the reflection transcript", () => {
    const submitHandlerPath = fileURLToPath(
      new URL("./use-submit-handler.ts", import.meta.url),
    );
    const conversationLoopPath = fileURLToPath(
      new URL("./use-conversation-loop.ts", import.meta.url),
    );
    const submitSource = readFileSync(submitHandlerPath, "utf-8");
    const loopSource = readFileSync(conversationLoopPath, "utf-8");

    expect(submitSource).toContain(
      "const transcriptStartLineIndex = userTextForInput",
    );
    expect(submitSource).toContain("transcriptStartLineIndex,");
    expect(loopSource).toContain("const transcriptTurnStartLineIndex =");
    expect(loopSource).toContain('if (stopReasonToHandle === "end_turn")');
    expect(loopSource).toContain("toLines(buffersRef.current).slice(");
    expect(loopSource).toContain("appendTranscriptDeltaJsonl(");

    expect(
      loopSource.indexOf('if (stopReasonToHandle === "end_turn")'),
    ).toBeLessThan(loopSource.indexOf("appendTranscriptDeltaJsonl("));
  });
});
