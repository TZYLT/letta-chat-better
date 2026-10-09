/**
 * Task-reference resolution for `haruyuki cron get`/`delete` (LET-10492).
 *
 * `add` requires `--name`, so names are the handle users (and agents) actually
 * remember - but the store addresses tasks by ID. This module resolves a
 * positional that didn't match any ID as a task *name*. Every task lives in the
 * device-local store; the Cloud schedule inventory this used to search was
 * removed with the rest of the Cloud surface.
 */

import { listTasks } from "@/cron";

export interface ResolvedTaskRef {
  /** The task id the reference resolved to. */
  id: string;
  store: "local";
}

/**
 * Resolve a `get`/`delete` positional that didn't match any task ID as a
 * task name. `haruyuki cron delete <name>` failing with "not found" while the
 * schedule keeps firing is a footgun.
 *
 * Exact-match only. Returns:
 * - `{ id, store }` for exactly one match
 * - `{ ambiguous }` with the matching ids when several tasks share the name
 * - `null` for no match (callers keep their existing not-found error)
 */
export function resolveTaskName(
  name: string,
): ResolvedTaskRef | { ambiguous: ResolvedTaskRef[] } | null {
  const matches: ResolvedTaskRef[] = [];

  for (const task of listTasks()) {
    if (task.name === name) {
      matches.push({ id: task.id, store: "local" });
    }
  }

  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0] ?? null;
  return { ambiguous: matches };
}

export function printAmbiguousTaskName(
  name: string,
  matches: ResolvedTaskRef[],
): void {
  console.error(
    `Error: multiple tasks are named "${name}". Use an ID instead:`,
  );
  for (const match of matches) {
    console.error(`  ${match.id} (${match.store})`);
  }
}
