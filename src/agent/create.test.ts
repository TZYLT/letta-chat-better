import { describe, expect, test } from "bun:test";
import {
  buildCreatedAgentTags,
  GIT_MEMORY_ENABLED_TAG,
  LETTA_CODE_ORIGIN_TAG,
  LETTA_CODE_SUBAGENT_TAG,
} from "@/agent/agent-tags";
import {
  resolveCreatedAgentMemfsConfig,
  resolveCreatedAgentSystemPrompt,
} from "@/agent/create";
import { buildSystemPrompt } from "@/agent/prompt-assets";

const localMemfsBackend = { localMemfs: true } as const;
const noMemfsBackend = { localMemfs: false } as const;

function countTags(tags: string[], tag: string): number {
  return tags.filter((candidate) => candidate === tag).length;
}

// These cases used to be driven by `{ localMemfs: false, remoteMemfs: true }`
// plus `isLettaCloud`, which modelled the removed API backend. That
// configuration cannot be constructed any more, so every case now starts from a
// backend that has local memfs (or none at all).
describe("created agent MemFS defaults", () => {
  test("defaults fresh local agents to the root MemFS layout", () => {
    expect(
      resolveCreatedAgentMemfsConfig({
        capabilities: localMemfsBackend,
      }),
    ).toEqual({ enableMemfs: true, memoryPromptMode: "root-memfs" });
  });

  test("maps an explicit legacy local mode to the root layout for fresh agents", () => {
    expect(
      resolveCreatedAgentMemfsConfig({
        capabilities: localMemfsBackend,
        requestedMemoryPromptMode: "local-memfs",
      }),
    ).toEqual({ enableMemfs: true, memoryPromptMode: "root-memfs" });
  });

  test("maps an explicit memfs request to the root layout", () => {
    expect(
      resolveCreatedAgentMemfsConfig({
        capabilities: localMemfsBackend,
        requestedMemoryPromptMode: "memfs",
      }),
    ).toEqual({ enableMemfs: true, memoryPromptMode: "root-memfs" });
  });

  test("subagents are stateless: no MemFS", () => {
    expect(
      resolveCreatedAgentMemfsConfig({
        capabilities: localMemfsBackend,
        isSubagent: true,
      }),
    ).toEqual({ enableMemfs: false, memoryPromptMode: "standard" });
  });

  test("ignores standard memory prompt mode for regular agents (no opt-out)", () => {
    expect(
      resolveCreatedAgentMemfsConfig({
        capabilities: localMemfsBackend,
        requestedMemoryPromptMode: "standard",
      }),
    ).toEqual({ enableMemfs: true, memoryPromptMode: "root-memfs" });
  });

  test("a backend without memfs support stays standard", () => {
    expect(
      resolveCreatedAgentMemfsConfig({ capabilities: noMemfsBackend }),
    ).toEqual({ enableMemfs: false, memoryPromptMode: "standard" });
  });

  test("an explicit memfs request enables git-backed memory without local memfs", () => {
    expect(
      resolveCreatedAgentMemfsConfig({
        capabilities: noMemfsBackend,
        requestedMemoryPromptMode: "memfs",
      }),
    ).toEqual({ enableMemfs: true, memoryPromptMode: "memfs" });
  });
});

describe("created agent system prompt defaults", () => {
  // This case used to assert `isLettaCloud: true` delegated to the server by
  // resolving `null`. The bundled default is always built here now.
  test("builds the bundled default prompt", async () => {
    await expect(
      resolveCreatedAgentSystemPrompt({
        memoryPromptMode: "memfs",
      }),
    ).resolves.toBe(buildSystemPrompt("default", "memfs"));
    await expect(
      resolveCreatedAgentSystemPrompt({
        systemPromptPreset: "default",
        memoryPromptMode: "memfs",
      }),
    ).resolves.toBe(buildSystemPrompt("default", "memfs"));
  });

  test("keeps explicit and named prompts client-owned", async () => {
    await expect(
      resolveCreatedAgentSystemPrompt({
        systemPromptCustom: "Custom prompt",
        memoryPromptMode: "memfs",
      }),
    ).resolves.toBe("Custom prompt");
    await expect(
      resolveCreatedAgentSystemPrompt({
        systemPromptCustom: "",
        memoryPromptMode: "memfs",
      }),
    ).resolves.toBe("");
    await expect(
      resolveCreatedAgentSystemPrompt({
        systemPromptPreset: "letta",
        memoryPromptMode: "memfs",
      }),
    ).resolves.toBe(buildSystemPrompt("letta", "memfs"));
    await expect(
      resolveCreatedAgentSystemPrompt({
        memoryPromptMode: "standard",
      }),
    ).resolves.toBe(buildSystemPrompt("default", "standard"));
  });
});

describe("created agent tags", () => {
  test("adds Letta Code origin and MemFS tags without dropping user tags", () => {
    const tags = buildCreatedAgentTags({
      tags: ["project:alpha", LETTA_CODE_ORIGIN_TAG, GIT_MEMORY_ENABLED_TAG],
      enableMemfs: true,
    });

    expect(tags).toEqual([
      LETTA_CODE_ORIGIN_TAG,
      GIT_MEMORY_ENABLED_TAG,
      "project:alpha",
    ]);
    expect(countTags(tags, LETTA_CODE_ORIGIN_TAG)).toBe(1);
    expect(countTags(tags, GIT_MEMORY_ENABLED_TAG)).toBe(1);
  });

  test("adds the subagent tag once", () => {
    const tags = buildCreatedAgentTags({
      tags: [LETTA_CODE_SUBAGENT_TAG, "purpose:review"],
      isSubagent: true,
      enableMemfs: true,
    });

    expect(tags).toEqual([
      LETTA_CODE_ORIGIN_TAG,
      LETTA_CODE_SUBAGENT_TAG,
      GIT_MEMORY_ENABLED_TAG,
      "purpose:review",
    ]);
    expect(countTags(tags, LETTA_CODE_SUBAGENT_TAG)).toBe(1);
  });

  test("does not add the MemFS tag when explicitly disabled", () => {
    const tags = buildCreatedAgentTags({
      tags: ["project:alpha"],
      enableMemfs: false,
    });

    expect(tags).toEqual([LETTA_CODE_ORIGIN_TAG, "project:alpha"]);
    expect(tags).not.toContain(GIT_MEMORY_ENABLED_TAG);
  });
});
