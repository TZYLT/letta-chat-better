/**
 * The tail every `/compact` surface runs after a *successful* compaction.
 *
 * The TUI and the websocket listener each own their own reflection wiring (the TUI
 * can run the arena experiment, the listener has its own subagent launcher) and
 * their own description regeneration, so those arrive as callbacks. What is shared
 * is the ordering and the failure rule: the reminder state has to know the context
 * changed before the next turn is built, a reflection is best-effort, and a
 * failure in any of it must never be reported as a failed compaction — the trim
 * already happened.
 */

import type { SharedReminderState } from "@/reminders/state";
import { markPostCompactionContextRemindersPending } from "@/reminders/state";
import { debugLog } from "@/utils/debug";

export interface PostCompactionTailInput {
  reminderState: SharedReminderState;
  /**
   * Compaction-event reflection. Called inside the guard, so it may both decide
   * (reading the agent's settings) and launch; it must not throw for a reason it
   * can check itself, and it must not return a promise that rejects unhandled.
   */
  reflect: () => void;
  /** Refresh the conversation description / search metadata. */
  regenerateDescription: () => void;
}

/**
 * Mark the post-compaction reminders pending, run the optional reflection, then
 * refresh the description. Read the ordering as the contract: a surface that
 * regenerates the description before marking the reminders has them land in the
 * wrong turn.
 */
export function runPostCompactionTail(input: PostCompactionTailInput): void {
  markPostCompactionContextRemindersPending(input.reminderState);
  try {
    input.reflect();
  } catch (error) {
    debugLog(
      "memory",
      "Skipping post-compaction reflection:",
      error instanceof Error ? error.message : String(error),
    );
  }
  input.regenerateDescription();
}
