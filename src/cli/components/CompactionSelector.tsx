// Compaction mode selector.
// Wraps SingleSelectPicker with compaction-specific logic.

import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { memo, useMemo } from "react";
import { LOCAL_DEFAULT_SLIDING_WINDOW_PERCENTAGE } from "@/backend/local/compaction";
import {
  availableCompactionModes,
  type CompactionMode,
  isCompactionMode,
} from "@/cli/helpers/compaction-mode";
import { OverlayShell } from "./OverlayShell";
import { SingleSelectPicker } from "./SingleSelectPicker";

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

function parseMode(raw: string | null | undefined): CompactionMode {
  return isCompactionMode(raw) ? raw : "sliding_window";
}

export interface CompactionSelectorProps {
  settings: AgentState["compaction_settings"];
  onSave: (mode: CompactionMode) => void;
  onCancel: () => void;
}

export interface CompactionModeItem {
  key: CompactionMode;
  label: string;
  description: string;
  isCurrent: boolean;
}

/**
 * Build the picker rows. Pure so the mode gating and the retention copy are
 * testable without rendering Ink.
 */
export function buildCompactionModeItems(input: {
  modes: readonly CompactionMode[];
  currentMode: CompactionMode;
  retentionPercentage: number;
}): CompactionModeItem[] {
  return input.modes.map((mode) => ({
    key: mode,
    label: MODE_LABELS[mode],
    description:
      mode === "sliding_window"
        ? `${MODE_DESCRIPTIONS[mode]} Retention: keeps about ${Math.round(input.retentionPercentage * 100)}% of the context window.`
        : MODE_DESCRIPTIONS[mode],
    isCurrent: mode === input.currentMode,
  }));
}

/** The retention ratio is the other half of `sliding_window`. */
export function retentionPercentageFor(
  settings: AgentState["compaction_settings"],
): number {
  return (
    settings?.sliding_window_percentage ??
    LOCAL_DEFAULT_SLIDING_WINDOW_PERCENTAGE
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

  const items = useMemo(
    () =>
      buildCompactionModeItems({
        modes,
        currentMode,
        retentionPercentage: retentionPercentageFor(settings),
      }),
    [modes, currentMode, settings],
  );

  const initialCursorIndex = Math.max(0, modes.indexOf(currentMode));

  return (
    <OverlayShell command="/compaction" title="Configure compaction mode">
      <SingleSelectPicker
        items={items}
        initialCursorIndex={initialCursorIndex}
        onSelect={(key) => onSave(key as CompactionMode)}
        onCancel={onCancel}
      />
    </OverlayShell>
  );
});
