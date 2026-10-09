import { afterEach, describe, expect, test } from "bun:test";
import { checkPermission } from "./checker";
import { permissionMode } from "./mode";
import { isReadOnlyShellCommand } from "./read-only-shell";

describe("haruyuki CLI commands", () => {
  test("allows haruyuki memory tokens", () => {
    expect(isReadOnlyShellCommand("haruyuki memory tokens")).toBe(true);
  });

  test("allows haruyuki memory tokens with flags", () => {
    expect(
      isReadOnlyShellCommand("haruyuki memory tokens --quiet --format json"),
    ).toBe(true);
    expect(
      isReadOnlyShellCommand(
        "haruyuki memory tokens --memory-dir /tmp/mem --top 10",
      ),
    ).toBe(true);
  });

  test("allows haruyuki memory help", () => {
    expect(isReadOnlyShellCommand("haruyuki memory help")).toBe(true);
  });

  test("blocks unknown haruyuki memory action", () => {
    // restore/backup/pull/diff mutate state — not in read-only allowlist
    expect(isReadOnlyShellCommand("haruyuki memory restore")).toBe(false);
    expect(isReadOnlyShellCommand("haruyuki memory pull")).toBe(false);
    expect(isReadOnlyShellCommand("haruyuki memory delete")).toBe(false);
  });

  test("blocks haruyuki memory with no action", () => {
    expect(isReadOnlyShellCommand("haruyuki memory")).toBe(false);
  });

  test("blocks unknown haruyuki group", () => {
    expect(isReadOnlyShellCommand("haruyuki install plugin")).toBe(false);
    expect(isReadOnlyShellCommand("haruyuki doctor")).toBe(false);
    expect(
      isReadOnlyShellCommand("haruyuki blocks list --agent agent-123"),
    ).toBe(false);
  });

  test("allows legacy haruyuki memfs alias", () => {
    expect(isReadOnlyShellCommand("haruyuki memfs tokens")).toBe(true);
  });

  test("allows haruyuki memory tokens piped to a safe command", () => {
    expect(
      isReadOnlyShellCommand("haruyuki memory tokens --format json | head -5"),
    ).toBe(true);
  });
});

describe("explicit Letta backend selection", () => {
  test.each(["local", "api", "cloud"])(
    "allows evidence commands with backend %s",
    (backend) => {
      for (const selection of [
        `--backend ${backend}`,
        `--backend=${backend}`,
      ]) {
        for (const command of [
          "messages list --agent agent-target --conversation conv-target --limit 30 --include-errors",
          'messages search --agent agent-target --query "forgot instructions"',
          "steps trace --agent agent-target --step step-1",
          "memory tokens --format json",
          "memfs status",
          "agents list",
        ]) {
          expect(
            isReadOnlyShellCommand(`haruyuki ${selection} ${command}`),
          ).toBe(true);
        }
      }
    },
  );

  test.each([
    'haruyuki --backend "api" messages list',
    'haruyuki --backend="local" messages list',
    "haruyuki messages --backend local list",
    "haruyuki messages list --backend=api",
    "haruyuki --backend local messages list --backend cloud",
    "haruyuki --backend local messages list | head -5",
  ])("allows supported backend placement and quoting: %s", (command) => {
    expect(isReadOnlyShellCommand(command)).toBe(true);
  });

  test.each([
    "haruyuki --backend",
    "haruyuki --backend local",
    "haruyuki --backend messages list",
    "haruyuki --backend= messages list",
    "haruyuki --backend invalid messages list",
    "haruyuki --backend local messages list --backend invalid",
    "haruyuki --backend local --yolo messages list",
    "haruyuki --backend local memory pull",
    "haruyuki --backend api steps delete --step step-1",
    "haruyuki --backend local messages transcript --out transcript.json",
    "haruyuki --backend local messages list > messages.json",
    "haruyuki --backend local messages list >> messages.json",
    "haruyuki --backend local messages list && touch output.txt",
    "haruyuki --backend local messages list | sh",
    "haruyuki --backend $(touch output.txt) messages list",
    "haruyuki --backend `touch output.txt` messages list",
  ])("does not auto-allow invalid or unsafe commands: %s", (command) => {
    expect(isReadOnlyShellCommand(command)).toBe(false);
  });
});

describe("Letta evidence tool permissions", () => {
  const command = "haruyuki --backend local messages list --agent agent-target";
  const emptyRules = { allow: [], deny: [], ask: [] };

  afterEach(() => permissionMode.reset());

  test.each(["Bash", "shell_command", "ShellCommand", "exec_command"])(
    "auto-allows evidence through %s in standard mode",
    (toolName) => {
      permissionMode.setMode("standard");
      const args = toolName === "exec_command" ? { cmd: command } : { command };
      expect(checkPermission(toolName, args, emptyRules)).toMatchObject({
        decision: "allow",
        reason: "Read-only shell command",
      });
    },
  );

  test("preserves strict mode and explicit permission rules", () => {
    permissionMode.setMode("strict");
    expect(checkPermission("Bash", { command }, emptyRules).decision).toBe(
      "ask",
    );
    permissionMode.setMode("standard");
    for (const decision of ["deny", "alwaysAsk"] as const) {
      const rules = { ...emptyRules, [decision]: ["Bash(haruyuki:*)"] };
      expect(checkPermission("Bash", { command }, rules).decision).toBe(
        decision,
      );
    }
  });
});
