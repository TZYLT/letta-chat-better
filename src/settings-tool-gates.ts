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
