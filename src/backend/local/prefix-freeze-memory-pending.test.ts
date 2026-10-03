import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectMemoryPending } from "@/backend/local/prefix-freeze";

/**
 * `collectMemoryPending` reads the memory repo best-effort: it must never throw
 * and never lose information it already has just because a larger, more
 * expensive git call failed (R-03/R-04).
 */

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function memoryRepoWithTwoCommits(): Promise<{
  dir: string;
  first: string;
  second: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "freeze-pending-"));
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  await writeFile(join(dir, "persona.md"), "first\n", "utf8");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "first"]);
  const first = git(dir, ["rev-parse", "HEAD"]).trim();
  await writeFile(join(dir, "persona.md"), "second\n", "utf8");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "second"]);
  const second = git(dir, ["rev-parse", "HEAD"]).trim();
  return { dir, first, second };
}

describe("collectMemoryPending", () => {
  test("reports the commit list, the stat, and the full diff", async () => {
    const { dir, first, second } = await memoryRepoWithTwoCommits();
    try {
      const pending = collectMemoryPending(dir, first, { full: true });

      expect(pending.reachable).toBe(true);
      expect(pending.committedRevision).toBe(second);
      expect(pending.unappliedCommits).toHaveLength(1);
      expect(pending.unappliedCommits[0]).toContain("second");
      expect(pending.diffStat).toContain("persona.md");
      expect(pending.fullDiff).toContain("+second");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps the commit list and stat when the full diff fails", async () => {
    const { dir, first } = await memoryRepoWithTwoCommits();
    try {
      // An external diff driver that cannot run: `git diff` fails, while
      // `git log --oneline` and `git diff --stat` still succeed.
      git(dir, ["config", "diff.external", "definitely-not-a-real-diff-tool"]);
      expect(() => git(dir, ["diff", "HEAD~1", "HEAD"])).toThrow();

      const pending = collectMemoryPending(dir, first, { full: true });

      // The expensive call failed; the cheap ones must survive.
      expect(pending.unappliedCommits).toHaveLength(1);
      expect(pending.diffStat).toContain("persona.md");
      expect(pending.fullDiff).toBeUndefined();
      expect(pending.reachable).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("marks an unreadable repo as unreachable instead of throwing", async () => {
    const { dir, first } = await memoryRepoWithTwoCommits();
    try {
      await rm(join(dir, ".git"), { recursive: true, force: true });

      const pending = collectMemoryPending(dir, first, { full: true });

      expect(pending.reachable).toBe(false);
      expect(pending.unappliedCommits).toEqual([]);
      expect(pending.diffStat).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
