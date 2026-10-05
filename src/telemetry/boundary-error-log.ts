/**
 * Local JSONL log for boundary errors.
 *
 * Replaces the cloud error pipeline: the writers in `error-reporting.ts` and
 * `telemetry.trackError` no longer POST anywhere, so the only place a boundary
 * error survives is this file. Diagnostics stay available with zero network
 * egress.
 *
 * Disk usage is bounded the same way the remote session log bounds it: the
 * active file rotates into a numbered archive once it passes
 * `MAX_BOUNDARY_LOG_BYTES`, and the oldest archive beyond
 * `MAX_BOUNDARY_LOG_FILES` is deleted. Without the size cap, a long-running
 * session that keeps hitting one boundary error would grow a single file until
 * the disk fills.
 *
 * Every write is best-effort by design: callers sit on error paths that must
 * not throw, and a diagnostic must never mask the failure it reports.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BOUNDARY_LOG_DIR = join(homedir(), ".letta", "logs");
const BOUNDARY_LOG_BASENAME = "boundary-errors";

/** Per-file byte cap. The active file rotates once it reaches this size. */
export const MAX_BOUNDARY_LOG_BYTES = 10 * 1024 * 1024;
/** Retained files, active file included: worst case 10 files x 10 MB. */
export const MAX_BOUNDARY_LOG_FILES = 10;

export interface BoundaryErrorEntry {
  errorType: string;
  message: string;
  context?: string;
  httpStatus?: number;
  modelId?: string;
  runId?: string;
  recentChunks?: Record<string, unknown>[];
  /** Tail of the debug log file, omitted for messages that may embed paths. */
  debugLogTail?: string;
  isSubagent?: boolean;
  subagentType?: string;
  modelHandle?: string;
  fallbackKind?: string;
  sessionId?: string;
  agentId?: string;
  agentOrigin?: string;
  surface?: string;
  platform?: string;
  version?: string;
}

export interface BoundaryErrorLogOptions {
  /** Override the log directory (tests). Defaults to `~/.letta/logs`. */
  dir?: string;
  /** Override the per-file byte cap (tests). */
  maxBytes?: number;
  /** Override the retained file count, active file included (tests). */
  maxFiles?: number;
}

function activePath(dir: string): string {
  return join(dir, `${BOUNDARY_LOG_BASENAME}.jsonl`);
}

function archivePath(dir: string, index: number): string {
  return join(dir, `${BOUNDARY_LOG_BASENAME}.${index}.jsonl`);
}

/** Absolute path of the file this module appends to. */
export function boundaryErrorLogPath(
  options: BoundaryErrorLogOptions = {},
): string {
  return activePath(options.dir ?? BOUNDARY_LOG_DIR);
}

/**
 * Append one JSON line. Never throws, never blocks on the network.
 */
export function appendBoundaryError(
  entry: BoundaryErrorEntry,
  options: BoundaryErrorLogOptions = {},
): void {
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
  try {
    const dir = options.dir ?? BOUNDARY_LOG_DIR;
    ensureDir(dir);
    rotateIfNeeded(
      dir,
      options.maxBytes ?? MAX_BOUNDARY_LOG_BYTES,
      options.maxFiles ?? MAX_BOUNDARY_LOG_FILES,
    );
    appendFileSync(activePath(dir), line, { encoding: "utf8" });
  } catch {
    // Best-effort: never surface a logging failure to the caller.
  }
}

function rotateIfNeeded(dir: string, maxBytes: number, maxFiles: number): void {
  const active = activePath(dir);
  let size: number;
  try {
    size = statSync(active).size;
  } catch {
    return; // Nothing written yet.
  }
  if (size < maxBytes) {
    return;
  }

  if (maxFiles < 2) {
    unlinkSync(active);
    return;
  }

  // Shift archives up, dropping the oldest, then start a fresh active file.
  const oldest = archivePath(dir, maxFiles - 1);
  if (existsSync(oldest)) {
    unlinkSync(oldest);
  }
  for (let index = maxFiles - 2; index >= 1; index -= 1) {
    const from = archivePath(dir, index);
    if (existsSync(from)) {
      renameSync(from, archivePath(dir, index + 1));
    }
  }
  renameSync(active, archivePath(dir, 1));
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
