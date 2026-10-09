import { afterAll, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

const require = createRequire(import.meta.url);
const os = require("node:os") as typeof import("node:os");
const originalHome = resolve(os.homedir());
const configuredTestHome = process.env.LETTA_TEST_HOME?.trim();
const testHome = configuredTestHome
  ? resolve(configuredTestHome)
  : mkdtempSync(join(os.tmpdir(), "letta-code-test-home-"));

if (testHome === originalHome) {
  throw new Error("LETTA_TEST_HOME must not be the operator home directory");
}

const filesystemEnvKeys = [
  "LETTA_ARTIFACTS_DIR",
  "LETTA_CODE_DEV_BACKEND_DIR",
  "LETTA_DEBUG_FILE",
  "LETTA_HOME",
  "LETTA_LISTENER_PERF_FILE",
  "LETTA_LOCAL_BACKEND_DIR",
  "LETTA_MEMORY_DIR",
  "LETTA_MODEL_CATALOG_CACHE_DIR",
  "LETTA_TRANSCRIPT_ROOT",
  "LETTA_TUI_PERF_FILE",
  "MEMORY_DIR",
  "WEZTERM_CONFIG_FILE",
  "XDG_CONFIG_HOME",
] as const;

function isWithin(path: string, root: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

for (const key of filesystemEnvKeys) {
  const value = process.env[key]?.trim();
  if (!value || !isAbsolute(value)) continue;
  const absolute = resolve(value);
  if (!isWithin(absolute, originalHome)) continue;
  process.env[key] = join(testHome, relative(originalHome, absolute));
}

process.env.LETTA_TEST_HOME = testHome;
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.LETTA_TEST_SECRETS_SERVICE_PREFIX = `letta-code-test-${process.pid}-${basename(testHome)}`;
process.env.LETTA_CODE_TELEM ??= "0";

// Skill watchers invalidate the client-skills payload cache asynchronously, so a
// case that writes a skill file and then asserts the *cached* payload is stale
// races the watcher: which side wins decides the assertion. Two such cases
// (`client-skills-working-directory`, `client-skills-shared-memory`) failed on
// this machine, and a standalone probe with watchers off showed the cache
// behaving exactly as documented (a deleted or edited skill still came from the
// cache until explicit invalidation). Tests also do not need a live watcher; the
// one case that exercises the production watcher spawns a child with
// `LETTA_DISABLE_SKILL_WATCHERS=0`, which overrides this.
process.env.LETTA_DISABLE_SKILL_WATCHERS ??= "1";

// Managed tools (ripgrep for the Glob/Grep tools) are bootstrapped into
// `<home>/.haruyuki/bin`. This home is disposable, so leaving the tools directory
// inside it means every test run re-downloads ripgrep from GitHub — which times
// out under a parallel run and makes the Glob/Grep suites fail for reasons that
// have nothing to do with the code under test. Point the tools directory at a
// stable cache so one successful bootstrap is reused.
process.env.LETTA_CODE_TOOLS_DIR ??= join(os.tmpdir(), "letta-code-test-tools");

// Bun resolves os.homedir() before preloads run. Patch the shared built-in
// module so both ESM and CommonJS consumers use the disposable home. This is a
// direct module update rather than a Bun test mock, so mock.restore() in an
// unrelated suite cannot remove the filesystem boundary. Child processes use
// the redirected environment before their runtimes initialize.
os.homedir = () => testHome;

// Load after redirecting home: channel config captures its filesystem root.
const routes = await import("@/channels/routing");
afterEach(() => {
  routes.clearAllRoutes();
  routes.__testOverrideLoadRoutes(null);
  routes.__testOverrideSaveRoutes(null);
});

if (!configuredTestHome) {
  // The disposable home is housekeeping, not an assertion: on Windows a suite
  // that still holds a handle under it (an open SQLite store, a socket) makes
  // this removal fail with EBUSY, and the failure was reported as an unnamed
  // failing test. Retry the removal, then warn instead of throwing so a leaked
  // handle stays visible without reddening an otherwise passing suite.
  const cleanup = () => {
    try {
      rmSync(testHome, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      });
    } catch (error) {
      console.warn(
        `[test-home] could not remove ${testHome}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };
  afterAll(cleanup);
  process.once("exit", cleanup);
}
