// Package-manager detection for global install operations (e.g. installing
// channel runtime dependencies). Path heuristics on the resolved entrypoint
// decide which manager installed the running binary; HARUYUKI_PACKAGE_MANAGER
// overrides the result.

import { realpathSync } from "node:fs";
import { debugLog } from "@/utils/debug";

export type PackageManager = "npm" | "bun" | "pnpm";

const VALID_PACKAGE_MANAGERS = new Set<string>(["npm", "bun", "pnpm"]);

function getResolvedEntrypoint(): string {
  const argv = process.argv[1] || "";
  try {
    return realpathSync(argv);
  } catch {
    return argv;
  }
}

export function detectPackageManager(): PackageManager {
  const envOverride = process.env.HARUYUKI_PACKAGE_MANAGER;
  if (envOverride) {
    if (VALID_PACKAGE_MANAGERS.has(envOverride)) {
      debugLog(
        "package-manager",
        "Package manager from HARUYUKI_PACKAGE_MANAGER:",
        envOverride,
      );
      return envOverride as PackageManager;
    }
    debugLog(
      "package-manager",
      `Invalid HARUYUKI_PACKAGE_MANAGER="${envOverride}", falling back to path detection`,
    );
  }

  const resolvedPath = getResolvedEntrypoint();

  if (/[/\\]\.bun[/\\]/.test(resolvedPath)) {
    debugLog("package-manager", "Detected package manager from path: bun");
    return "bun";
  }
  if (/[/\\]\.?pnpm[/\\]/.test(resolvedPath)) {
    debugLog("package-manager", "Detected package manager from path: pnpm");
    return "pnpm";
  }

  debugLog("package-manager", "Detected package manager from path: npm");
  return "npm";
}
