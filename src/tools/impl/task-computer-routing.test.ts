import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setCurrentAgentId } from "@/agent/context";
import { clearAllSubagents, updateSubagent } from "@/agent/subagent-state";
import type { SubagentConfig, SubagentResult } from "@/agent/subagents";
import type { spawnSubagent } from "@/agent/subagents/manager";
import { __testSetBackend, type Backend } from "@/backend";
import { backgroundTasks } from "./process_manager";

// Replace discovery and the child-process boundary, not task() or its background
// helper. This file runs in a fresh process via isolated-unit-tests.json.
const config: SubagentConfig = {
  name: "general-purpose",
  description: "Routing fixture",
  systemPrompt: "Routing fixture",
  allowedTools: "all",
  skills: [],
  fork: false,
  launchProfile: "default",
};
mock.module("@/agent/subagents", () => ({
  getAllSubagentConfigs: async () => ({
    "general-purpose": config,
    fork: { ...config, name: "fork", fork: true },
    memory: { ...config, name: "memory" },
  }),
  clearSubagentConfigCache: () => {},
  discoverSubagents: async () => ({
    subagents: [],
    errors: [],
    warnings: [],
  }),
}));

const spawn = mock(
  (
    ...[
      _type,
      _prompt,
      _exactModelHandle,
      subagentId,
      _signal,
      _existingAgentId,
      _existingConversationId,
      _maxTurns,
      _forkedContext,
      _parentAgentId,
      _transcriptPath,
      _parentConversationId,
      _memoryScope,
      _systemPromptOverride,
      _environment,
    ]: Parameters<typeof spawnSubagent>
  ) => {
    updateSubagent(subagentId, {
      agentId: "agent-routing-child",
      agentURL: "https://example.invalid/agent-routing-child",
    });
    // Model a still-running child. No timers, completion hooks, or remote calls
    // are needed to observe the launch contract; afterEach clears its local state.
    return new Promise<SubagentResult>(() => {});
  },
);
mock.module("@/agent/subagents/manager", () => ({ spawnSubagent: spawn }));

const { task } = await import("./task");
const forkConversation = mock(async () => {
  throw new Error("Unexpected fork of parent conversation");
});
const retrieveAgent = mock(async () => ({ model: "anthropic/test-model" }));
let scratchpad: string;
let previousScratchpad: string | undefined;

beforeEach(() => {
  spawn.mockClear();
  forkConversation.mockClear();
  retrieveAgent.mockClear();
  __testSetBackend({
    forkConversation,
    retrieveAgent,
  } as unknown as Backend);
  setCurrentAgentId("agent-routing-parent");
  previousScratchpad = process.env.LETTA_SCRATCHPAD;
  scratchpad = mkdtempSync(join(tmpdir(), "task-computer-routing-"));
  process.env.LETTA_SCRATCHPAD = scratchpad;
});

afterEach(() => {
  backgroundTasks.clear();
  clearAllSubagents();
  setCurrentAgentId(null);
  __testSetBackend(null);
  if (previousScratchpad === undefined) {
    delete process.env.LETTA_SCRATCHPAD;
  } else {
    process.env.LETTA_SCRATCHPAD = previousScratchpad;
  }
  rmSync(scratchpad, { recursive: true, force: true });
});

afterAll(() => {
  mock.restore();
});

const launchArgs = {
  subagent_type: "general-purpose",
  prompt: "Check routing without executing a child",
  description: "Routing contract",
};

describe("task computer routing", () => {
  // A padded selector used to be trimmed and forwarded to a connected computer.
  // No backend has connected computers now, so the same input is rejected —
  // and it must be rejected before anything is spawned or forked.
  test.each(["general-purpose", "fork"])(
    "rejects a named computer before spawning or forking %s",
    async (subagent_type) => {
      const result = await task({
        ...launchArgs,
        subagent_type,
        computer: " \t office-mac \n",
      });

      expect(result).toContain(
        "Error: The computer option requires a Letta Cloud backend.",
      );
      expect(result).toContain("omit the computer field");
      expect(spawn).not.toHaveBeenCalled();
      expect(forkConversation).not.toHaveBeenCalled();
      expect(retrieveAgent).not.toHaveBeenCalled();
      expect(backgroundTasks.size).toBe(0);
    },
  );

  test("rejects remote memory workers before launch", async () => {
    const result = await task({
      ...launchArgs,
      subagent_type: "memory",
      computer: " office-mac ",
    });
    expect(result).toContain("Memory workers must run on the current machine");
    expect(spawn).not.toHaveBeenCalled();
    expect(forkConversation).not.toHaveBeenCalled();
    expect(retrieveAgent).not.toHaveBeenCalled();
    expect(backgroundTasks.size).toBe(0);
  });

  // An omitted or blank `computer` is "run on the current machine", which is the
  // only remaining destination.
  test.each([undefined, "", " \t\n "])(
    "keeps the default computer for %j",
    async (computer) => {
      const result = await task({
        ...launchArgs,
        ...(computer === undefined ? {} : { computer }),
      });

      expect(result).toContain("Task running in background with task ID:");
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(backgroundTasks.size).toBe(1);
    },
  );
});
