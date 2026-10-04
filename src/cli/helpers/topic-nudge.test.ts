/**
 * The copy for the no-marker nudge (feature ③, D-114).
 *
 * The two halves describe one event: what the model is asked to do, and what the
 * user is told about it. A reminder that reads like a command, or a hint that
 * looks like conversation content, would both be bugs — the first because the
 * tags are what mark automated text as automated, the second because the line is
 * terminal output and must never be sent.
 */
import { describe, expect, test } from "bun:test";
import {
  formatTopicNudgeHint,
  formatTopicNudgeReminder,
} from "@/cli/helpers/topic-nudge";

const notice = { turnsSinceLastMarker: 52, nudgeTurns: 50 };

describe("formatTopicNudgeReminder", () => {
  test("wraps the request in the automated-message envelope", () => {
    const text = formatTopicNudgeReminder(notice);
    expect(text.startsWith("<system-reminder>")).toBe(true);
    expect(text.endsWith("</system-reminder>")).toBe(true);
  });

  test("names the stretch, the tool, and that it will not repeat", () => {
    const text = formatTopicNudgeReminder(notice);
    expect(text).toContain("52 user turns without a topic marker");
    expect(text).toContain("threshold is 50");
    expect(text).toContain("TopicMark");
    expect(text).toContain("not repeated for the same stretch");
    // Markers are metadata: the model must not think this changes the context.
    expect(text).toContain("do not change the context");
  });
});

describe("formatTopicNudgeHint", () => {
  test("is one plain line about what the user can do", () => {
    const hint = formatTopicNudgeHint(notice);
    expect(hint).not.toContain("<system-reminder>");
    expect(hint.split("\n")).toHaveLength(1);
    expect(hint).toContain("52 user turns without a topic marker");
    expect(hint).toContain("/topic <title>");
    expect(hint).toContain("/compact");
  });
});
