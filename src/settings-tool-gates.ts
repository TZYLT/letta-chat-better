/**
 * Settings-driven predicates for optional product surfaces.
 *
 * These wrap `settingsManager` rather than living on it because that file is
 * pinned by the source-size ratchet. They sit at the `src/` root, next to the
 * settings manager, so both the backend (which compiles the prompt chapter) and
 * the tools layer (which builds the declared payload) can read the same value
 * without either importing the other.
 *
 * Anything with a backend or tool-type dependency belongs in the caller:
 * `tools/declaration-gates.ts` owns "what the payload declares".
 */
import { settingsManager } from "@/settings-manager";

export function shouldIncludeWorktreeTool(): boolean {
  try {
    return settingsManager.shouldIncludeWorktreeTool();
  } catch {
    return true;
  }
}

/**
 * `topic_marking_enabled`, default on.
 *
 * A global setting, like `includeWorktreeTool`: the declaration and the compiled
 * prompt are both built without a project scope in their call paths, so a
 * per-project override would be read inconsistently between them.
 */
export function shouldIncludeTopicMarking(): boolean {
  try {
    return settingsManager.getSettings().topicMarkingEnabled !== false;
  } catch {
    // Settings unavailable: keep the feature rather than silently dropping it.
    return true;
  }
}

/**
 * Whether the topic channel may be *advertised* to the model — the prompt chapter
 * and the one-shot nudge that name `TopicMark`.
 *
 * The switch alone is not enough: the tool has to be in the payload as well, or
 * the model is told to call a tool it cannot see. Every preset except `none`
 * declares it, and `auto` resolves to one of those, so the toolset preference is
 * the only extra fact needed here.
 */
export function shouldAdvertiseTopicMarking(
  agentId: string,
  conversationId: string,
): boolean {
  if (!shouldIncludeTopicMarking()) return false;
  try {
    return (
      settingsManager.getToolsetPreference(agentId, conversationId) !== "none"
    );
  } catch {
    return true;
  }
}
