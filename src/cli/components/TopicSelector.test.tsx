/**
 * Row coverage for the topic picker (D-111), plus one mount test.
 *
 * The picker's copy is what tells a user which block is which and how much
 * context each one keeps, so the rows are built by pure functions and asserted
 * here rather than by rendering Ink. The mount test at the end covers the part
 * pure functions cannot see: the picker hands its hint line to
 * `SingleSelectPicker` as a raw string prop, and Ink rejects a string child
 * that is not wrapped in `<Text>`. Without a mount, that mistake is invisible
 * until a user opens `/compact`.
 */
import { describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import stripAnsi from "strip-ansi";
import type { TopicBlock } from "@/backend/local/topic-compaction";
import {
  buildTopicPickItems,
  buildTopicPickRows,
  initialTopicPickIndex,
  TOPIC_TRIM_CANCEL_KEY,
  TopicSelector,
} from "@/cli/components/TopicSelector";
import type { TopicTrimRequest } from "@/cli/helpers/topic-trim-request";

function block(overrides: Partial<TopicBlock> & { index: number }): TopicBlock {
  return {
    title: null,
    markerId: null,
    createdBy: null,
    anchorMessageId: null,
    absorbedTitles: [],
    boundaryMessageId: `m${overrides.index}`,
    startIndex: 0,
    endIndex: 0,
    rewindTurns: 0,
    startMarkerAnchorMessageId: null,
    messageCount: 1,
    tokens: 1,
    startsAt: "2026-01-01T10:00:00.000Z",
    sparse: false,
    ...overrides,
  };
}

const BLOCKS: TopicBlock[] = [
  block({
    index: 1,
    title: "Auth token refresh",
    messageCount: 8,
    tokens: 612,
    startsAt: "2026-01-01T10:00:00.000Z",
  }),
  block({
    index: 2,
    messageCount: 6,
    tokens: 480,
    startIndex: 8,
    endIndex: 14,
    rewindTurns: 2,
    startMarkerAnchorMessageId: "message-local-anchor",
    startsAt: "2026-01-01T10:04:00.000Z",
  }),
];

describe("buildTopicPickRows", () => {
  test("labels every block and never disables the trimmable ones", () => {
    const rows = buildTopicPickRows(BLOCKS);

    expect(rows.map((row) => row.key)).toEqual(["1", "2"]);
    expect(rows[0]?.label).toBe("1. Auth token refresh");
    expect(rows[0]?.disabled).toBe(true);
    expect(rows[1]?.label).toBe("2. Current topic (not marked finished)");
    expect(rows[1]?.disabled).toBe(false);
  });

  test("describes size, time, and how the boundary was derived", () => {
    const rows = buildTopicPickRows(BLOCKS);

    expect(rows[0]?.description).toBe(
      "8 messages · ~612 tokens · from 2026-01-01 10:00 · the start of the context",
    );
    expect(rows[1]?.description).toContain("6 messages · ~480 tokens");
    expect(rows[1]?.description).toContain(
      'marker "Auth token refresh" at message-local-anchor, rewound 2 user turns',
    );
  });

  test("a one-turn rewind is not pluralised, and zero says no rewind", () => {
    const single = buildTopicPickRows([
      block({ index: 1, title: "Alpha" }),
      block({
        index: 2,
        startIndex: 2,
        endIndex: 4,
        rewindTurns: 1,
        startMarkerAnchorMessageId: "a",
      }),
    ]);
    expect(single[1]?.description).toContain("rewound 1 user turn");

    const none = buildTopicPickRows([
      block({ index: 1, title: "Alpha" }),
      block({
        index: 2,
        startIndex: 2,
        endIndex: 4,
        rewindTurns: 0,
        startMarkerAnchorMessageId: "a",
      }),
    ]);
    expect(none[1]?.description).toContain("no rewind");
  });

  test("an unparseable start time is shown as-is", () => {
    const rows = buildTopicPickRows([
      block({ index: 1, startsAt: "not-a-date" }),
    ]);
    expect(rows[0]?.description).toContain("from not-a-date");
  });
});

describe("buildTopicPickItems", () => {
  test("appends a cancel row that is never a block number", () => {
    const items = buildTopicPickItems(BLOCKS);

    expect(items).toHaveLength(3);
    expect(items.at(-1)?.key).toBe(TOPIC_TRIM_CANCEL_KEY);
    expect(items.at(-1)?.label).toBe("Cancel");
  });
});

describe("initialTopicPickIndex", () => {
  test("lands on the suggested block", () => {
    expect(initialTopicPickIndex(buildTopicPickItems(BLOCKS), 2)).toBe(1);
  });

  test("falls back to the oldest selectable block when the suggestion is block 1", () => {
    // Block 1 keeps everything, so the cursor must not sit on it.
    expect(initialTopicPickIndex(buildTopicPickItems(BLOCKS), 1)).toBe(1);
  });

  test("lands on cancel when nothing can be trimmed at all", () => {
    const items = buildTopicPickItems([block({ index: 1, title: "Only" })]);
    expect(initialTopicPickIndex(items, 1)).toBe(1);
    expect(items[1]?.key).toBe(TOPIC_TRIM_CANCEL_KEY);
  });
});

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
async function renderTopicSelector(columns = 100): Promise<string> {
  const stdout = new CaptureStream(columns) as CaptureStream &
    NodeJS.WriteStream;
  const stdin = new Readable({ read() {} }) as NodeJS.ReadStream;
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;

  const request: TopicTrimRequest = {
    blocks: BLOCKS,
    suggestionIndex: 2,
    onPick: () => {},
  };

  const instance = render(
    <TopicSelector request={request} onCancel={() => {}} />,
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

describe("TopicSelector mount", () => {
  test("renders the hint line in a narrow terminal without an Ink text error", async () => {
    const output = await renderTopicSelector(100);

    // The hint line is the regression: it is passed as a plain string prop, so
    // the picker must wrap it in `<Text>`. Rendered raw, Ink throws during
    // commit and the tree never paints — which fails every assertion below.
    expect(output).toContain("Enter trim");
    expect(output).toContain("navigate");
    expect(output).toContain("Esc cancel");
    expect(output).not.toContain("must be rendered inside");

    // Still paints the overlay and every row when the row copy has to wrap.
    expect(output).toContain("Choose the topic block to keep");
    expect(output).toContain("1. Auth token refresh");
    expect(output).toContain("Current topic (not marked");
    expect(output).toContain('marker "Auth');
    expect(output).toContain("Cancel · keep the context as it is");
  });

  test("shows the full row copy in a wide terminal", async () => {
    const output = await renderTopicSelector(200);

    expect(output).toContain(
      "2. Current topic (not marked finished) · 6 messages · ~480 tokens",
    );
    expect(output).toContain(
      'marker "Auth token refresh" at message-local-anchor, rewound 2 user turns',
    );
    expect(output).toContain(" Enter trim · ↑↓/jk navigate · Esc cancel");
  });
});
