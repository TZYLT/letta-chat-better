import { describe, expect, test } from "bun:test";
import { resolveFrozenPrefix } from "@/backend/local/prefix-freeze";
import type { LocalCompiledSystemPrompt } from "@/backend/local/system-prompt-compilation";

function snapshot(
  overrides: Partial<LocalCompiledSystemPrompt> = {},
): LocalCompiledSystemPrompt {
  return {
    content: "compiled",
    coreMemory: "memory",
    compiledAt: "2026-01-01T00:00:00.000Z",
    rawSystemHash: "hash-a",
    memfsRevision: "rev-a",
    ...overrides,
  };
}

describe("resolveFrozenPrefix", () => {
  test("compiles when the conversation has no applied snapshot", () => {
    expect(resolveFrozenPrefix(undefined)).toEqual({ kind: "compile" });
  });

  test("reuses the applied snapshot when one exists", () => {
    const existing = snapshot();
    expect(resolveFrozenPrefix(existing)).toEqual({
      kind: "frozen",
      snapshot: existing,
    });
  });

  test("reuses the snapshot regardless of live state drift", () => {
    // The decision is independent of any live memfs revision / raw system
    // hash: a turn never rewrites the prefix, so drift stays pending.
    const existing = snapshot({
      memfsRevision: "rev-old",
      rawSystemHash: "hash-old",
    });
    const resolution = resolveFrozenPrefix(existing);
    expect(resolution.kind).toBe("frozen");
    if (resolution.kind === "frozen") {
      expect(resolution.snapshot).toBe(existing);
    }
  });
});
