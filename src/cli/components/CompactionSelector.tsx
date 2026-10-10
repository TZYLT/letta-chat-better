// Compaction settings overlay: the mode picker plus an editable compression rate.
//
// `/compaction` owns two settings that only work together. `sliding_window`
// compresses `sliding_window_percentage` of the transcript every time it runs,
// so the rate is a real setting the user must be able to read *and* change —
// otherwise it can only be changed by editing the agent's settings by hand.

import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { Box, useInput } from "ink";
import { memo, useCallback, useMemo, useState } from "react";
import { LOCAL_DEFAULT_SLIDING_WINDOW_PERCENTAGE } from "@/backend/local/compaction";
import {
  availableCompactionModes,
  type CompactionMode,
  isCompactionMode,
} from "@/cli/helpers/compaction-mode";
import { colors } from "./colors";
import { OverlayShell } from "./OverlayShell";
import { PasteAwareTextInput } from "./PasteAwareTextInput";
import { SingleSelectPicker } from "./SingleSelectPicker";
import { Text } from "./Text";

const MODE_LABELS: Record<CompactionMode, string> = {
  all: "All",
  sliding_window: "Sliding Window",
  self_compact_all: "Self Compact All",
  self_compact_sliding_window: "Self Compact Sliding Window",
};

const MODE_DESCRIPTIONS: Record<CompactionMode, string> = {
  all: "Compact the entire context window each time.",
  sliding_window: "Compact older messages to stay within a token limit.",
  self_compact_all: "Agent self-compacts the entire context window each time.",
  self_compact_sliding_window:
    "Agent self-compacts older messages to stay within a token limit.",
};

/**
 * Picker row key for the compression-rate editor. It is deliberately not a
 * `CompactionMode`: picking it opens a second view instead of saving a mode.
 */
export const COMPRESSION_RATE_ROW_KEY = "compression-rate";

/** The smallest and largest rate the editor accepts, as whole percents. */
export const MIN_COMPRESSION_PERCENT = 1;
export const MAX_COMPRESSION_PERCENT = 100;

function parseMode(raw: string | null | undefined): CompactionMode {
  return isCompactionMode(raw) ? raw : "sliding_window";
}

/** The stored fraction as the whole percent the UI shows. */
export function compressionPercentFor(percentage: number): number {
  return Math.round(percentage * 100);
}

export interface CompactionSelection {
  mode: CompactionMode;
  /**
   * The new compression rate, present only when the user edited it in this
   * overlay. Absent means "leave the stored rate alone", which is what picking a
   * mode has always meant.
   */
  compressionPercentage?: number;
}

export interface CompactionSelectorProps {
  settings: AgentState["compaction_settings"];
  onSave: (selection: CompactionSelection) => void;
  onCancel: () => void;
}

export interface CompactionModeItem {
  key: CompactionMode;
  label: string;
  description: string;
  isCurrent: boolean;
}

/** A picker row: either a compaction mode or the compression-rate editor. */
export interface CompactionPickerRow {
  key: string;
  label: string;
  description: string;
  isCurrent: boolean;
}

/** What a user can type into the rate editor, or why they cannot. */
export type CompressionRateInput =
  | { ok: true; percentage: number }
  | { ok: false; error: string };

/**
 * Parse the rate editor's text as a whole percent. The editor holds the value to
 * 1–100 so a typo can never reach the store as the nonsense the backend would
 * silently clamp (≤0 → 0.1, >1 → 1).
 *
 * A trailing `%` is accepted because people type it.
 */
export function parseCompressionRateInput(raw: string): CompressionRateInput {
  const text = raw.trim().replace(/%$/, "").trim();
  if (text === "") {
    return {
      ok: false,
      error: `Enter a percentage from ${MIN_COMPRESSION_PERCENT} to ${MAX_COMPRESSION_PERCENT}.`,
    };
  }
  const percent = Number(text);
  if (!Number.isInteger(percent)) {
    return {
      ok: false,
      error: "Enter a whole number of percent (no decimals).",
    };
  }
  if (percent < MIN_COMPRESSION_PERCENT || percent > MAX_COMPRESSION_PERCENT) {
    return {
      ok: false,
      error: `Enter a percentage from ${MIN_COMPRESSION_PERCENT} to ${MAX_COMPRESSION_PERCENT}.`,
    };
  }
  return { ok: true, percentage: percent / 100 };
}

/**
 * Build the picker rows. Pure so the mode gating and the compression copy are
 * testable without rendering Ink.
 */
export function buildCompactionModeItems(input: {
  modes: readonly CompactionMode[];
  currentMode: CompactionMode;
  compressionPercentage: number;
}): CompactionModeItem[] {
  const compressed = compressionPercentFor(input.compressionPercentage);
  return input.modes.map((mode) => ({
    key: mode,
    label: MODE_LABELS[mode],
    description:
      mode === "sliding_window"
        ? `${MODE_DESCRIPTIONS[mode]} Compresses about ${compressed}% of the conversation each time (keeps about ${100 - compressed}%).`
        : MODE_DESCRIPTIONS[mode],
    isCurrent: mode === input.currentMode,
  }));
}

