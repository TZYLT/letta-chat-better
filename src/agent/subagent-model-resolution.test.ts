import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import type { SubagentConfig } from "@/agent/subagents";
import {
  buildSubagentPrompt,
  estimateStartupContextTokens,
  REFLECTION_STARTUP_CONTEXT_TOKEN_LIMIT,
} from "@/agent/subagents/context-budget";
import {
  buildSubagentArgs,
  recallPromptForBackend,
  shouldPrependDeploySystemReminder,
} from "@/agent/subagents/manager";
import {
  resolveSubagentLauncher,
  resolveSubagentWorkingDirectory,
} from "@/agent/subagents/subagent-launcher";
import { getModelHandleFromAgent } from "@/agent/subagents/subagent-model";

describe("recallPromptForBackend", () => {
  test("uses separate API and local recall prompts", () => {
    const apiPrompt = recallPromptForBackend("api");
    const localPrompt = recallPromptForBackend("local");

    expect(apiPrompt).toContain("Semantic similarity search");
    expect(apiPrompt).not.toContain("transcript-backed exact text search");
    expect(localPrompt).toContain("transcript-backed full-text search");
    expect(localPrompt).toContain("Accessing the Underlying Files");
    expect(localPrompt).toContain("~/.haruyuki/lc-local-backend");
    expect(localPrompt).not.toContain("--mode <mode>");
    expect(localPrompt).not.toContain("Semantic similarity search");
  });
});

describe("shouldPrependDeploySystemReminder", () => {
  test("does not describe a same-agent conversation as coming from itself", () => {
    expect(
      shouldPrependDeploySystemReminder("agent-primary", "agent-primary"),
    ).toBe(false);
    expect(
      shouldPrependDeploySystemReminder("agent-worker", "agent-primary"),
    ).toBe(true);
  });
});

