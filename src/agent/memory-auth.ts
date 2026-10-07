/**
 * Memory-git credentials for the active backend.
 *
 * This used to resolve a Desktop OAuth token or the API client key, because
 * memory could live on a remote server that required auth. `localMemfs &&
 * !remoteMemfs` was the local-checkout case and skipped auth entirely; the
 * local in-process backend is now the only backend and it always has local
 * memfs, so every caller is in that case.
 *
 * The function stays (and stays async) so the git call sites keep their shape
 * and a future remote memory backend has an obvious seam to reintroduce auth on.
 */
export async function getAuthToken(): Promise<string> {
  return "";
}
