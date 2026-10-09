import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzePrefixProbe,
  formatPrefixProbeReport,
  type PrefixProbeRecord,
  resetPrefixProbeSequence,
  withPrefixProbe,
} from "@/backend/dev/prefix-probe";

const ENV_KEY = "HARUYUKI_PREFIX_PROBE_DIR";

function withProbeEnv<T>(dir: string | undefined, run: () => T): T {
  const previous = process.env[ENV_KEY];
  if (dir === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = dir;
  resetPrefixProbeSequence();
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = previous;
    resetPrefixProbeSequence();
  }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "prefix-probe-"));
}

describe("withPrefixProbe", () => {
  test("is a no-op when HARUYUKI_PREFIX_PROBE_DIR is unset", () => {
    withProbeEnv(undefined, () => {
      expect(
        withPrefixProbe(undefined, { conversationId: "c" }),
      ).toBeUndefined();
    });
  });

  test("writes numbered payload files and passes the hook result through", async () => {
    const dir = tempDir();
    try {
      await withProbeEnv(dir, async () => {
        const hook = withPrefixProbe(async () => ({ rewritten: true }), {
          conversationId: "conv-1",
          modelId: "anthropic/x",
        });
        if (!hook) throw new Error("probe hook should be enabled");
        const result = await hook({ system: "s", messages: [] }, {} as never);
        expect(result).toEqual({ rewritten: true });

        const files = readdirSync(dir);
        expect(files).toEqual(["payload-conv-1-0001.json"]);
        const written = JSON.parse(
          readFileSync(join(dir, files[0] ?? ""), "utf8"),
        );
        expect(written).toMatchObject({
          conversationId: "conv-1",
          modelId: "anthropic/x",
          seq: 1,
        });
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("never breaks the turn when the write fails", async () => {
    const dir = tempDir();
    try {
      // Occupy the probe path with a file so mkdir fails on every write.
      const blocked = join(dir, "blocked");
      writeFileSync(blocked, "not a directory", "utf8");
      await withProbeEnv(blocked, async () => {
        const hook = withPrefixProbe(async () => "ok", {
          conversationId: "conv-2",
        });
        if (!hook) throw new Error("probe hook should be enabled");
        await expect(hook({}, {} as never)).resolves.toBe("ok");
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function record(
  seq: number,
  payload: unknown,
  conversationId = "conv",
): PrefixProbeRecord {
  return { conversationId, seq, payload };
}

describe("analyzePrefixProbe", () => {
  test("passes when the system/tools hashes are stable and messages append", () => {
    const report = analyzePrefixProbe([
      record(1, { system: "S", tools: [{ name: "A" }], messages: ["m1"] }),
      record(2, {
        system: "S",
        tools: [{ name: "A" }],
        messages: ["m1", "m2"],
      }),
    ]);
    expect(report.pass).toBe(true);
    expect(report.systemStable).toBe(true);
    expect(report.toolsStable).toBe(true);
    expect(report.conversations[0]?.comparisons[0]).toMatchObject({
      messagesAppended: true,
      commonMessagePrefix: 1,
      laterMessageCount: 2,
    });
  });

  test("fails and locates the drift when the system segment changes", () => {
    const report = analyzePrefixProbe([
      record(1, { system: "S1", messages: ["m1"] }),
      record(2, { system: "S2", messages: ["m1", "m2"] }),
    ]);
    expect(report.pass).toBe(false);
    expect(report.systemStable).toBe(false);
    expect(formatPrefixProbeReport(report)).toContain("system DRIFT");
  });

  test("flags a messages rewrite as non-append with the divergence index", () => {
    const report = analyzePrefixProbe([
      record(1, { system: "S", messages: ["a", "b"] }),
      record(2, { system: "S", messages: ["a", "c"] }),
    ]);
    expect(report.pass).toBe(true);
    const comparison = report.conversations[0]?.comparisons[0];
    expect(comparison?.messagesAppended).toBe(false);
    expect(comparison?.commonMessagePrefix).toBe(1);
  });

  test("reads the openai-responses shape (instructions/input)", () => {
    const report = analyzePrefixProbe([
      record(1, { instructions: "S", input: ["i1"] }),
      record(2, { instructions: "S", input: ["i1", "i2"] }),
    ]);
    expect(report.pass).toBe(true);
    expect(report.conversations[0]?.comparisons[0]?.messagesAppended).toBe(
      true,
    );
  });
});

describe("V14 repeatable regression", () => {
  test("the same probe input yields an identical report on every run", () => {
    const records = [
      record(1, { system: "S", tools: [{ name: "A" }], messages: ["m1"] }),
      record(2, {
        system: "S",
        tools: [{ name: "A" }],
        messages: ["m1", "m2"],
      }),
    ];
    const first = formatPrefixProbeReport(analyzePrefixProbe(records));
    const second = formatPrefixProbeReport(analyzePrefixProbe(records));
    expect(first).toBe(second);
    expect(first).toContain("RESULT: PASS");
  });
});
