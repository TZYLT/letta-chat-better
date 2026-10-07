import { type Backend, getBackend } from "@/backend";

export interface DreamCommandScope {
  agentId: string;
  conversationId?: string | null;
}

/**
 * The Cloud reflection service went away with the API backend. The local
 * in-process backend always owns reflection through the Code-managed path, and
 * returning `null` here is what authorizes that path — it is never an error
 * fallback.
 *
 * `args` used to be rejected when a Cloud backend owned reflection. On the
 * local backend it was already ignored (this returned `null` first), so the
 * behaviour is unchanged.
 */
export async function requestCloudReflectionRun(
  scope: DreamCommandScope,
  _args = "",
  _backend: Backend = getBackend(),
): Promise<string | null> {
  if (!scope.agentId) throw new Error("Reflection requires an active agent.");
  return null;
}
