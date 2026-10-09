import { readFileSync } from "node:fs";
import path from "node:path";
import { isModCapabilityId, type ModCapabilityId } from "@/mods/capabilities";
import { isModFileExtension } from "@/mods/file-extensions";

export const HARUYUKI_PACKAGE_MANIFEST_VERSION = 1;

export type HaruyukiPackageCapability = ModCapabilityId;

export interface HaruyukiPackageEngines {
  lettaCodeCli?: string;
  lettaCodeDesktop?: string;
}

export interface HaruyukiPackageManifest {
  manifestVersion: typeof HARUYUKI_PACKAGE_MANIFEST_VERSION;
  mods: string[];
  capabilities?: HaruyukiPackageCapability[];
  engines?: HaruyukiPackageEngines;
}

export interface HaruyukiPackageManifestValidationError {
  message: string;
  path: string;
}

export type HaruyukiPackageManifestParseResult =
  | {
      errors: [];
      manifest: HaruyukiPackageManifest | null;
      ok: true;
    }
  | {
      errors: HaruyukiPackageManifestValidationError[];
      manifest: null;
      ok: false;
    };

const MANIFEST_KEYS = new Set([
  "manifestVersion",
  "mods",
  "capabilities",
  "engines",
]);
const ENGINE_KEYS = new Set(["lettaCodeCli", "lettaCodeDesktop"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addError(
  errors: HaruyukiPackageManifestValidationError[],
  errorPath: string,
  message: string,
): void {
  errors.push({ message, path: errorPath });
}

function getUnknownKeys(
  value: Record<string, unknown>,
  knownKeys: Set<string>,
): string[] {
  return Object.keys(value).filter((key) => !knownKeys.has(key));
}

function isWindowsAbsolutePath(value: string): boolean {
  return path.win32.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value);
}

export function isSafeHaruyukiPackageModEntryPath(value: string): boolean {
  if (!value.trim()) return false;
  if (value.includes("\0")) return false;
  if (value.includes("\\")) return false;
  if (path.posix.isAbsolute(value) || path.isAbsolute(value)) return false;
  if (isWindowsAbsolutePath(value)) return false;

  const posixPath = value.replace(/\\/g, "/");
  if (posixPath.split("/").includes("..")) return false;
  const normalized = path.posix.normalize(posixPath);
  if (normalized === "." || normalized === "") return false;
  if (normalized === ".." || normalized.startsWith("../")) return false;
  if (normalized.split("/").includes("..")) return false;

  return isModFileExtension(path.posix.extname(normalized));
}

function isValidSemverIdentifier(value: string): boolean {
  return /^[0-9A-Za-z-]+$/.test(value);
}

function isValidSemverVersion(value: string): boolean {
  if (value === "*" || /^[xX]$/.test(value)) return true;

  const buildSeparatorIndex = value.indexOf("+");
  const versionWithPrerelease =
    buildSeparatorIndex >= 0 ? value.slice(0, buildSeparatorIndex) : value;
  const build =
    buildSeparatorIndex >= 0 ? value.slice(buildSeparatorIndex + 1) : undefined;
  if (build !== undefined) {
    if (!build || build.includes("+")) return false;
    const buildParts = build.split(".");
    if (buildParts.some((part) => !part || !isValidSemverIdentifier(part))) {
      return false;
    }
  }

  const prereleaseSeparatorIndex = versionWithPrerelease.indexOf("-");
  const version =
    prereleaseSeparatorIndex >= 0
      ? versionWithPrerelease.slice(0, prereleaseSeparatorIndex)
      : versionWithPrerelease;
  const prerelease =
    prereleaseSeparatorIndex >= 0
      ? versionWithPrerelease.slice(prereleaseSeparatorIndex + 1)
      : undefined;
  if (prerelease !== undefined) {
    if (!prerelease) return false;
    const prereleaseParts = prerelease.split(".");
    if (
      prereleaseParts.some((part) => !part || !isValidSemverIdentifier(part))
    ) {
      return false;
    }
  }

  const parts = version.split(".");
  if (parts.length < 1 || parts.length > 3) return false;

  return parts.every((part) => {
    if (part === "*" || /^[xX]$/.test(part)) return true;
    return /^(0|[1-9]\d*)$/.test(part);
  });
}

function isValidSemverComparator(value: string): boolean {
  const match = value.match(/^(?:<=|>=|<|>|=|~\s*|\^\s*)?(.+)$/);
  const version = match?.[1]?.trim();
  if (!version) return false;
  return isValidSemverVersion(version);
}

function isValidSemverRange(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;

  return trimmed.split("||").every((part) => {
    const comparators = part.trim().split(/\s+/).filter(Boolean);
    if (comparators.length === 0) return false;
    return comparators.every(isValidSemverComparator);
  });
}

function validateMods(
  value: unknown,
  errors: HaruyukiPackageManifestValidationError[],
): string[] | null {
  if (!Array.isArray(value)) {
    addError(errors, "letta.mods", "mods must be a non-empty array");
    return null;
  }
  if (value.length === 0) {
    addError(errors, "letta.mods", "mods must include at least one entry");
    return null;
  }

  const mods: string[] = [];
  value.forEach((entry, index) => {
    const entryPath = `letta.mods[${index}]`;
    if (typeof entry !== "string") {
      addError(errors, entryPath, "mod entry must be a string path");
      return;
    }
    if (!isSafeHaruyukiPackageModEntryPath(entry)) {
      addError(
        errors,
        entryPath,
        "mod entry must be a safe relative .ts, .tsx, .js, or .mjs path",
      );
      return;
    }
    mods.push(entry);
  });

  return mods;
}

function validateCapabilities(
  value: unknown,
  errors: HaruyukiPackageManifestValidationError[],
): HaruyukiPackageCapability[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    addError(errors, "haruyuki.capabilities", "capabilities must be an array");
    return undefined;
  }

  const capabilities: HaruyukiPackageCapability[] = [];
  value.forEach((entry, index) => {
    const entryPath = `haruyuki.capabilities[${index}]`;
    if (typeof entry !== "string") {
      addError(errors, entryPath, "capability must be a string");
      return;
    }
    if (!isModCapabilityId(entry)) {
      addError(errors, entryPath, `unknown capability '${entry}'`);
      return;
    }
    capabilities.push(entry);
  });

  return capabilities;
}

