/**
 * The topic channel's tunables (feature ③, D-115).
 *
 * The five knobs are read from four different layers — the `TopicMark` gate in
 * `tools/`, the trim planner in `backend/local/`, the pre-send pressure check
 * and the no-marker nudge in `cli/` — so they are resolved here, once, instead
 * of each reader re-deriving them from raw settings.
 *
 * They live in this module rather than in `settings-manager.ts` because that
 * file is pinned exactly at its size baseline (it may only shrink). The keys
 * themselves are declared on `Settings` by module augmentation below, so
 * `settingsManager.getSetting("topicNudgeTurns")` stays typed and the generic
 * settings path — load, `updateSettings`, persistence — needs no per-key code.
 *
 * Scope: **global**, like `topicMarkingEnabled` and `includeWorktreeTool`, and
 * for the same reason — the tool gate and the local backend read them without a
 * project scope in their call path, so a per-project override could not be read
 * consistently (documented deviation from the three-level rule).
 */
import { DEFAULT_CONTEXT_SOFT_PRESSURE_RATIO } from "@/backend/dev/provider-turn-executor";
import {
  DEFAULT_TOPIC_BOUNDARY_REWIND_TURNS,
  DEFAULT_TOPIC_MARKER_REJECT_TURNS,
  DEFAULT_TOPIC_MARKER_WARN_TURNS,
  DEFAULT_TOPIC_NUDGE_TURNS,
  MAX_TOPIC_BOUNDARY_REWIND_TURNS,
} from "@/backend/local/topic-compaction";
import { settingsManager } from "@/settings-manager";

declare module "@/settings-manager" {
  interface Settings {
    /** Agent markers sooner than this many user turns are warned about. 0 = off. */
    topicMarkerWarnTurns?: number;
    /** Agent markers sooner than this many user turns are refused. 0 = off. */
    topicMarkerRejectTurns?: number;
    /** User turns without a marker before the one-shot nudge. 0 = off. */
    topicNudgeTurns?: number;
    /** Advisory pressure share of the window. 0 = the soft tier is off. */
    topicSoftPressureRatio?: number;
    /** User turns the effective boundary rewinds from a marker anchor (0–3). */
    topicBoundaryRewindTurns?: number;
  }
}

/** The settings keys this module owns, for callers that write them. */
export const TOPIC_SETTING_KEYS = [
  "topicMarkerWarnTurns",
  "topicMarkerRejectTurns",
  "topicNudgeTurns",
  "topicSoftPressureRatio",
  "topicBoundaryRewindTurns",
] as const;

export type TopicSettingKey = (typeof TOPIC_SETTING_KEYS)[number];

/** Every knob resolved; the shape the rest of the app consumes. */
export interface ResolvedTopicSettings {
  markerWarnTurns: number;
  markerRejectTurns: number;
  nudgeTurns: number;
  softPressureRatio: number;
  boundaryRewindTurns: number;
}

export const TOPIC_SETTING_DEFAULTS: ResolvedTopicSettings = {
  markerWarnTurns: DEFAULT_TOPIC_MARKER_WARN_TURNS,
  markerRejectTurns: DEFAULT_TOPIC_MARKER_REJECT_TURNS,
  nudgeTurns: DEFAULT_TOPIC_NUDGE_TURNS,
  softPressureRatio: DEFAULT_CONTEXT_SOFT_PRESSURE_RATIO,
  boundaryRewindTurns: DEFAULT_TOPIC_BOUNDARY_REWIND_TURNS,
};

/**
 * A turn threshold: `undefined` or unusable falls back to the default, `0` is
 * kept because it means "this mechanism is off".
 */
function resolveTurnThreshold(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.trunc(value);
}

/**
 * The soft tier's share of the window, clamped to `(0, 1]`.
 *
 * `0` (or anything at or below it) means "no soft advice" and resolves to `1`,
 * the value `contextPressureLevel` documents as disabling the tier: the hard
 * threshold is always the lower boundary, so a ratio of 1 can never win.
 */
function resolveSoftPressureRatio(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return TOPIC_SETTING_DEFAULTS.softPressureRatio;
  }
  if (value <= 0) return 1;
  return Math.min(value, 1);
}

/** Resolve every knob from a settings record, ignoring unusable values. */
export function resolveTopicSettings(
  record: Partial<Record<TopicSettingKey, unknown>> | undefined,
): ResolvedTopicSettings {
  if (!record) return { ...TOPIC_SETTING_DEFAULTS };
  const rewind = record.topicBoundaryRewindTurns;
  return {
    markerWarnTurns: resolveTurnThreshold(
      record.topicMarkerWarnTurns,
      TOPIC_SETTING_DEFAULTS.markerWarnTurns,
    ),
    markerRejectTurns: resolveTurnThreshold(
      record.topicMarkerRejectTurns,
      TOPIC_SETTING_DEFAULTS.markerRejectTurns,
    ),
    nudgeTurns: resolveTurnThreshold(
      record.topicNudgeTurns,
      TOPIC_SETTING_DEFAULTS.nudgeTurns,
    ),
    softPressureRatio: resolveSoftPressureRatio(record.topicSoftPressureRatio),
    boundaryRewindTurns:
      typeof rewind === "number" && Number.isFinite(rewind) && rewind >= 0
        ? Math.min(MAX_TOPIC_BOUNDARY_REWIND_TURNS, Math.trunc(rewind))
        : TOPIC_SETTING_DEFAULTS.boundaryRewindTurns,
  };
}

/**
 * The knobs as configured. Settings unavailable (early startup, tests without
 * an initialized manager) falls back to the defaults rather than throwing:
 * every reader runs on a path that must not fail because of a preference.
 */
export function readTopicSettings(): ResolvedTopicSettings {
  try {
    return resolveTopicSettings(settingsManager.getSettings());
  } catch {
    return { ...TOPIC_SETTING_DEFAULTS };
  }
}

/** One knob's resolved value, for a reader that needs only that one. */
export function readTopicSetting<K extends keyof ResolvedTopicSettings>(
  key: K,
): ResolvedTopicSettings[K] {
  return readTopicSettings()[key];
}
