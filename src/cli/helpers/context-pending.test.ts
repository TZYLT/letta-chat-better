import { describe, expect, test } from "bun:test";
import type { ContextPendingReport } from "@/backend/local/prefix-freeze";
import {
  formatAppliedPendingSummary,
  formatContextPendingReport,
  formatModelRegistrationNotice,
} from "@/cli/helpers/context-pending";

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

  test("says so when the memory repo is unreachable instead of claiming no changes", () => {
    const output = formatContextPendingReport(
      report({
        memory: { unappliedCommits: [], diffStat: "", reachable: false },
      }),
    );
    expect(output).toContain("memory repo unreachable");
    expect(output).toContain("unknown");
    expect(output).toContain("unchanged");
  });

  test("reports unknown memory alongside real drift", () => {
    const output = formatContextPendingReport(
      report({
        hasPending: true,
        systemChanged: true,
        memory: { unappliedCommits: [], diffStat: "", reachable: false },
      }),
    );
    expect(output).toContain("Pending prefix changes");
    expect(output).toContain("agent.system: changed");
    expect(output).toContain("memory repo unreachable");
  });

  test("stays quiet when memory is not in play", () => {
    const output = formatContextPendingReport(report());
    expect(output).not.toContain("unreachable");
  });
});

describe("formatAppliedPendingSummary", () => {
  test("says nothing when the backend has no prefix freeze", () => {
    expect(formatAppliedPendingSummary(undefined)).toBeUndefined();
  });

  test("reports nothing pending", () => {
    expect(formatAppliedPendingSummary(report())).toBe("Nothing was pending.");
  });

  test("counts every applied category", () => {
    const summary = formatAppliedPendingSummary(
      report({
        hasPending: true,
        memory: {
          unappliedCommits: ["abc add note", "def drop note"],
          diffStat: "",
        },
        systemChanged: true,
        skillsChanged: true,
        tools: { added: ["NewTool"], removed: ["OldTool"], changed: true },
        model: { applied: "anthropic/a", live: "anthropic/b", changed: true },
        modelSettingsChanged: true,
      }),
    );
    expect(summary).toBe(
      "Applied: 2 memory commit(s), agent.system change, skills change, tool declarations (+1/-1), model change, model settings change.",
    );
  });

  test("never counts uncommitted working-tree changes as applied", () => {
    expect(formatAppliedPendingSummary(report({ dirty: true }))).toBe(
      "Nothing was pending.",
    );
  });
});

describe("formatModelRegistrationNotice", () => {
  test("stays quiet without a snapshot, since the next turn compiles fresh", () => {
    expect(
      formatModelRegistrationNotice(
        report({ hasSnapshot: false, model: { changed: true } }),
      ),
    ).toBeUndefined();
  });

  test("stays quiet when the model did not change", () => {
    expect(formatModelRegistrationNotice(report())).toBeUndefined();
  });

  test("points at the application points after a registered model change", () => {
    const notice = formatModelRegistrationNotice(
      report({
        model: { applied: "anthropic/a", live: "anthropic/b", changed: true },
      }),
    );
    expect(notice).toContain("/recompile");
    expect(notice).toContain("compaction");
  });

  test("also fires for a model-settings-only change", () => {
    expect(
      formatModelRegistrationNotice(report({ modelSettingsChanged: true })),
    ).toContain("/recompile");
  });
});
