/**
 * D-108: `/compaction` offers only what the local backend can run, and shows the
 * compression rate that `sliding_window` depends on.
 */
import { describe, expect, test } from "bun:test";
import {
  buildCompactionModeItems,
  compressionPercentageFor,
} from "@/cli/components/CompactionSelector";
import {
  assertCompactionModeForBackend,
  availableCompactionModes,
  isCompactionMode,
} from "@/cli/helpers/compaction-mode";

describe("availableCompactionModes", () => {
  test("offers sliding_window only", () => {
    expect(availableCompactionModes()).toEqual(["sliding_window"]);
  });
});

describe("assertCompactionModeForBackend", () => {
  test("accepts sliding_window", () => {
    expect(assertCompactionModeForBackend("sliding_window")).toBe(
      "sliding_window",
    );
  });

  test("rejects a mode this backend cannot run", () => {
    expect(() => assertCompactionModeForBackend("all")).toThrow(
      'only runs the "sliding_window" compaction mode',
    );
    expect(() => assertCompactionModeForBackend("self_compact_all")).toThrow();
  });

  test("rejects an unknown mode", () => {
    expect(() => assertCompactionModeForBackend("bogus")).toThrow(
      "Unknown compaction mode",
    );
    expect(isCompactionMode("bogus")).toBe(false);
  });
});

describe("buildCompactionModeItems", () => {
  test("renders one row locally, with the compression rate", () => {
    const items = buildCompactionModeItems({
      modes: ["sliding_window"],
      currentMode: "sliding_window",
      compressionPercentage: 0.3,
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.label).toBe("Sliding Window");
    expect(items[0]?.description).toContain("Compresses about 30%");
    expect(items[0]?.description).toContain("keeps about 70%");
    expect(items[0]?.isCurrent).toBe(true);
  });

  test("renders every mode it is given", () => {
    const items = buildCompactionModeItems({
      modes: [
        "all",
        "sliding_window",
        "self_compact_all",
        "self_compact_sliding_window",
      ],
      currentMode: "all",
      compressionPercentage: 0.3,
    });
    expect(items.map((item) => item.key)).toEqual([
      "all",
      "sliding_window",
      "self_compact_all",
      "self_compact_sliding_window",
    ]);
    expect(items.filter((item) => item.isCurrent)).toHaveLength(1);
    // Only the sliding-window row explains the compression rate.
    expect(items[0]?.description).not.toContain("Compresses");
  });

  test("rounds a custom rate for display", () => {
    const items = buildCompactionModeItems({
      modes: ["sliding_window"],
      currentMode: "sliding_window",
      compressionPercentage: 0.45,
    });
    expect(items[0]?.description).toContain("Compresses about 45%");
    expect(items[0]?.description).toContain("keeps about 55%");
  });
});

describe("compressionPercentageFor", () => {
  test("uses the configured rate, falling back to the backend default", () => {
    expect(compressionPercentageFor({ sliding_window_percentage: 0.5 })).toBe(
      0.5,
    );
    expect(compressionPercentageFor({})).toBe(0.3);
    expect(compressionPercentageFor(null)).toBe(0.3);
    expect(compressionPercentageFor(undefined)).toBe(0.3);
  });
});
