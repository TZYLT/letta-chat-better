import {
  clearSubagentConfigCache,
  discoverSubagents,
  getAllSubagentConfigs,
} from "@/agent/subagents";

/**
 * `/task refresh` — drop the cached subagent configs, re-read them from disk,
 * and report what was found. Discovery problems are surfaced here because this
 * is the only user-invocable place that re-reads subagent files; `errors` mean a
 * subagent was skipped, `warnings` mean it loaded but a declared field no longer
 * has any effect (for example `model:`).
 */
export async function refreshSubagentConfigs(): Promise<string> {
  clearSubagentConfigCache();
  const { subagents, errors, warnings } = await discoverSubagents();
  const allConfigs = await getAllSubagentConfigs();
  for (const error of errors) {
    console.warn(`Subagent discovery error: ${error.path}: ${error.message}`);
  }
  for (const warning of warnings) {
    console.warn(
      `Subagent discovery warning: ${warning.path}: ${warning.message}`,
    );
  }
  const problemSuffix = errors.length > 0 ? `, ${errors.length} error(s)` : "";
  return `Refreshed subagents list: found ${Object.keys(allConfigs).length} total (${subagents.length} custom)${problemSuffix}`;
}
