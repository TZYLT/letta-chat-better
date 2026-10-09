/**
 * ⑪-C acceptance: the sandbox policy and the permission whitelists must resolve
 * the same harness root as the code that writes agent memory.
 *
 * Why this file exists: these rules match *path strings*. A whitelist that
 * computes `~/.haruyuki` on its own still compiles and still runs — it just never
 * matches, so memory writes are silently rejected and the cross-agent deny
 * silently stops covering the tree that actually holds memory. `bun run check`
 * cannot see either.
 *
 * The case that exposed it: ⑪-A promoted `LETTA_HOME` to a global root override
 * for everything resolved through `app-paths.ts`. Two families of call sites were
 * missed, and both fail silently:
 *
 *   1. Roots that took `homeDir` as a parameter and then joined it by hand —
 *      `getMemoryFilesystemRoot`, the shell whitelist derived from it, and the
 *      cross-agent guard's agents tree. With an override set, the policy walled
 *      off one tree while the agent wrote to another.
 *   2. *Project*-scoped paths routed through the override-aware `appHomePath`
 *      instead of `projectAppHomePath`. Project permission rules were then read
 *      from the relocated harness root while still being written to the project.
 *
 * Scope: the *kernel* half of ⑪-C cannot run here — `probe()` in
 * `src/sandbox/availability.ts` returns `backend: null` for every platform other
 * than darwin/linux. What is asserted below is the part that runs everywhere:
 * the paths each surface derives, and the memory round-trip through the
 * permission loader.
 */

import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import { getAllowedMemoryPrefixes } from "@/permissions/agent-memory-prefixes";
import {
  getUserSettingsPaths,
  loadPermissions,
  resetPermissionLoaderCacheForTests,
  savePermissionRule,
} from "@/permissions/loader";
import { resolveAllowedMemoryRoots } from "@/permissions/memory-paths";
import {
  buildMemorySubagentSandboxPolicy,
  canonicalizeRoot,
} from "@/permissions/sandbox-policy";
import {
  APP_DIR_NAME,
  APP_SUBDIRS,
  appHomePath,
  appHomeRoot,
  projectAppHomePath,
} from "@/utils/app-paths";

const originalLettaHome = process.env.LETTA_HOME;
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

/** Compare path strings the way the whitelists themselves normalize them. */
function slash(value: string): string {
  return value.replace(/\\/g, "/");
}

afterEach(() => {
  if (originalLettaHome === undefined) {
    delete process.env.LETTA_HOME;
  } else {
    process.env.LETTA_HOME = originalLettaHome;
  }
  resetPermissionLoaderCacheForTests();
  while (tempDirs.length) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

test("the shell memory whitelist follows the harness root override", () => {
  const home = makeTempDir("harness-whitelist-");
  process.env.LETTA_HOME = home;
  const agentId = "agent-whitelist-self";

  const memoryRoot = getScopedMemoryFilesystemRoot(agentId);
  expect(slash(memoryRoot)).toBe(
    slash(appHomePath([APP_SUBDIRS.agents, agentId, "memory"])),
  );
  expect(slash(memoryRoot).startsWith(`${slash(home)}/`)).toBe(true);

  const prefixes = getAllowedMemoryPrefixes(agentId);
  expect(prefixes).toContain(slash(memoryRoot));
  expect(prefixes).toContain(
    slash(appHomePath([APP_SUBDIRS.agents, agentId, "memory-worktrees"])),
  );

  expect(
    resolveAllowedMemoryRoots({ currentAgentId: agentId }).primaryRoot,
  ).toBe(slash(memoryRoot));
});

test("the sandbox policy's writable base covers the memory root it confines", () => {
  const home = makeTempDir("harness-policy-");
  mkdirSync(join(home, APP_SUBDIRS.agents), { recursive: true });
  process.env.LETTA_HOME = home;
  const agentId = "agent-whitelist-policy";

  const memoryRoot = getScopedMemoryFilesystemRoot(agentId);
  const policy = buildMemorySubagentSandboxPolicy({
    memoryRoots: [memoryRoot],
  });
  const normalized = slash(memoryRoot);

  // Writes are scoped to the relocated harness root...
  expect(policy.baseWritableRoots).toContain(canonicalizeRoot(appHomeRoot()));
  // ...self memory is carved back out of the deny...
  expect(policy.writableRoots.map(slash)).toContain(normalized);
  // ...and the deny covers the tree that actually holds agent memory.
  expect(policy.deniedRoots.map(slash)).toContain(
    slash(canonicalizeRoot(appHomePath([APP_SUBDIRS.agents]))),
  );
  expect(
    policy.deniedRoots
      .map(slash)
      .some((tree) => normalized.startsWith(`${tree}/`)),
  ).toBe(true);
});

test("project-scoped settings stay in the project under a harness root override", async () => {
  const home = makeTempDir("harness-user-");
  const project = makeTempDir("harness-project-");
  process.env.LETTA_HOME = home;
  mkdirSync(join(project, APP_DIR_NAME), { recursive: true });

  await savePermissionRule("Bash(npm test:*)", "allow", "project", project);

  // The rule is written to, and read back from, the project's own harness dir.
  const projectSettings = join(project, APP_DIR_NAME, APP_SUBDIRS.settingsFile);
  expect(projectAppHomePath(project, APP_SUBDIRS.settingsFile)).toBe(
    projectSettings,
  );
  expect(existsSync(projectSettings)).toBe(true);
  expect(existsSync(join(home, APP_SUBDIRS.settingsFile))).toBe(false);

  const rules = await loadPermissions(project);
  expect(rules.allow).toContain("Bash(npm test:*)");
});

test("the user settings file follows the harness root override", () => {
  const home = makeTempDir("harness-settings-");
  process.env.LETTA_HOME = home;

  const paths = getUserSettingsPaths();
  expect(paths.canonical).toBe(appHomePath([APP_SUBDIRS.settingsFile]));
  expect(slash(paths.canonical).startsWith(`${slash(home)}/`)).toBe(true);
});
