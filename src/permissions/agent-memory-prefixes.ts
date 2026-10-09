import { getRuntimeContext } from "@/runtime-context";
import { getRuntimeExecutionEnv } from "@/runtime-execution-settings";
import { APP_SUBDIRS, appHomePath } from "@/utils/app-paths";

/** Memory locations approved for scoped read-only shell commands. */
export function getAllowedMemoryPrefixes(agentId: string): string[] {
  const env = getRuntimeExecutionEnv(
    process.env,
    getRuntimeContext()?.executionSettings,
  );
  const parentId = env.HARUYUKI_PARENT_AGENT_ID;
  const ids =
    parentId && parentId !== agentId ? [agentId, parentId] : [agentId];
  return ids.flatMap((id) =>
    ["memory", "memory-worktrees"].map((directory) =>
      // Resolved through app-paths, not `homedir()`: the sandbox policy derives
      // its writable base the same way, so a `HARUYUKI_HOME` override has to move
      // both or the whitelist would never match (silently rejecting every
      // read-only memory command).
      appHomePath([APP_SUBDIRS.agents, id, directory], { env }).replace(
        /\\/g,
        "/",
      ),
    ),
  );
}
