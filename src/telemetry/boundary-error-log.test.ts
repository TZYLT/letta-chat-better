import { afterEach, describe, expect, test } from "bun:test";
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
  appendBoundaryError,
  boundaryErrorLogPath,
} from "@/telemetry/boundary-error-log";

const directories: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "boundary-log-"));
  directories.push(dir);
  return dir;
}

function readEntries(dir: string): Record<string, unknown>[] {
  return readFileSync(boundaryErrorLogPath({ dir }), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("boundary error log", () => {
  test("appends one JSON line with the timestamp and reported fields", () => {
    const dir = tempDir();

    appendBoundaryError(
      {
        errorType: "listener_queue_pump_failed",
        message: "queue exploded",
        context: "listener_queue_pump",
        runId: "run-123",
        httpStatus: 503,
      },
      { dir },
    );

    const entries = readEntries(dir);
    expect(entries).toHaveLength(1);
    const [entry = {}] = entries;
    expect(entry).toMatchObject({
      errorType: "listener_queue_pump_failed",
      message: "queue exploded",
      context: "listener_queue_pump",
      runId: "run-123",
      httpStatus: 503,
    });
    expect(typeof entry.ts).toBe("string");
    expect(Number.isNaN(Date.parse(entry.ts as string))).toBe(false);
  });

  test("appends without truncating earlier entries", () => {
    const dir = tempDir();

    appendBoundaryError({ errorType: "a", message: "first" }, { dir });
    appendBoundaryError({ errorType: "b", message: "second" }, { dir });

    expect(readEntries(dir).map((entry) => entry.message)).toEqual([
      "first",
      "second",
    ]);
  });

  test("creates the log directory on demand", () => {
    const dir = join(tempDir(), "nested", "logs");

    appendBoundaryError({ errorType: "e", message: "m" }, { dir });

    expect(readEntries(dir)).toHaveLength(1);
  });

  test("omits fields the caller did not supply", () => {
    const dir = tempDir();

    appendBoundaryError({ errorType: "e", message: "m" }, { dir });

    const [entry = {}] = readEntries(dir);
    expect("modelId" in entry).toBe(false);
    expect("debugLogTail" in entry).toBe(false);
    expect("runId" in entry).toBe(false);
  });

  test("rotates the active file into an archive once it passes the cap", () => {
    const dir = tempDir();
    const options = { dir, maxBytes: 120, maxFiles: 5 };

    for (let index = 0; index < 8; index += 1) {
      appendBoundaryError(
        { errorType: "e", message: `message-${index}` },
        options,
      );
    }

    const files = readdirSync(dir);
    expect(files).toContain("boundary-errors.1.jsonl");
    // The newest write stays in the active file; the oldest survives in an archive.
    const active = readEntries(dir).map((entry) => entry.message);
    expect(active).toContain("message-7");
    expect(active).not.toContain("message-0");
    const archived = files
      .filter((file) => file.startsWith("boundary-errors."))
      .map((file) => readFileSync(join(dir, file), "utf8"))
      .join("");
    expect(archived).toContain("message-0");
  });

  test("keeps at most maxFiles files, dropping the oldest archive", () => {
    const dir = tempDir();
    const options = { dir, maxBytes: 120, maxFiles: 3 };

    for (let index = 0; index < 12; index += 1) {
      appendBoundaryError(
        { errorType: "e", message: `message-${index}` },
        options,
      );
    }

    const files = readdirSync(dir).filter((file) =>
      file.startsWith("boundary-errors"),
    );
    expect(files.length).toBeLessThanOrEqual(3);
    expect(files).toContain("boundary-errors.jsonl");
  });

  test("never throws when the log directory cannot be created", () => {
    const occupied = join(tempDir(), "not-a-directory");
    writeFileSync(occupied, "occupied");

    expect(() =>
      appendBoundaryError(
        { errorType: "e", message: "m" },
        { dir: join(occupied, "logs") },
      ),
    ).not.toThrow();
  });
});
