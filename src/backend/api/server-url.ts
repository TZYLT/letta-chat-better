import { LETTA_CLOUD_API_URL } from "@/auth/oauth";
import { settingsManager } from "@/settings-manager";

/**
 * Default Letta server for a local install.
 *
 * Cloud is deliberately not a default anywhere: with no `LETTA_BASE_URL` and no
 * saved env override, requests and skill scripts target the self-hosted server
 * on its documented port (`letta server`, `docker run -p 8283:8283`). Nothing
 * reaches the network unless something is actually listening there.
 */
export const DEFAULT_LOCAL_SERVER_URL = "http://localhost:8283";

/**
 * The server URL a user explicitly configured (env, then settings), if any.
 *
 * Callers that must not invent a server — probing a self-hosted install, or
 * deriving a persisted git remote — use this and skip when it is undefined.
 */
export function getConfiguredServerUrl(): string | undefined {
  const settings = settingsManager.getSettings();
  return (
    process.env.LETTA_BASE_URL || settings.env?.LETTA_BASE_URL || undefined
  );
}

/**
 * Get the current Letta server URL from environment or settings.
 * Used for cache keys and API operations.
 */
export function getServerUrl(): string {
  return getConfiguredServerUrl() ?? DEFAULT_LOCAL_SERVER_URL;
}

/**
 * True when the configured server is Letta Cloud (matched by hostname).
 * Cloud-only concepts such as computers/environment routing key off this.
 *
 * Before ④-9 this was true by default because the URL default was Cloud; now it
 * is true only when a user explicitly points `LETTA_BASE_URL` at Cloud.
 */
export function isCloudServerUrl(serverUrl?: string): boolean {
  let resolved = serverUrl;
  if (resolved === undefined) {
    try {
      resolved = getServerUrl();
    } catch {
      // Settings may not be initialized yet (e.g. early capability reads).
      resolved = process.env.LETTA_BASE_URL || DEFAULT_LOCAL_SERVER_URL;
    }
  }
  try {
    const parsed = new URL(resolved);
    const cloud = new URL(LETTA_CLOUD_API_URL);
    return parsed.hostname === cloud.hostname;
  } catch {
    return false;
  }
}
