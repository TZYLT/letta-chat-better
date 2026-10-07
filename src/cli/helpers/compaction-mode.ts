/**
 * Compaction modes, and which of them the only backend can actually run
 * (feature ③ D-108).
 *
 * The local backend runs `sliding_window` only: feature ③ deleted the `all`
 * fallback, and `self_compact_*` was never supported there. `ALL_MODES` stays
 * as the wire vocabulary so an unknown mode and a known-but-unsupported mode
 * still produce different errors.
 */
export type CompactionMode =
  | "all"
  | "sliding_window"
  | "self_compact_all"
  | "self_compact_sliding_window";

const ALL_MODES: readonly CompactionMode[] = [
  "all",
  "sliding_window",
  "self_compact_all",
  "self_compact_sliding_window",
];

export const LOCAL_COMPACTION_MODE: CompactionMode = "sliding_window";

export function isCompactionMode(value: unknown): value is CompactionMode {
  return ALL_MODES.includes(value as CompactionMode);
}

/** Modes to offer in the `/compaction` picker. */
export function availableCompactionModes(): CompactionMode[] {
  return [LOCAL_COMPACTION_MODE];
}

/**
 * Validate a chosen mode.
 *
 * Throws rather than quietly rewriting the mode: the caller's error path already
 * reports failures, and a queued overlay action can carry a mode the user picked
 * before the backend changed.
 */
export function assertCompactionModeForBackend(mode: string): CompactionMode {
  if (!isCompactionMode(mode)) {
    throw new Error(
      `Unknown compaction mode "${mode}". Valid modes: ${ALL_MODES.join(", ")}.`,
    );
  }
  if (!availableCompactionModes().includes(mode)) {
    throw new Error(
      `The local backend only runs the "${LOCAL_COMPACTION_MODE}" compaction mode; "${mode}" is not available here.`,
    );
  }
  return mode;
}
