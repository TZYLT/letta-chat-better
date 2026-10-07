import { getServerHealth } from "./backend/api/health";
import {
  getConfiguredServerUrl,
  isCloudServerUrl,
} from "./backend/api/server-url";
import { isVersionBelow } from "./utils/version";

const MINIMUM_DOCKER_VERSION = "0.16.6";

/**
 * Check if the Docker image version meets minimum requirements
 * For self-hosted users only - warns if version is outdated
 */
export async function startDockerVersionCheck(): Promise<void> {
  // Only for a server the user actually configured: the built-in local
  // default is not a self-hosted install to version-check, and probing it
  // would burn a startup timeout on every run.
  const baseURL = getConfiguredServerUrl();
  if (!baseURL || isCloudServerUrl(baseURL)) {
    return;
  }

  try {
    const data = await getServerHealth({
      baseUrl: baseURL,
      signal: AbortSignal.timeout(3000),
    });
    const serverVersion = data.version;

    if (!serverVersion) return;

    // Check if version is below minimum
    if (isVersionBelow(serverVersion, MINIMUM_DOCKER_VERSION)) {
      console.warn(
        `\n⚠️  Warning: Your Docker image is outdated (v${serverVersion}). Minimum recommended: v${MINIMUM_DOCKER_VERSION}.\n   Please update with: docker pull letta/letta:latest\n`,
      );
    }
  } catch {
    // Best-effort - don't block startup
  }
}