describe("resolveSubagentLauncher", () => {
  test("explicit launcher takes precedence over .ts script autodetection", () => {
    const launcher = resolveSubagentLauncher(["-p", "hi"], {
      env: {
        HARUYUKI_CODE_BIN: "custom-bun",
        HARUYUKI_CODE_BIN_ARGS_JSON: JSON.stringify(["run", "src/index.ts"]),
      } as NodeJS.ProcessEnv,
      argv: ["bun", "/tmp/dev-entry.ts"],
      execPath: "/opt/homebrew/bin/bun",
      platform: "darwin",
    });

    expect(launcher).toEqual({
      command: "custom-bun",
      args: ["run", "src/index.ts", "-p", "hi"],
    });
  });

  test("explicit launcher takes precedence over .js script autodetection", () => {
    const launcher = resolveSubagentLauncher(["-p", "hi"], {
      env: {
        HARUYUKI_CODE_BIN: "custom-node",
      } as NodeJS.ProcessEnv,
      argv: ["node", "/tmp/letta.js"],
      execPath: "/usr/local/bin/node",
      platform: "win32",
    });

    expect(launcher).toEqual({
      command: "custom-node",
      args: ["-p", "hi"],
    });
  });

  test("preserves existing .ts dev behavior for any ts entrypoint", () => {
    const launcher = resolveSubagentLauncher(
      ["--output-format", "stream-json"],
      {
        env: {} as NodeJS.ProcessEnv,
        argv: ["bun", "/tmp/custom-runner.ts"],
        execPath: "/opt/homebrew/bin/bun",
        platform: "darwin",
      },
    );

    expect(launcher).toEqual({
      command: "/opt/homebrew/bin/bun",
      args: ["/tmp/custom-runner.ts", "--output-format", "stream-json"],
    });
  });

  test("resolves relative dev entrypoint against launcher cwd", () => {
    const cwd =
      process.platform === "win32"
        ? path.win32.join("C:\\", "Users", "example", "dev", "letta-code-prod")
        : path.posix.join("/", "Users", "example", "dev", "letta-code-prod");
    const expectedScriptPath =
      process.platform === "win32"
        ? path.win32.join(cwd, "src", "index.ts")
        : path.posix.join(cwd, "src", "index.ts");
    const execPath =
      process.platform === "win32"
        ? "C:\\bun\\bun.exe"
        : "/opt/homebrew/bin/bun";

    const launcher = resolveSubagentLauncher(
      ["--output-format", "stream-json"],
      {
        env: {} as NodeJS.ProcessEnv,
        argv: ["bun", "src/index.ts"],
        execPath,
        platform: process.platform,
        cwd,
      },
    );

    expect(launcher).toEqual({
      command: execPath,
      args: [
        "--loader=.md:text",
        "--loader=.mdx:text",
        "--loader=.txt:text",
        "run",
        expectedScriptPath,
        "--output-format",
        "stream-json",
      ],
    });
  });

  test("uses node runtime for bundled js on win32", () => {
    const launcher = resolveSubagentLauncher(["-p", "prompt"], {
      env: {} as NodeJS.ProcessEnv,
      argv: ["node", "C:\\Program Files\\Letta\\letta.js"],
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
    });

    expect(launcher).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\Program Files\\Letta\\letta.js", "-p", "prompt"],
    });
  });

  test("keeps direct js spawn behavior on non-win32", () => {
    const launcher = resolveSubagentLauncher(["-p", "prompt"], {
      env: {} as NodeJS.ProcessEnv,
      argv: ["node", "/usr/local/lib/letta.js"],
      execPath: "/usr/local/bin/node",
      platform: "linux",
    });

    expect(launcher).toEqual({
      command: "/usr/local/lib/letta.js",
      args: ["-p", "prompt"],
    });
  });

  test("falls back to global letta when no launcher hints available", () => {
    const launcher = resolveSubagentLauncher(["-p", "prompt"], {
      env: {} as NodeJS.ProcessEnv,
      argv: ["node", ""],
      execPath: "/usr/local/bin/node",
      platform: "linux",
    });

    expect(launcher).toEqual({
      command: "letta",
      args: ["-p", "prompt"],
    });
  });

  test("keeps explicit launcher with spaces as a single command token", () => {
    const launcher = resolveSubagentLauncher(
      ["--output-format", "stream-json"],
      {
        env: {
          HARUYUKI_CODE_BIN:
            '"C:\\Users\\Example User\\AppData\\Roaming\\npm\\letta.cmd"',
        } as NodeJS.ProcessEnv,
        argv: ["node", "C:\\Program Files\\Letta\\letta.js"],
        execPath: "C:\\Program Files\\nodejs\\node.exe",
        platform: "win32",
      },
    );

    expect(launcher).toEqual({
      command: "C:\\Users\\Example User\\AppData\\Roaming\\npm\\letta.cmd",
      args: ["--output-format", "stream-json"],
    });
  });
});

