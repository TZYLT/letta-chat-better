export function createIsolatedCliTestEnv(
  extraEnv: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
  };

  stripAmbientHaruyukiTestEnv(env);

  Object.assign(env, {
    HARUYUKI_DISABLE_SESSION_PERSIST: "1",
  });

  applyEnvOverrides(env, extraEnv);
  if (extraEnv.HOME !== undefined && extraEnv.USERPROFILE === undefined) {
    env.USERPROFILE = extraEnv.HOME;
  }
  return env;
}

export function createAuthenticatedCliTestEnv(
  extraEnv: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return createIsolatedCliTestEnv({
    LETTA_API_KEY: process.env.LETTA_API_KEY,
    LETTA_BASE_URL: process.env.LETTA_BASE_URL,
    HARUYUKI_API_BASE: process.env.HARUYUKI_API_BASE,
    ...extraEnv,
  });
}

export const AMBIENT_LETTA_TEST_ENV_KEYS = [
  "AGENT_ID",
  "CONVERSATION_ID",
  "HARUYUKI_ACCESS_TOKEN",
  "HARUYUKI_AGENT_ID",
  "HARUYUKI_API_BASE",
  "LETTA_API_KEY",
  "LETTA_BASE_URL",
  "HARUYUKI_CODE_AGENT_ROLE",
  "HARUYUKI_CONVERSATION_ID",
  "LETTA_LOCAL_BACKEND_DIR",
  "HARUYUKI_LOCAL_BACKEND_EXPERIMENTAL",
  "HARUYUKI_LOCAL_BACKEND_EXECUTOR",
  "LETTA_MEMORY_DIR",
  "HARUYUKI_PARENT_AGENT_ID",
  "HARUYUKI_PARENT_CONVERSATION_ID",
  "HARUYUKI_SUBAGENT_NAME",
  "HARUYUKI_REFRESH_TOKEN",
  "MEMORY_DIR",
  "HARUYUKI_CODE_DEV_PI_MODEL",
  "HARUYUKI_CODE_DEV_PI_PROVIDER",
  "HARUYUKI_CODE_DEV_AI_SDK_MODEL",
  "HARUYUKI_CODE_DEV_AI_SDK_PROVIDER",
] as const;

export function stripAmbientHaruyukiTestEnv(env: NodeJS.ProcessEnv): void {
  for (const key of AMBIENT_LETTA_TEST_ENV_KEYS) {
    delete env[key];
  }
}

function applyEnvOverrides(
  env: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv,
): void {
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
}

export function snapshotAmbientHaruyukiTestEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    AMBIENT_LETTA_TEST_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
}

export function restoreAmbientHaruyukiTestEnv(
  snapshot: NodeJS.ProcessEnv,
): void {
  for (const key of AMBIENT_LETTA_TEST_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

export function isolateAmbientHaruyukiTestEnv(
  extraEnv: NodeJS.ProcessEnv = {},
): () => void {
  const snapshot = snapshotAmbientHaruyukiTestEnv();

  stripAmbientHaruyukiTestEnv(process.env);
  applyEnvOverrides(process.env, extraEnv);

  return () => restoreAmbientHaruyukiTestEnv(snapshot);
}
