/**
 * Local JSONL log for boundary errors.
 *
 * Replaces the cloud error pipeline: the writers in `error-reporting.ts` and
 * `telemetry.trackError` no longer POST anywhere, so the only place a boundary
 * error survives is this file. Diagnostics stay available with zero network
 * egress.
 *
 * The size-bounded write itself lives in `./jsonl-log`, shared with the local
 * feedback sink; see that module for the rotation contract.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { createJsonlLog } from "./jsonl-log";

const BOUNDARY_LOG_DIR = join(homedir(), ".letta", "logs");
const BOUNDARY_LOG_BASENAME = "boundary-errors";

/** Per-file byte cap. The active file rotates once it reaches this size. */
export const MAX_BOUNDARY_LOG_BYTES = 10 * 1024 * 1024;
/** Retained files, active file included: worst case 10 files x 10 MB. */
export const MAX_BOUNDARY_LOG_FILES = 10;

const boundaryLog = createJsonlLog({
  basename: BOUNDARY_LOG_BASENAME,
  defaultDir: BOUNDARY_LOG_DIR,
  maxBytes: MAX_BOUNDARY_LOG_BYTES,
  maxFiles: MAX_BOUNDARY_LOG_FILES,
});

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

/** Absolute path of the file this module appends to. */
export function boundaryErrorLogPath(
  options: BoundaryErrorLogOptions = {},
): string {
  return boundaryLog.path(options);
}

/**
 * Append one JSON line. Never throws, never blocks on the network.
 */
export function appendBoundaryError(
  entry: BoundaryErrorEntry,
  options: BoundaryErrorLogOptions = {},
): void {
  boundaryLog.append({ ts: new Date().toISOString(), ...entry }, options);
}
