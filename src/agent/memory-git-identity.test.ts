import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HARNESS_GIT_FALLBACK_EMAIL,
  HARNESS_GIT_FALLBACK_NAME,
  harnessGitIdentity,
  resetHarnessGitIdentityCache,
} from "@/agent/memory-git-identity";

let root: string;
const originalGlobalConfig = process.env.GIT_CONFIG_GLOBAL;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "haruyuki-git-identity-"));
  resetHarnessGitIdentityCache();
});

afterEach(() => {
  if (originalGlobalConfig === undefined) {
    delete process.env.GIT_CONFIG_GLOBAL;
  } else {
    process.env.GIT_CONFIG_GLOBAL = originalGlobalConfig;
  }
  resetHarnessGitIdentityCache();
  rmSync(root, { recursive: true, force: true });
});

function pointGlobalConfigAt(content: string | null): void {
  const path = join(root, "gitconfig");
  if (content !== null) {
    writeFileSync(path, content, "utf-8");
  }
  process.env.GIT_CONFIG_GLOBAL = path;
  resetHarnessGitIdentityCache();
}

test("uses the operator's global git identity when one is configured", () => {
  pointGlobalConfigAt(
    "[user]\n\tname = Real Operator\n\temail = real@example.test\n",
  );

  expect(harnessGitIdentity()).toEqual({
    name: "Real Operator",
    email: "real@example.test",
  });
});

test("falls back to a fork-local identity when the global config is missing", () => {
  // A path that does not exist: `git config --global --get` exits 1.
  pointGlobalConfigAt(null);

  expect(harnessGitIdentity()).toEqual({
    name: HARNESS_GIT_FALLBACK_NAME,
    email: HARNESS_GIT_FALLBACK_EMAIL,
  });
});

test("falls back per key, so a partial global config keeps the set half", () => {
  pointGlobalConfigAt("[user]\n\tname = Only A Name\n");

  expect(harnessGitIdentity()).toEqual({
    name: "Only A Name",
    email: HARNESS_GIT_FALLBACK_EMAIL,
  });
});

test("memoizes per global-config location, so repeated commits do not re-shell", () => {
  pointGlobalConfigAt("[user]\n\tname = First\n\temail = first@example.test\n");
  const first = harnessGitIdentity();
  expect(first.name).toBe("First");

  // Same location: the memo answers even after the file content changed.
  writeFileSync(
    join(root, "gitconfig"),
    "[user]\n\tname = Second\n\temail = second@example.test\n",
    "utf-8",
  );
  expect(harnessGitIdentity()).toBe(first);

  // A different location invalidates the memo by itself, with no explicit reset.
  // That is what keeps this safe when a test mutates GIT_CONFIG_GLOBAL.
  const other = join(root, "gitconfig-other");
  writeFileSync(
    other,
    "[user]\n\tname = Third\n\temail = third@example.test\n",
  );
  process.env.GIT_CONFIG_GLOBAL = other;
  expect(harnessGitIdentity().name).toBe("Third");
});