/**
 * The picker as a whole: every runnable mode, then the rate editor. The editor
 * row comes last so `initialCursorIndex` still lands on the current mode.
 */
export function buildCompactionPickerRows(input: {
  modes: readonly CompactionMode[];
  currentMode: CompactionMode;
  compressionPercentage: number;
}): CompactionPickerRow[] {
  const compressed = compressionPercentFor(input.compressionPercentage);
  return [
    ...buildCompactionModeItems(input),
    {
      key: COMPRESSION_RATE_ROW_KEY,
      label: "Compression rate",
      description: `Compresses about ${compressed}% each time (keeps about ${100 - compressed}%). Enter to change it.`,
      isCurrent: false,
    },
  ];
}

/** The compression rate is the other half of `sliding_window`. */
export function compressionPercentageFor(
  settings: AgentState["compaction_settings"],
): number {
  return (
    settings?.sliding_window_percentage ??
    LOCAL_DEFAULT_SLIDING_WINDOW_PERCENTAGE
  );
}

interface CompressionRateEditorProps {
  currentPercentage: number;
  onSave: (percentage: number) => void;
  /** Esc: back to the picker without saving. */
  onBack: () => void;
  /** Ctrl-C: close the whole overlay without saving. */
  onCancel: () => void;
}

/**
 * Second view of the overlay: one line of text for the rate. Mirrors
 * `PinDialog`'s input mode — the text field owns typing, this component owns the
 * two keys that leave it.
 */
function CompressionRateEditor({
  currentPercentage,
  onSave,
  onBack,
  onCancel,
}: CompressionRateEditorProps) {
  const currentPercent = compressionPercentFor(currentPercentage);
  const [draft, setDraft] = useState(String(currentPercent));
  const [error, setError] = useState("");

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onCancel();
      return;
    }
    if (key.escape) {
      onBack();
    }
  });

  const submit = useCallback(
    (text: string) => {
      const parsed = parseCompressionRateInput(text);
      if (!parsed.ok) {
        setError(parsed.error);
        return;
      }
      onSave(parsed.percentage);
    },
    [onSave],
  );

  return (
    <OverlayShell command="/compaction" title="Compression rate">
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text>
            {`Compress what percent of the conversation on each /compact? Currently ${currentPercent}% (keeps ${100 - currentPercent}%).`}
          </Text>
        </Box>

        <Box>
          <Text color={colors.approval.header}>{"> "}</Text>
          <PasteAwareTextInput
            value={draft}
            onChange={(value) => {
              setDraft(value);
              setError("");
            }}
            onSubmit={submit}
            placeholder={String(currentPercent)}
          />
        </Box>

        {error ? (
          <Box marginTop={1}>
            <Text color="red">{error}</Text>
          </Box>
        ) : null}

        <Box marginTop={1}>
          <Text dimColor>
            {`Enter to save (${MIN_COMPRESSION_PERCENT}-${MAX_COMPRESSION_PERCENT}) · Esc back · Ctrl-C cancel`}
          </Text>
        </Box>
      </Box>
    </OverlayShell>
  );
}

export const CompactionSelector = memo(function CompactionSelector({
  settings,
  onSave,
  onCancel,
}: CompactionSelectorProps) {
  const modes = useMemo(() => availableCompactionModes(), []);
  const currentMode = useMemo(
    () => parseMode(settings?.mode),
    [settings?.mode],
  );
  const compressionPercentage = compressionPercentageFor(settings);
  const [editingRate, setEditingRate] = useState(false);

  const rows = useMemo(
    () =>
      buildCompactionPickerRows({
        modes,
        currentMode,
        compressionPercentage,
      }),
    [modes, currentMode, compressionPercentage],
  );

  const handleSelect = useCallback(
    (key: string) => {
      if (key === COMPRESSION_RATE_ROW_KEY) {
        setEditingRate(true);
        return;
      }
      onSave({ mode: key as CompactionMode });
    },
    [onSave],
  );

  const saveRate = useCallback(
    (percentage: number) => {
      onSave({ mode: currentMode, compressionPercentage: percentage });
    },
    [currentMode, onSave],
  );

  if (editingRate) {
    return (
      <CompressionRateEditor
        currentPercentage={compressionPercentage}
        onSave={saveRate}
        onBack={() => setEditingRate(false)}
        onCancel={onCancel}
      />
    );
  }

  const initialCursorIndex = Math.max(0, modes.indexOf(currentMode));

  return (
    <OverlayShell command="/compaction" title="Configure compaction mode">
      <SingleSelectPicker
        items={rows}
        initialCursorIndex={initialCursorIndex}
        onSelect={handleSelect}
        onCancel={onCancel}
        footer=" Enter select · ↑↓/jk navigate · Esc cancel · the last row edits the compression rate"
      />
    </OverlayShell>
  );
});
