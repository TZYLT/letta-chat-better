import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { launchSubagent, spawnBackgroundSubagentTask } from "./task";

/**
 * T-03 / D-A: the Task tool exposes no way to put a Letta subagent on another
 * model. `model` survives only for the external coding CLIs, whose own
 * `--model` flag it feeds.
 */

const taskSchema = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../schemas/Task.json", import.meta.url)),
    "utf8",
  ),
) as { properties: Record<string, { description?: string }> };

describe("Task model argument", () => {
  test("advertises model as external-CLI-only and drops the tiering advice", () => {
    const description = taskSchema.properties.model?.description ?? "";
    expect(description).toContain("claude-code");
    expect(description).toContain("codex");
    expect(description).not.toContain("Prefer lighter models");
    expect(description).not.toContain("minimize cost and latency");
  });

  test.each([["general-purpose"], ["fork"], ["reflection"], ["memory"]])(
    "rejects model for the Letta subagent type %s",
    async (subagentType) => {
      const result = await launchSubagent({
        subagent_type: subagentType,
        prompt: "do the thing",
        description: "model rejection",
        model: "openai/gpt-5.5",
      } as never);

      expect(result.success).toBe(false);
      expect(result).toMatchObject({
        error: expect.stringContaining("inherit the parent conversation model"),
      });
    },
  );

  test("rejects model when deploying an existing agent", async () => {
    const result = await launchSubagent({
      agent_id: "agent-abc123",
      subagent_type: "general-purpose",
      prompt: "do the thing",
      description: "model rejection",
      model: "openai/gpt-5.5",
    } as never);

    expect(result.success).toBe(false);
    expect(result).toMatchObject({
      error: expect.stringContaining("inherit the parent conversation model"),
    });
  });
});

describe("subagent model plumbing", () => {
  function captureSpawn() {
    const calls: unknown[][] = [];
    return {
      calls,
      deps: {
        spawnSubagentImpl: async (...args: unknown[]) => {
          calls.push(args);
          return {
            agentId: "agent-child",
            conversationId: "conv-child",
            report: "ok",
            success: true,
          };
        },
      },
    };
  }

  test("forwards an exact harness model handle in the model slot", async () => {
    const { calls, deps } = captureSpawn();
    const { taskId } = spawnBackgroundSubagentTask({
      subagentType: "reflection",
      prompt: "reflect",
      description: "arena attempt",
      exactModelHandle: "openai/gpt-5.5",
      silentCompletion: true,
      deps,
    });

    expect(taskId).toBeTruthy();
    await Promise.resolve();
    expect(calls[0]?.[2]).toBe("openai/gpt-5.5");
  });

  test("passes no model for an ordinary subagent launch", async () => {
    const { calls, deps } = captureSpawn();
    spawnBackgroundSubagentTask({
      subagentType: "general-purpose",
      prompt: "do the thing",
      description: "ordinary launch",
      silentCompletion: true,
      deps,
    });

    await Promise.resolve();
    expect(calls[0]?.[2]).toBeUndefined();
  });
});
