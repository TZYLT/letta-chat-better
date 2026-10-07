import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf-8");
}

/**
 * Source-text wiring checks for the local-first setup path.
 *
 * Two cases were removed with the `/login` overlay: they asserted
 * `LettaLoginOverlay.tsx` forwarded `activateCloudBackend={false}` and that
 * `LettaLoginView.tsx` / `LettaLoginOverlay.tsx` handled reauthentication
 * without trusting stale credentials. Both files are gone — the Cloud login
 * surface was deleted, so there is no overlay left to assert against.
 */
describe("cloud-default setup wiring", () => {
  test("setup menu offers local mode and persists that choice", () => {
    const source = readSource("../auth/setup-ui.tsx");

    expect(source).toContain('const LOCAL_MODE_LABEL = "Proceed locally"');
    expect(source).toContain('const AUTH_LOGIN_LABEL = "Sign in with Letta"');
    expect(source).toContain(
      "const [selectedOption, setSelectedOption] = useState(0)",
    );
    expect(source).toContain('configureBackendMode("local")');
    expect(source).toContain(
      'settingsManager.updateSettings({ preferredBackendMode: "local" })',
    );
    expect(source).toContain("letta setup");
    expect(source).toContain("letta backend cloud");
    expect(source).toContain("Agents you create are local to");
    expect(source).toContain("chat.letta.com");
    expect(source).toContain("Welcome to Letta Code");
    expect(source).not.toContain("Welcome to Letta Code.");
    expect(source).not.toContain("Welcome to Letta Code!");
    expect(source).not.toContain("How do you want to start?");
    expect(source).not.toContain("Choose where your agents should live");
  });

  test("explicit cloud agent setup disables local mode to avoid restart loops", () => {
    const setupSource = readSource("../auth/setup-ui.tsx");
    const setupRunnerSource = readSource("../auth/setup.ts");
    const indexSource = readSource("../index.ts");

    expect(setupSource).toContain("localModeDisabledReason?: string");
    expect(setupSource).toContain(
      "const localModeDisabled = Boolean(localModeDisabledReason)",
    );
    expect(setupSource).toContain("localModeDisabled ? [0, 2] : [0, 1, 2]");
    expect(setupSource).toContain("Proceed locally");
    expect(setupSource).toContain("(unavailable)");
    expect(setupSource).toContain("selectedOption === 1 && !localModeDisabled");
    expect(setupRunnerSource).toContain("localModeDisabledReason?: string");
    expect(setupRunnerSource).toContain(
      "localModeDisabledReason: options.localModeDisabledReason",
    );

    expect(indexSource).toContain("const setupLocalModeDisabledReason =");
    expect(indexSource).toContain('inferredBackendModeFromAgentId === "api"');
    expect(indexSource).toContain("requires Letta sign-in");
    expect(indexSource).toContain("rerun without --agent to start locally");
    expect(indexSource).toContain(
      "localModeDisabledReason: setupLocalModeDisabledReason",
    );
  });

  test("startup completes terminal preflight before rendering setup UI", () => {
    const source = readSource("../index.ts");
    const setupCalls = [...source.matchAll(/runSetup\(/g)];

    expect(source).toContain("const ensureTerminalPreflightComplete");
    expect(setupCalls.length).toBeGreaterThanOrEqual(3);
    for (const match of setupCalls) {
      const prefix = source.slice(Math.max(0, match.index - 220), match.index);
      expect(prefix).toContain("await ensureTerminalPreflightComplete();");
    }
  });

  test("startup honors saved selection without automatically saving local for new users", () => {
    const source = readSource("../index.ts");
    expect(source).toContain(
      "const startupBackendMode = resolveSubcommandBackendMode({",
    );
    expect(source).toContain(
      "explicitBackendMode: explicitBackendMode ?? inferredBackendModeFromAgentId",
    );
    expect(source).toContain("savedBackendMode: settings.preferredBackendMode");
    expect(source).toContain('if (startupBackendMode === "local")');
    expect(source).toContain("await tryConfigureStartupLocalBackend()");
    expect(source).not.toContain(
      'settingsManager.updateSettings({ preferredBackendMode: "local" })',
    );
    expect(
      source.match(/persistBackendPreference: !explicitBackendMode/g),
    ).toHaveLength(3);
  });

  test("local transcript migration errors do not block setup login fallback", () => {
    const source = readSource("../index.ts");

    expect(source).toContain("isLocalBackendTranscriptStartupError");
    expect(source).toContain("LocalTranscriptMigrationRequiredError");
    expect(source).toContain("Unsupported local transcript format");
    expect(source).toContain("const tryConfigureStartupLocalBackend");
    expect(source).toContain("Continuing to setup/login");
    expect(source).toContain('configureBackendMode("api")');
    expect(source).toContain('preferredBackendMode: "api"');
  });

  test("setup subcommand exposes default backend controls", () => {
    const router = readSource("./subcommands/router.ts");
    const setupCommand = readSource("./subcommands/setup.ts");

    // `letta backend [cloud|local]` was the Cloud/api-backend selector and was
    // deleted with the API backend; only setup remains.
    expect(router).not.toContain('case "backend"');
    expect(router).toContain('case "setup"');
    expect(setupCommand).toContain("await runSetup()");
  });
});
