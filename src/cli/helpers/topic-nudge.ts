/**
 * The two halves of the one-shot no-marker nudge (feature ③, D-114).
 *
 * The reminder engine decides when the nudge is due and parks the numbers on the
 * shared reminder state; these functions turn them into the text the model reads
 * and the line the user sees. They are kept together because they describe the
 * same event from two sides and must not drift apart.
 */
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "@/constants";

export interface TopicNudgeNotice {
  /** User turns since the last marker when the nudge fired. */
  turnsSinceLastMarker: number;
  /** The configured threshold (`topic_nudge_turns`). */
  nudgeTurns: number;
}

/** The agent-facing reminder; it rides in the user message, never as a system role. */
export function formatTopicNudgeReminder(notice: TopicNudgeNotice): string {
  return `${SYSTEM_REMINDER_OPEN} This conversation has gone ${notice.turnsSinceLastMarker} user turns without a topic marker (the reminder threshold is ${notice.nudgeTurns}).
When the subject changes, call \`TopicMark\` with a short title for the topic that just ended, so the user can later trim older topics at a clean boundary instead of an arbitrary one. Markers are metadata: they do not change the context, the tools, or the cached prefix.
If the conversation is still on the same topic, ignore this and carry on. This reminder is not repeated for the same stretch.
${SYSTEM_REMINDER_CLOSE}`;
}

/** The user-facing line: shown once, never sent. */
export function formatTopicNudgeHint(notice: TopicNudgeNotice): string {
  return `${notice.turnsSinceLastMarker} user turns without a topic marker. /topic <title> marks where a topic ended, so /compact can cut there instead of at a guess.`;
}
