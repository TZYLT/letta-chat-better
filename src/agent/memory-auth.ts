import { getDesktopAccessToken } from "@/auth/desktop-credentials";
import { getClient } from "@/backend/api/client";
import {
  getMemfsGitProxyRewriteConfig,
  getMemfsServerUrl,
} from "@/backend/api/memfs-git-proxy";
import { DEFAULT_LOCAL_SERVER_URL } from "@/backend/api/server-url";

/**
 * Memory-git credentials for the active backend.
 *
 * Memory is local now, so most git work needs no credentials at all. Two cases
 * still do, and both reach a server rather than the local checkout:
 *
 * - Desktop's transient proxy transport (`LETTA_MEMFS_GIT_PROXY_BASE_URL`). The
 *   proxy authenticates the rewritten URLs, and
 *   `shouldConfigurePersistentMemfsCredentialHelper()` deliberately clears the
 *   repo-local helper in that mode, so this per-command credential is the only
 *   one git can use.
 * - An explicitly configured MemFS base URL: the memory remote is that server,
 *   which authenticates like any other remote.
 *
 * A purely local checkout resolves to `""`. It has nothing to authenticate
 * against, and its credential helper must not persist the account's API key.
 *
 * The previous implementation decided the same thing from
 * `capabilities.localMemfs && !capabilities.remoteMemfs`. That predicate became
 * constant once the local backend was the only backend, so it returned `""` for
 * every run — including the two cases above, whose git commands then failed with
 * "could not read Username" / fell back to an inherited credential helper.
 */
export async function getAuthToken(): Promise<string> {
  // Renewed Desktop credentials are already scoped to the memory server.
  const desktopToken = getDesktopAccessToken();
  if (desktopToken) {
    return desktopToken;
  }

  if (!isMemfsRemoteConfigured()) {
    return "";
  }

  const client = await getClient();
  return client.apiKey ?? "";
}

/** Whether memory is served by something other than the local checkout. */
function isMemfsRemoteConfigured(): boolean {
  if (getMemfsGitProxyRewriteConfig() !== null) {
    return true;
  }
  return getMemfsServerUrl().replace(/\/+$/, "") !== DEFAULT_LOCAL_SERVER_URL;
}
