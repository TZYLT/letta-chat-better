/**
 * Compaction modes, and which of them the active backend can actually run
 * (feature ③ D-108).
 *
 * The local backend runs `sliding_window` only: feature ③ deleted the `all`
 * fallback, and `self_compact_*` was never supported there. The hosted backend
 * keeps the full set, so this is display and validation policy rather than a
 * property of the mode list itself.
 */
import { isExperimentalLocalBackendEnabled } from "@/backend/backend-mode";

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

/** Modes to offer in the `/compaction` picker for the active backend. */
export function availableCompactionModes(): CompactionMode[] {
  return isExperimentalLocalBackendEnabled()
    ? [LOCAL_COMPACTION_MODE]
    : [...ALL_MODES];
}

/**
 * Validate a chosen mode against the active backend.
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
