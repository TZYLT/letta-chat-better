import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendLocalFeedback,
  localFeedbackLogPath,
  MAX_FEEDBACK_LOG_FILES,
} from "@/telemetry/local-feedback-log";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "letta-feedback-log-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readLines(): Record<string, unknown>[] {
  const content = readFileSync(localFeedbackLogPath({ dir }), "utf8").trim();
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("local feedback log", () => {
  test("appends one timestamped JSON line per submission", () => {
    appendLocalFeedback({ message: "first", feature: "letta-code" }, { dir });
    appendLocalFeedback({ message: "second" }, { dir });

    const lines = readLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      message: "first",
      feature: "letta-code",
    });
    expect(typeof lines[0]?.ts).toBe("string");
    expect(lines[1]).toMatchObject({ message: "second" });
  });

  test("defaults to the local logs directory", () => {
    expect(localFeedbackLogPath()).toBe(
      join(homedir(), ".haruyuki", "logs", "feedback.jsonl"),
    );
  });

  test("rotates the active file once it passes the byte cap", () => {
    writeFileSync(localFeedbackLogPath({ dir }), "x".repeat(64));

    appendLocalFeedback({ message: "after rotation" }, { dir, maxBytes: 32 });

    // The oversized active file moved to archive 1 and a fresh one was started.
    expect(readFileSync(join(dir, "feedback.1.jsonl"), "utf8")).toHaveLength(
      64,
    );
    expect(readLines()).toHaveLength(1);
  });

  test("keeps the configured number of archives", () => {
    for (let index = 0; index < MAX_FEEDBACK_LOG_FILES + 2; index += 1) {
      appendLocalFeedback({ message: `entry-${index}` }, { dir, maxBytes: 1 });
    }

    const lines = readLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      message: `entry-${MAX_FEEDBACK_LOG_FILES + 1}`,
    });
  });

  test("never throws when the directory cannot be written", () => {
    const filePath = join(dir, "not-a-directory");
    writeFileSync(filePath, "");

    expect(() =>
      appendLocalFeedback({ message: "boom" }, { dir: filePath }),
    ).not.toThrow();
  });
});
