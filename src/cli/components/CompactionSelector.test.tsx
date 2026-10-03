/**
 * D-108: `/compaction` offers only what the active backend can run, and shows the
 * retention ratio that `sliding_window` depends on.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  resolveBackendMode,
  setConfiguredBackendMode,
} from "@/backend/backend-mode";
import {
  buildCompactionModeItems,
  retentionPercentageFor,
} from "@/cli/components/CompactionSelector";
import {
  assertCompactionModeForBackend,
  availableCompactionModes,
  isCompactionMode,
} from "@/cli/helpers/compaction-mode";

const ambientMode = resolveBackendMode();

beforeEach(() => {
  setConfiguredBackendMode(ambientMode);
});

afterEach(() => {
  // The override is module-global and shared across test files in a worker.
  setConfiguredBackendMode(ambientMode);
});

describe("availableCompactionModes", () => {
  test("local backend offers sliding_window only", () => {
    setConfiguredBackendMode("local");
    expect(availableCompactionModes()).toEqual(["sliding_window"]);
  });

  test("hosted backend keeps the full set", () => {
    setConfiguredBackendMode("api");
    expect(availableCompactionModes()).toEqual([
      "all",
      "sliding_window",
      "self_compact_all",
      "self_compact_sliding_window",
    ]);
  });
});

describe("assertCompactionModeForBackend", () => {
  test("accepts sliding_window on the local backend", () => {
    setConfiguredBackendMode("local");
    expect(assertCompactionModeForBackend("sliding_window")).toBe(
      "sliding_window",
    );
  });

  test("rejects a mode the local backend cannot run", () => {
    setConfiguredBackendMode("local");
    expect(() => assertCompactionModeForBackend("all")).toThrow(
      'only runs the "sliding_window" compaction mode',
    );
    expect(() => assertCompactionModeForBackend("self_compact_all")).toThrow();
  });

  test("rejects an unknown mode on any backend", () => {
    setConfiguredBackendMode("api");
    expect(() => assertCompactionModeForBackend("bogus")).toThrow(
      "Unknown compaction mode",
    );
    expect(isCompactionMode("bogus")).toBe(false);
  });

  test("hosted backend still accepts all", () => {
    setConfiguredBackendMode("api");
    expect(assertCompactionModeForBackend("all")).toBe("all");
  });
});

describe("buildCompactionModeItems", () => {
  test("renders one row locally, with the retention ratio", () => {
    const items = buildCompactionModeItems({
      modes: ["sliding_window"],
      currentMode: "sliding_window",
      retentionPercentage: 0.3,
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.label).toBe("Sliding Window");
    expect(items[0]?.description).toContain("keeps about 30%");
    expect(items[0]?.isCurrent).toBe(true);
  });

  test("renders every mode for the hosted backend", () => {
    const items = buildCompactionModeItems({
      modes: [
        "all",
        "sliding_window",
        "self_compact_all",
        "self_compact_sliding_window",
      ],
      currentMode: "all",
      retentionPercentage: 0.3,
    });
    expect(items.map((item) => item.key)).toEqual([
      "all",
      "sliding_window",
      "self_compact_all",
      "self_compact_sliding_window",
    ]);
    expect(items.filter((item) => item.isCurrent)).toHaveLength(1);
    // Only the sliding-window row explains the retention ratio.
    expect(items[0]?.description).not.toContain("Retention");
  });

  test("rounds a custom ratio for display", () => {
    const items = buildCompactionModeItems({
      modes: ["sliding_window"],
      currentMode: "sliding_window",
      retentionPercentage: 0.45,
    });
    expect(items[0]?.description).toContain("keeps about 45%");
  });
});

describe("retentionPercentageFor", () => {
  test("uses the configured ratio, falling back to the backend default", () => {
    expect(retentionPercentageFor({ sliding_window_percentage: 0.5 })).toBe(
      0.5,
    );
    expect(retentionPercentageFor({})).toBe(0.3);
    expect(retentionPercentageFor(null)).toBe(0.3);
    expect(retentionPercentageFor(undefined)).toBe(0.3);
  });
});