describe("resolveSubagentWorkingDirectory", () => {
  test("prefers USER_CWD when present", () => {
    const cwd = resolveSubagentWorkingDirectory(
      {
        USER_CWD: "/tmp/fixture-dir",
      } as NodeJS.ProcessEnv,
      "/tmp/repo-root",
    );

    expect(cwd).toBe("/tmp/fixture-dir");
  });

  test("falls back to process cwd when USER_CWD is absent", () => {
    const cwd = resolveSubagentWorkingDirectory(
      {} as NodeJS.ProcessEnv,
      "/tmp/repo-root",
    );

    expect(cwd).toBe("/tmp/repo-root");
  });

  test("reflection subagents with the memory-subagent profile run from the inherited parent memory root", () => {
    const cwd = resolveSubagentWorkingDirectory(
      {
        USER_CWD: "/tmp/project-root",
      } as NodeJS.ProcessEnv,
      "/tmp/fallback-root",
      {
        subagentType: "reflection",
        launchProfile: "memory-subagent",
        inheritedPrimaryRoot:
          "/Users/test/.haruyuki/agents/agent-parent/memory",
      },
    );

    expect(cwd).toBe("/Users/test/.haruyuki/agents/agent-parent/memory");
  });

  test("reflection subagents with memoryScope run from USER_CWD while MEMORY_DIR points at the worktree", () => {
    const cwd = resolveSubagentWorkingDirectory(
      {
        USER_CWD: "/tmp/project-root",
      } as NodeJS.ProcessEnv,
      "/tmp/fallback-root",
      {
        subagentType: "reflection",
        launchProfile: "memory-subagent",
        inheritedPrimaryRoot:
          "/Users/test/.haruyuki/agents/agent-parent/memory",
        memoryScope: {
          primaryRoot:
            "/Users/test/.haruyuki/agents/agent-parent/memory-worktrees/reflection-123",
          writableRoots: [
            "/Users/test/.haruyuki/agents/agent-parent/memory-worktrees/reflection-123",
          ],
        },
      },
    );

    expect(cwd).toBe("/tmp/project-root");
  });

  test("reflection integration agents run directly from their memory worktree", () => {
    const worktree =
      "/Users/test/.haruyuki/agents/agent-parent/memory-worktrees/reflection-123";
    const cwd = resolveSubagentWorkingDirectory(
      { USER_CWD: "/tmp/project-root" } as NodeJS.ProcessEnv,
      "/tmp/fallback-root",
      {
        subagentType: "general-purpose",
        launchProfile: "memory-subagent",
        memoryScope: {
          primaryRoot: worktree,
          writableRoots: [worktree],
        },
      },
    );

    expect(cwd).toBe(worktree);
  });

  test("non-reflection subagents still prefer USER_CWD", () => {
    const cwd = resolveSubagentWorkingDirectory(
      {
        USER_CWD: "/tmp/project-root",
      } as NodeJS.ProcessEnv,
      "/tmp/fallback-root",
      {
        subagentType: "general-purpose",
        launchProfile: "memory-subagent",
        inheritedPrimaryRoot:
          "/Users/test/.haruyuki/agents/agent-parent/memory",
      },
    );

    expect(cwd).toBe("/tmp/project-root");
  });
});

