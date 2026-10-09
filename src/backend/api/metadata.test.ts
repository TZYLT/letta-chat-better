import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  getFeedbackClientType,
  submitFeedbackMetadata,
} from "@/backend/api/metadata";
import { localFeedbackLogPath } from "@/telemetry/local-feedback-log";

describe("feedback client attribution", () => {
  test("identifies Desktop before other runtime markers", () => {
    expect(
      getFeedbackClientType({
        HARUYUKI_DESKTOP_MODE: "1",
        HARUYUKI_RUNTIME_ENVIRONMENT_DEVICE_ID: "sandbox-1",
      }),
    ).toBe("desktop");
  });

  test("identifies chat.letta.com cloud runtimes", () => {
    expect(
      getFeedbackClientType({
        HARUYUKI_RUNTIME_ENVIRONMENT_DEVICE_ID: "sandbox-1",
      }),
    ).toBe("chat.letta.com");
  });

  test("uses CLI for local non-Desktop runtimes", () => {
    expect(getFeedbackClientType({})).toBe("cli");
  });
});

describe("feedback submission", () => {
  // Regression: the submission POSTed the payload (feedback text, settings,
  // cwd, debug log tail) to https://api.letta.com/v1/metadata/feedback. The
  // Cloud backend is gone, so nothing may leave the machine.
  test("records the payload locally without touching the network", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls += 1;
      throw new Error("feedback must not reach the network");
    }) as unknown as typeof globalThis.fetch;

    try {
      await submitFeedbackMetadata("device-fixture", {
        message: "keep me local",
        feature: "letta-code",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchCalls).toBe(0);
    expect(localFeedbackLogPath()).toBe(
      join(homedir(), ".haruyuki", "logs", "feedback.jsonl"),
    );
    const lines = readFileSync(localFeedbackLogPath(), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.at(-1)).toMatchObject({
      device_id: "device-fixture",
      message: "keep me local",
      feature: "letta-code",
    });
  });
});
