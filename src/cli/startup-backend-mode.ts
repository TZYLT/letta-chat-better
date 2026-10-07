import { isLocalAgentId } from "@/agent/agent-id";
import { type BackendMode, configureBackendMode } from "@/backend";

/**
 * Startup selection is no longer a backend choice. There is one backend — the
 * local in-process one — so these helpers only do two things: keep
 * `configureBackendMode` being called where it always was, and report whether an
 * agent id names a local agent.
 *
 * `"api"` survives in `BackendMode` on purpose. It classifies *legacy Cloud*
 * agent ids and the settings buckets they namespace, which is orthogonal to
 * which backend process runs. See `src/backend/backend-mode.ts`.
 */

/**
 * The backend a pinned agent id belongs to, or `undefined` when the id does not
 * name a local agent.
 *
 * A Cloud-shaped id (`agent-…` without the `agent-local-` prefix) used to
 * resolve to `"api"`, which selected the API backend. That backend is gone, so
 * returning `"api"` would only pin the lookup to a namespace no backend
 * serves. Callers use the `undefined` case to mean "leave the backend alone".
 */
export function inferBackendModeFromAgentId(
  agentId?: string | null,
): "local" | undefined {
  if (!agentId) return undefined;
  return isLocalAgentId(agentId) ? "local" : undefined;
}

/**
 * Act on a pin chosen in the startup agent picker.
 *
 * There is no second backend to switch to, so this cannot fail and has nothing
 * to roll back. The previous `tryConfigureLocal` hook existed to fall back to
 * the API backend when local transcript migration failed; that fallback is gone,
 * and a migration error must now surface as itself instead of being relabelled
 * as "the local backend needs migration" while the process quietly continued.
 */
export function switchBackendForSelectedStartupAgent(
  _agentId: string,
): boolean {
  configureBackendMode("local");
  return true;
}

export function createStartupAgentPickerHandler(
  selectAgent: (agentId: string) => void,
  onReady: () => void,
  onError: (message: string) => void,
): (agentId: string) => Promise<void> {
  return async (agentId) => {
    try {
      if (!switchBackendForSelectedStartupAgent(agentId)) {
        onError("Local backend data needs migration.");
        return;
      }
      selectAgent(agentId);
      onReady();
    } catch (error) {
      onError(
        `Unable to select agent: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
}

/**
 * Which pin namespaces a startup lookup walks, in order.
 *
 * Both namespaces are always walked. `--backend local` used to collapse this to
 * `["local"]`, which silently dropped Cloud-shaped pins that already existed in
 * the user's store; the flag no longer selects a backend, so it cannot narrow
 * the lookup either. The order only decides which namespace wins when the same
 * name is pinned in both.
 */
export function getStartupBackendLookupOrder(): BackendMode[] {
  return ["local", "api"];
}

export interface SubcommandBackendModeInput {
  envBackendMode?: BackendMode;
  savedBackendMode?: BackendMode;
  baseURL: string;
  cloudBaseURL: string;
}

/**
 * The backend mode a subcommand should configure before it runs.
 *
 * Returns `"local"` or `undefined` — never `"api"`. Every outcome now names the
 * same backend, so this only decides whether to call `configureBackendMode` at
 * all. It stays a function because the saved preference is still read and still
 * validated: a stale `preferredBackendMode` and a custom `baseURL` keep the
 * subcommand from configuring anything, which is the pre-existing "this
 * preference does not apply here" outcome.
 */
export function resolveSubcommandBackendMode({
  envBackendMode,
  savedBackendMode,
  baseURL,
  cloudBaseURL,
}: SubcommandBackendModeInput): BackendMode | undefined {
  if (envBackendMode === "local") return "local";
  if (savedBackendMode !== "local") return undefined;
  if (baseURL !== cloudBaseURL) return undefined;
  return "local";
}
