import { isDebugEnabled } from "@/utils/debug";
import { buildAgentTerminalLink, isLocalAgentId } from "./app-urls";

export type MemorySubagentType = "init" | "reflection";

export type MemorySubagentSuccessMessageOverride =
  | string
  | ((args: { action: string; defaultMessage: string }) => string);

export interface MemorySubagentCompletionArgs {
  subagentType: MemorySubagentType;
  success: boolean;
  error?: string;
  subagentAgentId?: string;
  successMessageOverride?: MemorySubagentSuccessMessageOverride;
}

/**
 * Finalize a memory-writing subagent and return the user-facing completion
 * text.
 *
 * The subagent never recompiles the parent's system prompt: under the strict
 * prefix freeze a committed memory change is only applied at an application
 * point (new conversation, compaction, or an explicit /recompile).
 */
export async function handleMemorySubagentCompletion(
  args: MemorySubagentCompletionArgs,
): Promise<string> {
  const { subagentType, success, error } = args;
  const subagentLink = args.subagentAgentId
    ? buildAgentTerminalLink(args.subagentAgentId, undefined, "Dreamed")
    : null;
  const canLinkSubagent = args.subagentAgentId
    ? !isLocalAgentId(args.subagentAgentId)
    : false;

  if (!success) {
    if (subagentType === "reflection") {
      if (args.successMessageOverride) {
        const action =
          subagentLink && canLinkSubagent ? subagentLink : "Dreamed";
        const defaultMessage = `${action} and made some memories.`;
        return typeof args.successMessageOverride === "function"
          ? args.successMessageOverride({ action, defaultMessage })
          : args.successMessageOverride;
      }
      const detail = isDebugEnabled() ? `: ${error || "Unknown error"}` : "";
      return `Tried to reflect, but got lost in the palace${detail}`;
    }
    const normalizedError = error || "Unknown error";
    return `Memory initialization failed: ${normalizedError}`;
  }

  const action =
    subagentType === "reflection" && subagentLink && canLinkSubagent
      ? subagentLink
      : subagentType === "reflection"
        ? "Dreamed"
        : "Built";
  const defaultMessage =
    subagentType === "reflection"
      ? `${action} and made some memories.`
      : "Built a memory palace of you. Visit it with /palace.";
  return typeof args.successMessageOverride === "function"
    ? args.successMessageOverride({ action, defaultMessage })
    : (args.successMessageOverride ?? defaultMessage);
}