function validateEngines(
  value: unknown,
  errors: HaruyukiPackageManifestValidationError[],
): HaruyukiPackageEngines | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    addError(errors, "letta.engines", "engines must be an object");
    return undefined;
  }

  for (const key of getUnknownKeys(value, ENGINE_KEYS)) {
    addError(errors, `letta.engines.${key}`, `unknown engine '${key}'`);
  }

  const engines: HaruyukiPackageEngines = {};
  for (const key of ENGINE_KEYS) {
    const engineRange = value[key];
    if (engineRange === undefined) continue;
    if (typeof engineRange !== "string") {
      addError(errors, `letta.engines.${key}`, "engine range must be a string");
      continue;
    }
    if (!isValidSemverRange(engineRange)) {
      addError(
        errors,
        `letta.engines.${key}`,
        "engine range must be semver-compatible",
      );
      continue;
    }
    engines[key as keyof HaruyukiPackageEngines] = engineRange;
  }

  return Object.keys(engines).length > 0 ? engines : undefined;
}

export function parseHaruyukiPackageManifest(
  packageJson: unknown,
): HaruyukiPackageManifestParseResult {
  if (!isRecord(packageJson)) {
    return {
      errors: [{ message: "package.json must be an object", path: "package" }],
      manifest: null,
      ok: false,
    };
  }

  const rawManifest = packageJson.letta;
  if (rawManifest === undefined) {
    return { errors: [], manifest: null, ok: true };
  }
  if (!isRecord(rawManifest)) {
    return {
      errors: [{ message: "letta manifest must be an object", path: "letta" }],
      manifest: null,
      ok: false,
    };
  }

  const errors: HaruyukiPackageManifestValidationError[] = [];
  for (const key of getUnknownKeys(rawManifest, MANIFEST_KEYS)) {
    addError(errors, `letta.${key}`, `unknown manifest field '${key}'`);
  }

  if (rawManifest.manifestVersion !== HARUYUKI_PACKAGE_MANIFEST_VERSION) {
    addError(
      errors,
      "letta.manifestVersion",
      `manifestVersion must be ${HARUYUKI_PACKAGE_MANIFEST_VERSION}`,
    );
  }

  const mods = validateMods(rawManifest.mods, errors);
  const capabilities = validateCapabilities(rawManifest.capabilities, errors);
  const engines = validateEngines(rawManifest.engines, errors);

  if (errors.length > 0 || !mods) {
    return { errors, manifest: null, ok: false };
  }

  return {
    errors: [],
    manifest: {
      manifestVersion: HARUYUKI_PACKAGE_MANIFEST_VERSION,
      mods,
      ...(capabilities && capabilities.length > 0 ? { capabilities } : {}),
      ...(engines ? { engines } : {}),
    },
    ok: true,
  };
}

export function readHaruyukiPackageManifest(
  packageJsonPath: string,
): HaruyukiPackageManifestParseResult {
  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    return parseHaruyukiPackageManifest(packageJson);
  } catch (error) {
    return {
      errors: [
        {
          message: error instanceof Error ? error.message : String(error),
          path: packageJsonPath,
        },
      ],
      manifest: null,
      ok: false,
    };
  }
}
