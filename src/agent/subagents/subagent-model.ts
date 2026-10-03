// Read the model handle a conversation is actually running.
//
// Subagents never choose a model: they inherit the parent conversation's
// handle. This module owns only the "what is the parent running" question —
// there is deliberately no per-subagent model resolution left, so no caller can
// spawn a child on a different model than its parent.

import { getCurrentAgentId } from "@/agent/context";
import { getBackend } from "@/backend";

export function getModelHandleFromAgent(agent: {
  model?: string | null;
  model_settings?: { provider_type?: unknown } | null;
  llm_config?: { model_endpoint_type?: string | null; model?: string | null };
}): string | null {
  const directModel = agent.model;
  if (directModel?.includes("/")) {
    return directModel;
  }
  const settingsProvider = agent.model_settings?.provider_type;
  if (typeof settingsProvider === "string" && directModel) {
    return `${settingsProvider}/${directModel}`;
  }
  const endpoint = agent.llm_config?.model_endpoint_type;
  const model = agent.llm_config?.model;
  if (endpoint && model) {
    return `${endpoint}/${model}`;
  }
  return directModel || model || null;
}

/**
 * The model handle the parent conversation is running: the conversation-scoped
 * override when there is one, otherwise the agent's own model. A subagent
 * inherits this value verbatim.
 */
export async function getPrimaryAgentModelHandle(
  scope: { agentId?: string | null; conversationId?: string | null } = {},
): Promise<{
  handle: string | null;
  agent: {
    model?: string | null;
    name?: string | null;
    model_settings?: { provider_type?: unknown } | null;
    llm_config?: { model_endpoint_type?: string | null; model?: string | null };
  } | null;
}> {
  try {
    const agentId = scope.agentId ?? getCurrentAgentId();
    const agent = await getBackend().retrieveAgent(agentId);
    const conversationId = scope.conversationId;
    if (conversationId && conversationId !== "default") {
      try {
        const conversation =
          await getBackend().retrieveConversation(conversationId);
        const conversationHandle = getModelHandleFromAgent(conversation);
        if (conversationHandle) {
          return { handle: conversationHandle, agent };
        }
      } catch {
        // Fall back to the agent default if the conversation is not available.
      }
    }
    return { handle: getModelHandleFromAgent(agent), agent };
  } catch {
    return { handle: null, agent: null };
  }
}
