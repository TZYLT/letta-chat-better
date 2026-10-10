/**
 * D-108: `/compaction` offers only what the local backend can run, and shows the
 * compression rate that `sliding_window` depends on.
 *
 * The rate is a real setting (every `/compact` compresses that fraction of the
 * transcript), so the overlay also lets the user change it — rows are built by
 * pure functions and asserted here, and the mount tests at the end cover what
 * pure functions cannot see: the picker hands its hint line to
 * `SingleSelectPicker` as a raw string prop, and Ink rejects a string child that
 * is not wrapped in `<Text>`. Without a mount, that mistake is invisible until a
 * user opens `/compaction`.
 */
import { describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import stripAnsi from "strip-ansi";
import {
  buildCompactionModeItems,
  buildCompactionPickerRows,
  COMPRESSION_RATE_ROW_KEY,
  CompactionSelector,
  compressionPercentageFor,
  compressionPercentFor,
  parseCompressionRateInput,
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

describe("buildCompactionPickerRows", () => {
  test("appends the rate editor after the modes, keeping the cursor on the mode", () => {
    const rows = buildCompactionPickerRows({
      modes: ["sliding_window"],
      currentMode: "sliding_window",
      compressionPercentage: 0.3,
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]?.key).toBe("sliding_window");
    expect(rows[1]?.key).toBe(COMPRESSION_RATE_ROW_KEY);
    // The editor row is not the current *mode*, so it must not claim "(current)".
    expect(rows[1]?.isCurrent).toBe(false);
    // It still has to state the value it would change.
    expect(rows[1]?.label).toBe("Compression rate");
    expect(rows[1]?.description).toContain("Compresses about 30%");
    expect(rows[1]?.description).toContain("keeps about 70%");
    expect(rows[1]?.description).toContain("Enter to change it");
  });
});

describe("parseCompressionRateInput", () => {
  test("accepts a whole percent and stores it as a fraction", () => {
    expect(parseCompressionRateInput("30")).toEqual({
      ok: true,
      percentage: 0.3,
    });
    expect(parseCompressionRateInput(" 5 ")).toEqual({
      ok: true,
      percentage: 0.05,
    });
    // People type the sign.
    expect(parseCompressionRateInput("70%")).toEqual({
      ok: true,
      percentage: 0.7,
    });
    expect(parseCompressionRateInput("1")).toEqual({
      ok: true,
      percentage: 0.01,
    });
    expect(parseCompressionRateInput("100")).toEqual({
      ok: true,
      percentage: 1,
    });
  });

  test("rejects what the backend would otherwise silently clamp", () => {
    // ≤0 would become 0.1 and >1 would become 1 in the store, so the editor
    // refuses them instead of showing a value the user never asked for.
    for (const bad of ["0", "-10", "101", "0.5", "abc", "", "   ", "%"]) {
      const result = parseCompressionRateInput(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.length).toBeGreaterThan(0);
      }
    }
    const zero = parseCompressionRateInput("0");
    expect(zero.ok === false && zero.error).toContain("1 to 100");
    const decimal = parseCompressionRateInput("0.5");
    expect(decimal.ok === false && decimal.error).toContain("whole number");
  });
});

describe("compressionPercentFor", () => {
  test("rounds the stored fraction to the percent the UI shows", () => {
    expect(compressionPercentFor(0.3)).toBe(30);
    expect(compressionPercentFor(0.456)).toBe(46);
    expect(compressionPercentFor(1)).toBe(100);
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

/** Captures Ink output at a fixed terminal width. */
class CaptureStream extends Writable {
  columns: number;
  rows = 24;
  isTTY = true;
  chunks: string[] = [];

  constructor(columns: number) {
    super();
    this.columns = columns;
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.chunks.push(String(chunk));
    callback();
  }
}

/** Renders the picker into a captured TTY and returns the stripped output. */
async function renderCompactionSelector(columns = 100): Promise<string> {
  const stdout = new CaptureStream(columns) as CaptureStream &
    NodeJS.WriteStream;
  const stdin = new Readable({ read() {} }) as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;

  const instance = render(
    <CompactionSelector
      settings={{ mode: "sliding_window", sliding_window_percentage: 0.3 }}
      onSave={() => {}}
      onCancel={() => {}}
    />,
    {
      stdout,
      stdin,
      debug: false,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 20));
  instance.unmount();
  instance.cleanup();

  return stripAnsi(stdout.chunks.join(""));
}

describe("CompactionSelector mount", () => {
  test("paints the modes and the rate row without an Ink text error", async () => {
    const output = await renderCompactionSelector(100);

    // The hint line is the regression: it is passed as a plain string prop, so
    // the picker must wrap it in `<Text>`. Rendered raw, Ink throws during
    // commit and the tree never paints — which fails every assertion below.
    expect(output).toContain("Enter select");
    expect(output).toContain("Esc cancel");
    expect(output).not.toContain("must be rendered inside");

    expect(output).toContain("Configure compaction mode");
    expect(output).toContain("Sliding Window");
    // Ink wraps the `(current)` marker onto its own line, so it is asserted
    // separately rather than glued to the label.
    expect(output).toContain("(current)");
    // At 100 columns the rate row fits on one line.
    expect(output).toContain("Compression rate ·");
  });

  test("keeps the rate row and its hint in a narrow terminal", async () => {
    const output = await renderCompactionSelector(60);

    // The label itself wraps at 60 columns ("Compression" / "rate") — expected
    // Ink behaviour for a wide label, not a defect. What matters is that the row
    // and its hint survive the wrap without an Ink text error.
    expect(output).not.toContain("must be rendered inside");
    expect(output).toContain("Compression");
    expect(output).toContain("rate");
    expect(output).toContain("Compresses about 30% each time");
    expect(output).toContain("Enter to change it");
    expect(output).toContain("the last row");
  });
});
