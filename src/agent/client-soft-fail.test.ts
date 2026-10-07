import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const projectRoot = process.cwd();
const RESULT_PREFIX = "__CLIENT_SOFT_FAIL_RESULT__";

type IsolatedRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

type MissingCredentialsResult = {
  resolved: boolean;
  message?: string;
};

type RefreshFailureResult = {
  resolved: boolean;
  message?: string;
  trackCalls: Array<{
    errorType: string;
    message: string;
    context: string;
    metadata: {
      httpStatus: string;
      modelId: string;
      runId: string;
      recentChunks: string;
    };
  }>;
};

async function runIsolatedClientScript(
  script: string,
  homeDir: string,
): Promise<IsolatedRunResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    LETTA_CODE_AGENT_ROLE: "subagent",
  };
  delete env.LETTA_API_KEY;
  // The credential and refresh failure modes these scripts exercise only exist
  // for a Letta Cloud base URL: `getClient()` skips the missing-credentials
  // error and the token refresh entirely when the base URL is the local default.
  // Name the Cloud URL explicitly instead of leaving it to the fallback.
  env.LETTA_BASE_URL = "https://api.letta.com";

  // The script is written next to the repo instead of passed to `bun --eval`:
  // on Windows a multi-line argument trips cmd.exe's character rules
  // ("contains a cmd.exe special character and cannot be safely passed"),
  // and a real file also resolves the scripts' relative `./src/...` imports
  // the same way the eval form did.
  const scriptPath = join(projectRoot, `.client-soft-fail-${randomUUID()}.ts`);
  await writeFile(scriptPath, script, "utf8");

  try {
    return await new Promise((resolve, reject) => {
      const proc = spawn("bun", [scriptPath], {
        cwd: projectRoot,
        env,
      });

      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      const timeout = setTimeout(() => {
        proc.kill();
        reject(
          new Error(
            `Timed out running isolated getClient test. stdout: ${stdout} stderr: ${stderr}`,
          ),
        );
      }, 15000);

      proc.on("close", (code) => {
        clearTimeout(timeout);
        resolve({ stdout, stderr, exitCode: code });
      });

      proc.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  } finally {
    await rm(scriptPath, { force: true });
  }
}

function parseIsolatedResult<T>(stdout: string): T {
  const resultLine = stdout
    .split("\n")
    .find((line) => line.startsWith(RESULT_PREFIX));

  if (!resultLine) {
    throw new Error(`Missing isolated test result marker in stdout: ${stdout}`);
  }

  return JSON.parse(resultLine.slice(RESULT_PREFIX.length)) as T;
}

describe("getClient soft failures", () => {
  let testHomeDir = "";

  beforeEach(async () => {
    testHomeDir = await mkdtemp(join(tmpdir(), "letta-client-test-home-"));
  });

  afterEach(async () => {
    if (testHomeDir) {
      await rm(testHomeDir, { recursive: true, force: true });
      testHomeDir = "";
    }
  });

  test("throws when credentials are missing instead of exiting the process", async () => {
    const result = await runIsolatedClientScript(
      `
        import { getClient } from "./src/backend/api/client";
        import { settingsManager } from "./src/settings-manager";

        settingsManager.isKeychainAvailable = async () => false;
        await settingsManager.initialize();

        try {
          await getClient();
          console.log("${RESULT_PREFIX}" + JSON.stringify({ resolved: true }));
        } catch (error) {
          console.log(
            "${RESULT_PREFIX}" +
              JSON.stringify({
                resolved: false,
                message: error instanceof Error ? error.message : String(error),
              }),
          );
        }
      `,
      testHomeDir,
    );

    expect(result.exitCode).toBe(0);

    const payload = parseIsolatedResult<MissingCredentialsResult>(
      result.stdout,
    );
    expect(payload.resolved).toBe(false);
    expect(payload.message).toContain("Missing LETTA_API_KEY");
  });

  test("throws when token refresh fails instead of exiting the process", async () => {
    const result = await runIsolatedClientScript(
      `
        import { getClient } from "./src/backend/api/client";
        import { settingsManager } from "./src/settings-manager";
        import { telemetry } from "./src/telemetry";

        const trackCalls = [];
        telemetry.trackError = (errorType, message, context, metadata) => {
          trackCalls.push({
            errorType,
            message,
            context,
            metadata: {
              httpStatus: String(metadata?.httpStatus),
              modelId: String(metadata?.modelId),
              runId: String(metadata?.runId),
              recentChunks: String(metadata?.recentChunks),
            },
          });
        };
        settingsManager.isKeychainAvailable = async () => false;
        await settingsManager.initialize();
        settingsManager.updateSettings({
          env: {},
          refreshToken: "refresh-token",
          tokenExpiresAt: Date.now() - 1000,
        });
        await settingsManager.flush();
        globalThis.fetch = async () => {
          throw new Error("refresh broke");
        };

        try {
          await getClient();
          console.log(
            "${RESULT_PREFIX}" + JSON.stringify({ resolved: true, trackCalls }),
          );
        } catch (error) {
          console.log(
            "${RESULT_PREFIX}" +
              JSON.stringify({
                resolved: false,
                message: error instanceof Error ? error.message : String(error),
                trackCalls,
              }),
          );
        }
      `,
      testHomeDir,
    );

    expect(result.exitCode).toBe(0);

    const payload = parseIsolatedResult<RefreshFailureResult>(result.stdout);
    expect(payload.resolved).toBe(false);
    expect(payload.message).toBe(
      "Failed to refresh access token: refresh broke",
    );
    expect(payload.trackCalls).toEqual([
      {
        errorType: "auth_token_refresh_failed",
        message: "refresh broke",
        context: "auth_client_token_refresh",
        metadata: {
          httpStatus: "undefined",
          modelId: "undefined",
          runId: "undefined",
          recentChunks: "undefined",
        },
      },
    ]);
    expect(result.stderr).toContain("Failed to refresh access token:");
    expect(result.stderr).not.toContain("process.exit");
  });

  test("refresh token in keychain remains usable after one failed read", async () => {
    const result = await runIsolatedClientScript(
      `
        import { getClient } from "./src/backend/api/client";
        import { settingsManager } from "./src/settings-manager";
        import {
          __resetSecretWarningStateForTests,
          __setSecretGetOverrideForTests,
        } from "./src/utils/secrets";

        await settingsManager.initialize();
        settingsManager.updateSettings({
          env: {},
          tokenExpiresAt: Date.now() - 1000,
        });
        await settingsManager.flush();

        settingsManager.updateSettings = () => {};

        let refreshReadCount = 0;
        let fetchCalls = 0;

        settingsManager.isKeychainAvailable = async () => true;
        __resetSecretWarningStateForTests();
        __setSecretGetOverrideForTests(async ({ name }) => {
          if (name === "letta-refresh-token") {
            refreshReadCount += 1;
            if (refreshReadCount === 1) {
              throw new Error("transient refresh read failure");
            }
            return "rt-keychain-only";
          }
          if (name === "letta-api-key") {
            return null;
          }
          return null;
        });

        globalThis.fetch = async (_url, init) => {
          fetchCalls += 1;
          const body = JSON.parse(String(init?.body ?? "{}"));
          return {
            ok: true,
            async json() {
              return {
                access_token: "sk-refreshed-access-token",
                refresh_token: body.refresh_token,
                token_type: "Bearer",
                expires_in: 3600,
              };
            },
          };
        };

        let firstMessage = null;
        try {
          await getClient();
        } catch (error) {
          firstMessage = error instanceof Error ? error.message : String(error);
        }

        try {
          const client = await getClient();
          console.log(
            "${RESULT_PREFIX}" +
              JSON.stringify({
                resolved: true,
                firstMessage,
                refreshReadCount,
                fetchCalls,
                hasClient: !!client,
              }),
          );
        } catch (error) {
          console.log(
            "${RESULT_PREFIX}" +
              JSON.stringify({
                resolved: false,
                message: error instanceof Error ? error.message : String(error),
                firstMessage,
                refreshReadCount,
                fetchCalls,
              }),
          );
        }
      `,
      testHomeDir,
    );

    expect(result.exitCode).toBe(0);

    const payload = parseIsolatedResult<{
      resolved: boolean;
      message?: string;
      firstMessage: string | null;
      refreshReadCount: number;
      fetchCalls: number;
      hasClient?: boolean;
    }>(result.stdout);

    if (!payload.resolved) {
      throw new Error(
        `Expected keychain recovery scenario to succeed. stdout=${result.stdout} stderr=${result.stderr}`,
      );
    }

    expect(payload.resolved).toBe(true);
    expect(payload.refreshReadCount).toBeGreaterThanOrEqual(2);
    expect(payload.firstMessage).toContain("Missing LETTA_API_KEY");
    expect(payload.fetchCalls).toBe(1);
    expect(payload.hasClient).toBe(true);
  });
});
