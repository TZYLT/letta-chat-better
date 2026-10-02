import { getBackend } from "@/backend";
import type { ContextPendingReport } from "@/backend/local/prefix-freeze";

/**
 * `/context-pending` — show the prefix changes that have been registered but not
 * yet applied. Read-only: it never rewrites the frozen prefix. Local-backend
 * only (cloud backends have no applied client-side snapshot to compare).
 */
interface ContextPendingCapable {
  getContextPending(
    conversationId: string,
    agentId: string,
    options?: { full?: boolean },
  ): Promise<ContextPendingReport>;
}

function isContextPendingCapable(
  backend: unknown,
): backend is ContextPendingCapable {
  return (
    typeof backend === "object" &&
    backend !== null &&
    typeof (backend as { getContextPending?: unknown }).getContextPending ===
      "function"
  );
}

function indentBlock(text: string, prefix = "  "): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

export function formatContextPendingReport(
  report: ContextPendingReport,
  options: { full?: boolean } = {},
): string {
  if (!report.hasSnapshot) {
    return [
      "No frozen prefix snapshot for this conversation.",
      "The next turn will compile one from the latest committed state.",
    ].join("\n");
  }

  const sections: string[] = [];

  if (report.memory.unappliedCommits.length > 0) {
    const memoryLines = [
      `memory: ${report.memory.unappliedCommits.length} unapplied commit(s)`,
    ];
    if (report.memory.diffStat) memoryLines.push(report.memory.diffStat);
    memoryLines.push("commits:");
    for (const commit of report.memory.unappliedCommits) {
      memoryLines.push(`  ${commit}`);
    }
    if (options.full && report.memory.fullDiff) {
      memoryLines.push("diff:", report.memory.fullDiff);
    } else if (!options.full) {
      memoryLines.push("(run /context-pending full for the full diff)");
    }
    sections.push(memoryLines.join("\n"));
  }

  if (report.systemChanged) sections.push("agent.system: changed");
  if (report.skillsChanged) sections.push("skills: changed");
  if (report.tools.changed) {
    const parts = [
      `tools: changed (+${report.tools.added.length}/-${report.tools.removed.length})`,
    ];
    if (report.tools.added.length > 0) {
      parts.push(`  added: ${report.tools.added.join(", ")}`);
    }
    if (report.tools.removed.length > 0) {
      parts.push(`  removed: ${report.tools.removed.join(", ")}`);
    }
    sections.push(parts.join("\n"));
  }
  if (report.model.changed) {
    sections.push(`model: ${report.model.applied} -> ${report.model.live}`);
  }
  if (report.modelSettingsChanged) sections.push("model settings: changed");

  const dirtyNotice = report.dirty
    ? "Working tree has uncommitted memory changes (not applied until committed)."
    : undefined;

  if (!report.hasPending) {
    const body =
      sections.length === 0
        ? "No pending prefix changes."
        : sections.join("\n");
    return dirtyNotice ? `${body}\n${dirtyNotice}` : body;
  }

  const output = [
    "Pending prefix changes (not yet applied):",
    indentBlock(sections.join("\n")),
    "",
    "Run /recompile to apply now (evicts cache), or wait for compaction / a new conversation.",
  ];
  if (dirtyNotice) output.push(dirtyNotice);
  return output.join("\n");
}

export async function runContextPendingCommand(input: {
  conversationId: string | null;
  agentId: string;
  full: boolean;
}): Promise<string> {
  const backend = getBackend();
  if (!isContextPendingCapable(backend)) {
    return "Context prefix freeze is only available on the local backend.";
  }
  const report = await backend.getContextPending(
    input.conversationId ?? "default",
    input.agentId,
    { full: input.full },
  );
  return formatContextPendingReport(report, { full: input.full });
}
