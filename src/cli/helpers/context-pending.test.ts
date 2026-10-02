import { describe, expect, test } from "bun:test";
import type { ContextPendingReport } from "@/backend/local/prefix-freeze";
import { formatContextPendingReport } from "@/cli/helpers/context-pending";

function report(
  overrides: Partial<ContextPendingReport> = {},
): ContextPendingReport {
  return {
    hasSnapshot: true,
    memory: { unappliedCommits: [], diffStat: "" },
    systemChanged: false,
    skillsChanged: false,
    tools: { added: [], removed: [], changed: false },
    model: { changed: false },
    modelSettingsChanged: false,
    dirty: false,
    hasPending: false,
    ...overrides,
  };
}

describe("formatContextPendingReport", () => {
  test("reports no pending changes when nothing drifted", () => {
    expect(formatContextPendingReport(report())).toBe(
      "No pending prefix changes.",
    );
  });

  test("explains that a missing snapshot will be compiled next turn", () => {
    const output = formatContextPendingReport(report({ hasSnapshot: false }));
    expect(output).toContain("No frozen prefix snapshot");
    expect(output).toContain("next turn");
  });

  test("lists unapplied memory commits with a diff stat and the full hint", () => {
    const output = formatContextPendingReport(
      report({
        hasPending: true,
        memory: {
          unappliedCommits: ["abc123 add note", "def456 drop note"],
          diffStat: " note.md | 2 +-",
        },
      }),
    );
    expect(output).toContain("Pending prefix changes");
    expect(output).toContain("memory: 2 unapplied commit(s)");
    expect(output).toContain("abc123 add note");
    expect(output).toContain("/context-pending full");
    expect(output).toContain("/recompile to apply");
  });

  test("includes the full diff instead of the hint when requested", () => {
    const output = formatContextPendingReport(
      report({
        hasPending: true,
        memory: {
          unappliedCommits: ["abc123 add note"],
          diffStat: " note.md | 1 +",
          fullDiff: "-old\n+new",
        },
      }),
      { full: true },
    );
    expect(output).toContain("+new");
    expect(output).not.toContain("/context-pending full");
  });

  test("marks each drift source and the tool delta", () => {
    const output = formatContextPendingReport(
      report({
        hasPending: true,
        systemChanged: true,
        skillsChanged: true,
        tools: {
          added: ["NewTool"],
          removed: ["OldTool"],
          changed: true,
        },
        model: { applied: "anthropic/a", live: "anthropic/b", changed: true },
        modelSettingsChanged: true,
      }),
    );
    expect(output).toContain("agent.system: changed");
    expect(output).toContain("skills: changed");
    expect(output).toContain("tools: changed (+1/-1)");
    expect(output).toContain("added: NewTool");
    expect(output).toContain("removed: OldTool");
    expect(output).toContain("model: anthropic/a -> anthropic/b");
    expect(output).toContain("model settings: changed");
  });

  test("appends a dirty notice without counting it as pending", () => {
    const output = formatContextPendingReport(report({ dirty: true }));
    expect(output).toContain("No pending prefix changes.");
    expect(output).toContain("uncommitted memory changes");
  });
});
