import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitOutput } from "@/backend/local/memory-git";

describe("gitOutput", () => {
  test("runs git in the given directory and returns stdout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-git-"));
    try {
      execFileSync("git", ["init"], { cwd: dir });

      expect(
        gitOutput(dir, ["rev-parse", "--is-inside-work-tree"]).trim(),
      ).toBe("true");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("throws for the caller to handle; stderr stays out of the message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memory-git-missing-"));
    try {
      expect(() => gitOutput(dir, ["rev-parse", "HEAD"])).toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
