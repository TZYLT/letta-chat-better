/**
 * Backend selection is no longer a runtime choice: the local in-process backend
 * is the only backend, and this module is the single place that says so.
 *
 * `BackendMode` deliberately stays two-valued. It is still used to classify
 * *legacy Cloud* agent ids and the settings buckets they namespace (`agent-…`
 * that is not `agent-local-…`, `serverKeyForBackendMode`) — that classification
 * is orthogonal to which backend process runs, and deleting the second value
 * would silently re-key an existing user's pins. Do not read it as "which
 * backend should run"; read `resolveBackendMode()`, which is a constant.
 *
 * Note: settings namespacing intentionally does NOT read `resolveBackendMode()`.
 * It stays on the env-based predicate (`isLocalBackendEnvEnabled`) so that making
 * the backend non-configurable cannot flip an existing user's settings bucket key
 * from `api.letta.com` to `local:<dir>` and appear to lose their settings.
 */
export type BackendMode = "api" | "local";

/** The only backend mode: the local in-process backend. */
export function resolveBackendMode(): BackendMode {
  return "local";
}

/**
 * Retained so mode-threading callers keep compiling. There is no longer a mode
 * to configure, and this deliberately does NOT write
 * `LETTA_LOCAL_BACKEND_EXPERIMENTAL`: that variable is frozen as the
 * settings-bucket predicate (`isLocalBackendEnvEnabled`).
 */
export function setConfiguredBackendMode(_mode: BackendMode): void {
  // The local backend is the only backend.
}

export function isExperimentalLocalBackendEnabled(): boolean {
  return true;
}
