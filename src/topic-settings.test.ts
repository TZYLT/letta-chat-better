/**
 * The five topic knobs (feature ③, D-115).
 *
 * Two claims matter: an unusable value must never reach a reader (a negative
 * turn count or a ratio of 1.5 would change behaviour in surprising directions),
 * and `0` must survive as "this mechanism is off" rather than being treated as
 * missing. The settings file is the only write path, so one test drives the knob
 * through `settings.json` and `initialize()`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingsManager } from "@/settings-manager";
import {
  readTopicSettings,
  resolveTopicSettings,
  TOPIC_SETTING_DEFAULTS,
} from "@/topic-settings";

const originalHome = process.env.HOME;
let testHomeDir: string;

beforeEach(async () => {
  await settingsManager.reset();
  testHomeDir = await mkdtemp(join(tmpdir(), "letta-topic-settings-"));
  process.env.HOME = testHomeDir;
});

afterEach(async () => {
  await settingsManager.reset();
  await rm(testHomeDir, { recursive: true, force: true });
  process.env.HOME = originalHome;
});

function writeSettings(record: Record<string, unknown>): void {
  mkdirSync(join(testHomeDir, ".haruyuki"), { recursive: true });
  writeFileSync(
    join(testHomeDir, ".haruyuki", "settings.json"),
    JSON.stringify(record, null, 2),
  );
}

describe("resolveTopicSettings", () => {
  test("falls back to the documented defaults", () => {
    expect(resolveTopicSettings(undefined)).toEqual(TOPIC_SETTING_DEFAULTS);
    expect(resolveTopicSettings({})).toEqual(TOPIC_SETTING_DEFAULTS);
    expect(TOPIC_SETTING_DEFAULTS).toEqual({
      markerWarnTurns: 10,
      markerRejectTurns: 5,
      nudgeTurns: 50,
      softPressureRatio: 0.7,
      boundaryRewindTurns: 2,
    });
  });

  test("keeps 0 as 'this mechanism is off'", () => {
    const resolved = resolveTopicSettings({
      topicMarkerWarnTurns: 0,
      topicMarkerRejectTurns: 0,
      topicNudgeTurns: 0,
      topicBoundaryRewindTurns: 0,
    });
    expect(resolved.markerWarnTurns).toBe(0);
    expect(resolved.markerRejectTurns).toBe(0);
    expect(resolved.nudgeTurns).toBe(0);
    expect(resolved.boundaryRewindTurns).toBe(0);
  });

  test("ignores values a reader could not use", () => {
    const resolved = resolveTopicSettings({
      topicMarkerWarnTurns: -3,
      topicMarkerRejectTurns: Number.NaN,
      topicNudgeTurns: Number.POSITIVE_INFINITY,
      topicSoftPressureRatio: "0.5",
      topicBoundaryRewindTurns: -1,
    });
    expect(resolved).toEqual(TOPIC_SETTING_DEFAULTS);
  });

  test("truncates fractional turn counts", () => {
    expect(
      resolveTopicSettings({
        topicMarkerWarnTurns: 12.9,
        topicMarkerRejectTurns: 5.4,
        topicNudgeTurns: 51.7,
      }),
    ).toMatchObject({
      markerWarnTurns: 12,
      markerRejectTurns: 5,
      nudgeTurns: 51,
    });
  });

  test("clamps the soft ratio to (0, 1] and treats 0 as 'no soft tier'", () => {
    expect(
      resolveTopicSettings({ topicSoftPressureRatio: 0.5 }).softPressureRatio,
    ).toBe(0.5);
    // 1 is what contextPressureLevel documents as disabling the soft tier.
    expect(
      resolveTopicSettings({ topicSoftPressureRatio: 0 }).softPressureRatio,
    ).toBe(1);
    expect(
      resolveTopicSettings({ topicSoftPressureRatio: -2 }).softPressureRatio,
    ).toBe(1);
    expect(
      resolveTopicSettings({ topicSoftPressureRatio: 1.5 }).softPressureRatio,
    ).toBe(1);
  });

  test("clamps the boundary rewind to the supported range", () => {
    expect(
      resolveTopicSettings({ topicBoundaryRewindTurns: 3 }).boundaryRewindTurns,
    ).toBe(3);
    expect(
      resolveTopicSettings({ topicBoundaryRewindTurns: 9 }).boundaryRewindTurns,
    ).toBe(3);
    expect(
      resolveTopicSettings({ topicBoundaryRewindTurns: 1 }).boundaryRewindTurns,
    ).toBe(1);
  });
});

describe("readTopicSettings", () => {
  test("returns the defaults when settings are not loaded yet", () => {
    expect(readTopicSettings()).toEqual(TOPIC_SETTING_DEFAULTS);
    expect(readTopicSettings().nudgeTurns).toBe(
      TOPIC_SETTING_DEFAULTS.nudgeTurns,
    );
  });

  test("reads the knobs from the settings file", async () => {
    writeSettings({
      topicMarkerWarnTurns: 20,
      topicMarkerRejectTurns: 3,
      topicNudgeTurns: 12,
      topicSoftPressureRatio: 0.9,
      topicBoundaryRewindTurns: 0,
    });
    await settingsManager.initialize();

    expect(readTopicSettings()).toEqual({
      markerWarnTurns: 20,
      markerRejectTurns: 3,
      nudgeTurns: 12,
      softPressureRatio: 0.9,
      boundaryRewindTurns: 0,
    });
    expect(readTopicSettings().markerRejectTurns).toBe(3);
  });

  test("a knob written through updateSettings is read back", async () => {
    await settingsManager.initialize();
    settingsManager.updateSettings({ topicNudgeTurns: 7 });
    expect(readTopicSettings().nudgeTurns).toBe(7);
  });
});
