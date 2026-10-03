import { recompileAgentSystemPrompt } from "@/agent/modify";
import {
  formatAppliedPendingSummary,
  readContextPendingReport,
} from "@/cli/helpers/context-pending";

/**
 * `/recompile` — the manual application point. Recompiles the current agent and
 * conversation, and reports what was pending immediately before, because that
 * is what this recompile just applied. The pending read happens first: the
 * recompile clears it.
 */
export async function recompileAndSummarize(input: {
  conversationId: string;
  agentId: string;
}): Promise<{ compiledSystemPrompt: string; appliedSummary?: string }> {
  const pendingBefore = await readContextPendingReport({
    conversationId: input.conversationId,
    agentId: input.agentId,
  });
  const compiledSystemPrompt = await recompileAgentSystemPrompt(
    input.conversationId,
    input.agentId,
  );
  return {
    compiledSystemPrompt,
    appliedSummary: formatAppliedPendingSummary(pendingBefore),
  };
}

/** The exact text the `/recompile` command finishes with. */
export function formatRecompileCommandOutput(
  appliedSummary: string | undefined,
): string {
  return [
    "Recompiled current agent and conversation.",
    ...(appliedSummary ? [appliedSummary] : []),
    "(warning: this will evict the cache and increase costs)",
  ].join("\n");
}