describe("buildSubagentArgs", () => {
  const baseConfig: SubagentConfig = {
    name: "test-subagent",
    description: "test",
    systemPrompt: "test prompt",
    allowedTools: "all",
    skills: [],
    fork: false,
    launchProfile: "default",
  };

  test("does not pass --no-memfs (statelessness derives from subagent role env)", () => {
    const args = buildSubagentArgs("test-subagent", baseConfig, null, "hello");

    expect(args).not.toContain("--no-memfs");
    expect(args).toContain("--new-agent");
  });

  test("tags new subagents with type and combines parent into one --tags value", () => {
    const args = buildSubagentArgs(
      "explore",
      baseConfig,
      null,
      "hello",
      undefined,
      undefined,
      undefined,
      { parentAgentId: "agent-parent-123" },
    );

    const tagFlagCount = args.filter((a) => a === "--tags").length;
    expect(tagFlagCount).toBe(1);
    const tagsValue = args[args.indexOf("--tags") + 1];
    expect(tagsValue).toBe("type:explore,parent:agent-parent-123");
  });

  test("omits parent tag when no parentAgentId is provided", () => {
    const args = buildSubagentArgs("explore", baseConfig, null, "hello");

    const tagsValue = args[args.indexOf("--tags") + 1];
    expect(tagsValue).toBe("type:explore");
  });

  test("threads the computer selector through as --computer", () => {
    const args = buildSubagentArgs(
      "explore",
      baseConfig,
      null,
      "hello",
      undefined,
      undefined,
      undefined,
      { environment: "office-mac" },
    );

    expect(args[args.indexOf("--computer") + 1]).toBe("office-mac");
    // The child submits and exits; the parent follows the remote turn.
    expect(args).toContain("--no-wait");
  });

  test("omits --computer and --no-wait by default", () => {
    const args = buildSubagentArgs("explore", baseConfig, null, "hello");

    expect(args).not.toContain("--computer");
    expect(args).not.toContain("--no-wait");
  });

  test("does not tag when deploying an existing agent (fork/recall)", () => {
    const args = buildSubagentArgs(
      "fork",
      baseConfig,
      null,
      "hello",
      "agent-existing",
      undefined,
      undefined,
      { parentAgentId: "agent-parent-123" },
    );

    expect(args).not.toContain("--tags");
  });

  test("passes --backend local for local backend subagents", () => {
    const args = buildSubagentArgs(
      "test-subagent",
      baseConfig,
      null,
      "hello",
      undefined,
      undefined,
      undefined,
      { backendMode: "local" },
    );

    expect(args).toContain("--backend");
    expect(args).toContain("local");
    expect(args).not.toContain("--no-memfs");
  });

  test("deploys existing subagent agents without --new-agent (keeps memfs)", () => {
    const args = buildSubagentArgs(
      "test-subagent",
      baseConfig,
      null,
      "hello",
      "agent-existing",
    );

    expect(args).toContain("--agent");
    expect(args).not.toContain("--new-agent");
    expect(args).not.toContain("--no-memfs");
  });

  test("subagents always use unrestricted permission mode", () => {
    const args = buildSubagentArgs(
      "test-subagent",
      {
        ...baseConfig,
        launchProfile: "memory-subagent",
      },
      null,
      "hello",
    );

    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("unrestricted");
  });

  test("caps reflection system prompt plus initial message to startup budget", () => {
    const systemPrompt = "system ".repeat(1_000);
    const memoryPreview = `<parent_memory>\n<memory_filesystem>\n/memory/\n└── system/\n</memory_filesystem>\n${"memory ".repeat(40_000)}\n</parent_memory>`;
    const userPrompt = `Review transcript at /tmp/payload.json\n\n${memoryPreview}`;

    const args = buildSubagentArgs(
      "reflection",
      { ...baseConfig, name: "reflection", systemPrompt },
      null,
      userPrompt,
    );
    const promptArg = args[args.indexOf("-p") + 1] ?? "";

    expect(
      estimateStartupContextTokens(`${systemPrompt}\n${promptArg}`),
    ).toBeLessThanOrEqual(REFLECTION_STARTUP_CONTEXT_TOKEN_LIMIT);
    expect(promptArg).toContain("Review transcript at /tmp/payload.json");
    expect(promptArg).toContain("<parent_memory>");
    expect(promptArg).toContain("<memory_filesystem>");
    expect(promptArg).toContain("Reflection startup context truncated");
    expect(promptArg.length).toBeLessThan(userPrompt.length);
  });

  test("can pass subagent prompt by stdin without leaking prompt text into argv", () => {
    const longPrompt = "prompt ".repeat(40_000);

    const args = buildSubagentArgs(
      "general-purpose",
      baseConfig,
      null,
      longPrompt,
      undefined,
      undefined,
      undefined,
      { promptTransport: "stdin" },
    );

    expect(args).not.toContain("--prompt-file");
    expect(args).not.toContain("-p");
    expect(args).not.toContain(longPrompt);
  });

  test("buildSubagentPrompt preserves reflection startup budget before stdin transport", () => {
    const systemPrompt = "system ".repeat(1_000);
    const memoryPreview = `<parent_memory>\n<memory_filesystem>\n/memory/\n└── system/\n</memory_filesystem>\n${"memory ".repeat(40_000)}\n</parent_memory>`;
    const userPrompt = `Review transcript via $TRANSCRIPT_PATH\n\n${memoryPreview}`;

    const prompt = buildSubagentPrompt(
      "reflection",
      { ...baseConfig, name: "reflection", systemPrompt },
      userPrompt,
    );

    expect(
      estimateStartupContextTokens(`${systemPrompt}\n${prompt}`),
    ).toBeLessThanOrEqual(REFLECTION_STARTUP_CONTEXT_TOKEN_LIMIT);
    expect(prompt).toContain("Review transcript via $TRANSCRIPT_PATH");
    expect(prompt).toContain("Reflection startup context truncated");
  });

  test("does not cap non-reflection initial messages", () => {
    const longPrompt = "prompt ".repeat(40_000);
    const args = buildSubagentArgs(
      "general-purpose",
      baseConfig,
      null,
      longPrompt,
    );
    const promptArg = args[args.indexOf("-p") + 1] ?? "";

    expect(promptArg).toBe(longPrompt);
  });

  test("injects --no-system-info-reminder and --no-skills for non-Windows reflection subagents", () => {
    const args = buildSubagentArgs(
      "reflection",
      { ...baseConfig, name: "reflection" },
      null,
      "hello",
      undefined,
      undefined,
      undefined,
      { platform: "linux" },
    );

    expect(args).toContain("--no-system-info-reminder");
    expect(args).toContain("--no-skills");
  });

  test("keeps the Windows environment reminder for reflection subagents", () => {
    const args = buildSubagentArgs(
      "reflection",
      { ...baseConfig, name: "reflection" },
      null,
      "hello",
      undefined,
      undefined,
      undefined,
      { platform: "win32" },
    );

    expect(args).not.toContain("--no-system-info-reminder");
    expect(args).toContain("--no-skills");
  });

  test("does not inject reflection-only flags for other subagent types", () => {
    const args = buildSubagentArgs(
      "general-purpose",
      baseConfig,
      null,
      "hello",
    );

    expect(args).not.toContain("--no-system-info-reminder");
    expect(args).not.toContain("--no-skills");
  });

  test("does not inject reflection-only flags when deploying an existing reflection agent", () => {
    const args = buildSubagentArgs(
      "reflection",
      { ...baseConfig, name: "reflection" },
      null,
      "hello",
      "agent-existing-reflection",
    );

    expect(args).not.toContain("--no-system-info-reminder");
    expect(args).not.toContain("--no-skills");
  });

  test.each([["reflection"], ["memory"], ["init"]])(
    "injects --base-tools none for %s subagents",
    (type) => {
      const args = buildSubagentArgs(
        type,
        { ...baseConfig, name: type },
        null,
        "hello",
      );

      const idx = args.indexOf("--base-tools");
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(args[idx + 1]).toBe("none");
    },
  );

  test("does not inject --base-tools for general-purpose subagents", () => {
    const args = buildSubagentArgs(
      "general-purpose",
      baseConfig,
      null,
      "hello",
    );

    expect(args).not.toContain("--base-tools");
  });

  test("does not inject --base-tools when deploying an existing reflection agent", () => {
    const args = buildSubagentArgs(
      "reflection",
      { ...baseConfig, name: "reflection" },
      null,
      "hello",
      "agent-existing-reflection",
    );

    // --base-tools requires --new and only applies to fresh agent creation.
    expect(args).not.toContain("--base-tools");
  });
  test("adds MessageChannel to fork subagent scoped tools when inheriting a channel tool context", () => {
    const args = buildSubagentArgs(
      "fork",
      {
        ...baseConfig,
        name: "fork",
        fork: true,
        allowedTools: ["Bash", "Read"],
      },
      null,
      "hello",
      undefined,
      undefined,
      undefined,
      { extraTools: ["MessageChannel"] },
    );

    const idx = args.indexOf("--tools");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]?.split(",")).toEqual([
      "Bash",
      "Read",
      "MessageChannel",
    ]);
  });
});

describe("getModelHandleFromAgent", () => {
  test("prefers top-level provider-qualified model handles for local backend agents", () => {
    expect(
      getModelHandleFromAgent({
        model: "ollama/llama3.1:8b",
        llm_config: {
          model_endpoint_type: "openai",
          model: "ollama/llama3.1:8b",
        },
      }),
    ).toBe("ollama/llama3.1:8b");
  });

  test("reconstructs provider-qualified handles from model settings", () => {
    expect(
      getModelHandleFromAgent({
        model: "llama3.1:8b",
        model_settings: { provider_type: "ollama" },
      }),
    ).toBe("ollama/llama3.1:8b");
  });

  test("falls back to llm_config endpoint and model for server agents", () => {
    expect(
      getModelHandleFromAgent({
        llm_config: {
          model_endpoint_type: "anthropic",
          model: "claude-sonnet-4-6",
        },
      }),
    ).toBe("anthropic/claude-sonnet-4-6");
  });
});
