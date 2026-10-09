#!/usr/bin/env bun
/**
 * Verify prefix stability from payloads captured by the D-008 probe.
 *
 * Usage:
 *   bun scripts/verify-prefix-probe.ts [probe-dir]
 *
 * Reads `<probe-dir>/payload-*.json` (defaults to $HARUYUKI_PREFIX_PROBE_DIR),
 * compares adjacent turns per conversation, and exits non-zero when the system
 * segment or tools field drifted between turns. This is the repeatable,
 * script-level form of V0/V1/V12/V13 (implementation route §5.1).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  analyzePrefixProbe,
  formatPrefixProbeReport,
  type PrefixProbeRecord,
} from "@/backend/dev/prefix-probe";

function resolveDir(): string {
  const fromArgv = process.argv[2]?.trim();
  const fromEnv = process.env.HARUYUKI_PREFIX_PROBE_DIR?.trim();
  const dir =
    fromArgv && fromArgv.length > 0
      ? fromArgv
      : fromEnv && fromEnv.length > 0
        ? fromEnv
        : undefined;
  if (!dir) {
    console.error("usage: bun scripts/verify-prefix-probe.ts <probe-dir>");
    console.error("  (or set HARUYUKI_PREFIX_PROBE_DIR)");
    process.exit(2);
  }
  return dir;
}

function readRecords(dir: string): PrefixProbeRecord[] {
  const files = readdirSync(dir)
    .filter((name) => name.startsWith("payload-") && name.endsWith(".json"))
    .sort();
  const records: PrefixProbeRecord[] = [];
  for (const name of files) {
    const parsed = JSON.parse(readFileSync(join(dir, name), "utf8")) as {
      conversationId?: unknown;
      seq?: unknown;
      payload?: unknown;
    };
    if (
      typeof parsed.conversationId !== "string" ||
      typeof parsed.seq !== "number"
    ) {
      continue;
    }
    records.push({
      conversationId: parsed.conversationId,
      seq: parsed.seq,
      payload: parsed.payload,
    });
  }
  return records;
}

const dir = resolveDir();
const records = readRecords(dir);
if (records.length === 0) {
  console.error(`no payload-*.json files in ${dir}`);
  process.exit(2);
}
const report = analyzePrefixProbe(records);
console.log(formatPrefixProbeReport(report));
process.exit(report.pass ? 0 : 1);
