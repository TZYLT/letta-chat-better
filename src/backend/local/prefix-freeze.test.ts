import { describe, expect, test } from "bun:test";
import {
  applyFrozenAgentOverrides,
  canonicalJson,
  computeContextPending,
  establishFrozenCollections,
  frozenToolsArray,
  hashFrozenText,
  resolveFrozenPrefix,
  stampFreezeMetadata,
} from "@/backend/local/prefix-freeze";
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

describe("canonicalJson", () => {
  test("sorts object keys recursively so equal sets serialize identically", () => {
    const a = canonicalJson([{ name: "B", parameters: { z: 1, a: 2 } }]);
    const b = canonicalJson([{ parameters: { a: 2, z: 1 }, name: "B" }]);
    expect(a).toBe(b);
  });
});

describe("stampFreezeMetadata", () => {
  test("captures the effective model/params and the reason", () => {
    const stamped = stampFreezeMetadata(snapshot(), {
      reason: "conversation_created",
      agent: { model: "anthropic/x", model_settings: { temperature: 0.3 } },
      now: new Date("2026-02-01T00:00:00.000Z"),
    });
    expect(stamped.freezeSchema).toBe(1);
    expect(stamped.frozenReason).toBe("conversation_created");
    expect(stamped.frozenAt).toBe("2026-02-01T00:00:00.000Z");
    expect(stamped.frozenModel).toBe("anthropic/x");
    expect(stamped.frozenModelSettings).toBe(
      canonicalJson({ temperature: 0.3 }),
    );
    // Collections are not known at compile time; they establish on first turn.
    expect(stamped.frozenTools).toBeUndefined();
    expect(stamped.frozenSkillsBlock).toBeUndefined();
  });
});

describe("establishFrozenCollections", () => {
  test("freezes a non-empty collection once, then ignores later live change", () => {
    const first = establishFrozenCollections({
      snapshot: snapshot(),
      skillsBlock: "<available_skills>A</available_skills>",
      tools: [{ name: "A" }],
    });
    expect(first.changed).toBe(true);
    expect(first.snapshot.frozenTools).toBe(canonicalJson([{ name: "A" }]));
    expect(first.snapshot.frozenToolsHash).toBe(
      hashFrozenText(canonicalJson([{ name: "A" }])),
    );

    const second = establishFrozenCollections({
      snapshot: first.snapshot,
      skillsBlock: "<available_skills>B</available_skills>",
      tools: [{ name: "B" }],
    });
    // Frozen values are unchanged; the drift is only observed for reporting.
    expect(second.snapshot.frozenTools).toBe(first.snapshot.frozenTools);
    expect(second.snapshot.frozenSkillsBlock).toBe(
      first.snapshot.frozenSkillsBlock,
    );
    expect(second.snapshot.observedTools).toBe(canonicalJson([{ name: "B" }]));
    expect(second.snapshot.observedSkillsBlock).toBe(
      "<available_skills>B</available_skills>",
    );
  });

  test("leaves empty live collections unfrozen", () => {
    const result = establishFrozenCollections({
      snapshot: snapshot(),
      skillsBlock: "",
      tools: [],
    });
    expect(result.changed).toBe(false);
    expect(result.snapshot.frozenTools).toBeUndefined();
    expect(result.snapshot.frozenSkillsBlock).toBeUndefined();
  });
});

describe("frozenToolsArray", () => {
  test("returns undefined until tools are frozen, then the frozen set", () => {
    expect(frozenToolsArray(snapshot())).toBeUndefined();
    const frozen = establishFrozenCollections({
      snapshot: snapshot(),
      skillsBlock: "",
      tools: [{ name: "A" }],
    }).snapshot;
    expect(frozenToolsArray(frozen)).toEqual([{ name: "A" }]);
  });
});

describe("applyFrozenAgentOverrides", () => {
  test("overlays the frozen model/params over a live change", () => {
    const agent = {
      model: "anthropic/live",
      model_settings: { temperature: 0.9 },
    };
    const frozen = snapshot({
      frozenModel: "anthropic/frozen",
      frozenModelSettings: canonicalJson({ temperature: 0.1 }),
    });
    const overlaid = applyFrozenAgentOverrides(agent, frozen);
    expect(overlaid.model).toBe("anthropic/frozen");
    expect(overlaid.model_settings).toEqual({ temperature: 0.1 });
  });

  test("returns the live agent unchanged when nothing is frozen", () => {
    const agent = { model: "anthropic/live", model_settings: {} };
    expect(applyFrozenAgentOverrides(agent, snapshot())).toBe(agent);
  });
});

describe("computeContextPending", () => {
  test("reports memory/system/model drift and tool add/remove", () => {
    const report = computeContextPending({
      hasSnapshot: true,
      appliedRevision: "rev-1",
      committedRevision: "rev-2",
      unappliedCommits: ["abc add note"],
      diffStat: " note.md | 1 +",
      appliedRawSystemHash: "hash-1",
      liveRawSystemHash: "hash-2",
      appliedTools: canonicalJson([{ name: "A" }, { name: "B" }]),
      observedTools: canonicalJson([{ name: "B" }, { name: "C" }]),
      appliedModel: "anthropic/a",
      liveModel: "anthropic/b",
      appliedModelSettings: canonicalJson({ t: 1 }),
      liveModelSettings: canonicalJson({ t: 1 }),
      dirty: false,
    });
    expect(report.memory.unappliedCommits).toEqual(["abc add note"]);
    expect(report.systemChanged).toBe(true);
    expect(report.model.changed).toBe(true);
    expect(report.modelSettingsChanged).toBe(false);
    expect(report.tools.added).toEqual(["C"]);
    expect(report.tools.removed).toEqual(["A"]);
    expect(report.tools.changed).toBe(true);
    expect(report.hasPending).toBe(true);
  });

  test("no drift yields no pending and dirty stays reporting-only", () => {
    const report = computeContextPending({
      hasSnapshot: true,
      appliedRevision: "rev-1",
      committedRevision: "rev-1",
      appliedRawSystemHash: "hash",
      liveRawSystemHash: "hash",
      appliedModel: "anthropic/a",
      liveModel: "anthropic/a",
      dirty: true,
    });
    expect(report.hasPending).toBe(false);
    expect(report.dirty).toBe(true);
  });
});
