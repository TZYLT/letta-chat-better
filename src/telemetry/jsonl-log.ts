/**
 * Append-only JSONL log file with size-bounded rotation.
 *
 * Shared by the two local diagnostics sinks — boundary errors and user feedback
 * — so both bound their disk usage the same way: the active file rotates into a
 * numbered archive once it passes `maxBytes`, and the oldest archive beyond
 * `maxFiles` is deleted. Without the cap, a long-running session that keeps
 * hitting one event would grow a single file until the disk fills.
 *
 * Every write is best-effort by design: callers sit on error or user-facing
 * paths that must not throw, and a diagnostic must never mask the failure it
 * reports.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

export interface JsonlLogOptions {
  /** Override the log directory (tests). Defaults to the configured one. */
  dir?: string;
  /** Override the per-file byte cap (tests). */
  maxBytes?: number;
  /** Override the retained file count, active file included (tests). */
  maxFiles?: number;
}

export interface JsonlLogConfig {
  /** Active file name without the `.jsonl` suffix. */
  basename: string;
  /** Directory used when a call site does not override it. */
  defaultDir: string;
  maxBytes: number;
  maxFiles: number;
}

export interface JsonlLog {
  /** Absolute path of the file appended to for the given options. */
  path(options?: JsonlLogOptions): string;
  /** Append one line. Never throws, never blocks on the network. */
  append(entry: unknown, options?: JsonlLogOptions): void;
}

function activePath(dir: string, basename: string): string {
  return join(dir, `${basename}.jsonl`);
}

function archivePath(dir: string, basename: string, index: number): string {
  return join(dir, `${basename}.${index}.jsonl`);
}

function rotateIfNeeded(
  dir: string,
  basename: string,
  maxBytes: number,
  maxFiles: number,
): void {
  const active = activePath(dir, basename);
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
  const oldest = archivePath(dir, basename, maxFiles - 1);
  if (existsSync(oldest)) {
    unlinkSync(oldest);
  }
  for (let index = maxFiles - 2; index >= 1; index -= 1) {
    const from = archivePath(dir, basename, index);
    if (existsSync(from)) {
      renameSync(from, archivePath(dir, basename, index + 1));
    }
  }
  renameSync(active, archivePath(dir, basename, 1));
}

export function createJsonlLog(config: JsonlLogConfig): JsonlLog {
  return {
    path(options: JsonlLogOptions = {}): string {
      return activePath(options.dir ?? config.defaultDir, config.basename);
    },
    append(entry: unknown, options: JsonlLogOptions = {}): void {
      const line = `${JSON.stringify(entry)}\n`;
      try {
        const dir = options.dir ?? config.defaultDir;
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        rotateIfNeeded(
          dir,
          config.basename,
          options.maxBytes ?? config.maxBytes,
          options.maxFiles ?? config.maxFiles,
        );
        appendFileSync(activePath(dir, config.basename), line, {
          encoding: "utf8",
        });
      } catch {
        // Best-effort: never surface a logging failure to the caller.
      }
    },
  };
}
