import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { APP_SUBDIRS, appHomePath } from "@/utils/app-paths";

export const HARUYUKI_MODS_DIR_ENV = "HARUYUKI_MODS_DIR";
export const LEGACY_LETTA_EXTENSIONS_DIR_ENV = "HARUYUKI_EXTENSIONS_DIR";

export function getGlobalModsDirectory(homeDirectory = homedir()): string {
  return appHomePath([APP_SUBDIRS.mods], { homeDir: homeDirectory });
}

export function getLegacyGlobalExtensionsDirectory(
  homeDirectory = homedir(),
): string {
  return appHomePath([APP_SUBDIRS.extensions], { homeDir: homeDirectory });
}

export function resolveDefaultGlobalModsDirectory(
  homeDirectory = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const environmentDirectory =
    env[HARUYUKI_MODS_DIR_ENV]?.trim() ||
    env[LEGACY_LETTA_EXTENSIONS_DIR_ENV]?.trim();
  if (environmentDirectory) return environmentDirectory;

  const modsDirectory = getGlobalModsDirectory(homeDirectory);
  if (existsSync(modsDirectory)) return modsDirectory;

  const legacyDirectory = getLegacyGlobalExtensionsDirectory(homeDirectory);
  if (existsSync(legacyDirectory)) return legacyDirectory;

  return modsDirectory;
}

export function getModCacheDirectory(
  homeDirectory = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  return appHomePath([APP_SUBDIRS.modCache], { homeDir: homeDirectory, env });
}
