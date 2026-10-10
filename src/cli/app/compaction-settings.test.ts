/**
 * `/compaction` reports only what the user changed, so the merge is the whole
 * contract: picking a mode must not reset the compression rate, and editing the
 * rate must not reset the mode or the compaction model.
 */
import { describe, expect, test } from "bun:test";
import {
  buildCompactionSettings,
  formatCompactionUpdate,
} from "@/cli/app/compaction-settings";

describe("buildCompactionSettings", () => {
  test("a mode pick keeps the stored rate and model", () => {
    const next = buildCompactionSettings(
      {
        mode: "all",
        model: "custom/summarizer",
        sliding_window_percentage: 0.5,
      },
      { mode: "sliding_window" },
    );

    expect(next).toEqual({
      mode: "sliding_window",
      model: "custom/summarizer",
      sliding_window_percentage: 0.5,
    });
  });

  test("a rate edit keeps the mode and model", () => {
    const next = buildCompactionSettings(
      { mode: "sliding_window", model: "custom/summarizer" },
      { mode: "sliding_window", compressionPercentage: 0.42 },
    );

    expect(next).toEqual({
      mode: "sliding_window",
      model: "custom/summarizer",
      sliding_window_percentage: 0.42,
    });
  });

  test("an edit that only changes the rate still writes the rate", () => {
    // The selection's mode is what the overlay had on screen, so it must survive
    // the round trip rather than being dropped as "unchanged".
    const next = buildCompactionSettings(null, {
      mode: "sliding_window",
      compressionPercentage: 0.1,
    });

    expect(next.mode).toBe("sliding_window");
    expect(next.sliding_window_percentage).toBe(0.1);
  });

  test("rejects a mode this backend cannot run", () => {
    expect(() =>
      buildCompactionSettings(null, {
        mode: "all" as unknown as "sliding_window",
      }),
    ).toThrow('only runs the "sliding_window" compaction mode');
  });
});

describe("formatCompactionUpdate", () => {
  test("a mode pick keeps the original receipt", () => {
    expect(
      formatCompactionUpdate({ mode: "sliding_window" }, "sliding_window"),
    ).toBe("Updated compaction mode to: sliding_window");
  });

  test("a rate edit states what the rate does, both ways round", () => {
    const receipt = formatCompactionUpdate(
      { mode: "sliding_window", compressionPercentage: 0.3 },
      "sliding_window",
    );

    expect(receipt).toContain("Compression rate set to 30%");
    expect(receipt).toContain("compresses about 30%");
    expect(receipt).toContain("keeps about 70%");
  });
});
