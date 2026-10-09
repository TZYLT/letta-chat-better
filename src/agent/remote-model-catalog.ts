/**
 * Live model catalog refresh.
 *
 * The local in-process backend is the only backend, so the catalog is the
 * runtime (pi-ai) inventory projected into the `CatalogModel` shape. The
 * authenticated Cloud catalog endpoint (`GET /v1/models/catalog`) and its
 * persisted cache went away with the API backend.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AvailableModel,
  clearAvailableModelsCache,
  getAvailableModelHandles,
} from "@/agent/available-models";
import { type CatalogModel, models } from "@/agent/model-catalog";
import { APP_DIR_NAME, APP_SUBDIRS } from "@/utils/app-paths";
import { debugLog } from "@/utils/debug";

const CACHE_SCHEMA_VERSION = 1;
const LOCAL_CATALOG_SOURCE = "local:pi-ai";

let activeCatalogSource: string | null = null;
let sourceGeneration = 0;

/** Entry shape returned by GET /v1/models/catalog. */
interface RemoteCatalogEntry {
  id: string;
  handle: string;
  label: string;
  brand: string;
  maxContextWindow: number;
  supportsStructuredOutputs?: boolean;
  description?: string;
  shortLabel?: string;
  isFeatured?: boolean;
  isDefault?: boolean;
  free?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  config?: Record<string, unknown>;
}

function catalogCachePath(): string {
  const dir =
    process.env.HARUYUKI_MODEL_CATALOG_CACHE_DIR ||
    join(homedir(), APP_DIR_NAME, APP_SUBDIRS.cache);
  return join(dir, "model-catalog.json");
}

function normalizeCatalogSource(source: string): string {
  try {
    const url = new URL(source);
    const pathname = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host}${pathname}`;
  } catch {
    return source.trim().replace(/\/+$/, "");
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasEntryIdentity(
  entry: unknown,
): entry is { id: string; handle: string; label: string } {
  if (!isRecord(entry)) return false;
  return (
    isNonEmptyString(entry.id) &&
    isNonEmptyString(entry.handle) &&
    isNonEmptyString(entry.label)
  );
}

/** Persisted cache rows are already-mapped CatalogModels — no re-mapping. */

function isValidCachedModel(entry: unknown): entry is CatalogModel {
  if (!hasEntryIdentity(entry)) return false;
  const candidate = entry as Record<string, unknown>;
  return (
    typeof candidate.description === "string" &&
    isOptionalString(candidate.shortLabel) &&
    isOptionalBoolean(candidate.isDefault) &&
    isOptionalBoolean(candidate.isFeatured) &&
    isOptionalBoolean(candidate.free) &&
    isOptionalBoolean(candidate.supportsStructuredOutputs) &&
    (candidate.updateArgs === undefined || isRecord(candidate.updateArgs))
  );
}

/**
 * Map a remote catalog entry to the shared runtime catalog shape.
 *
 * The endpoint splits preset `updateArgs` into typed fields
 * (contextWindow/maxOutputTokens) plus a `config` bag of provider knobs;
 * recombine them so every existing consumer of `model.updateArgs` keeps
 * working unchanged.
 */
export function toCatalogModel(entry: RemoteCatalogEntry): CatalogModel {
  const updateArgs: Record<string, unknown> = { ...(entry.config ?? {}) };
  if (typeof entry.contextWindow === "number") {
    updateArgs.context_window = entry.contextWindow;
  }
  if (typeof entry.maxOutputTokens === "number") {
    updateArgs.max_output_tokens = entry.maxOutputTokens;
  }
  return {
    id: entry.id,
    handle: entry.handle,
    label: entry.label,
    description: entry.description ?? "",
    ...(typeof entry.supportsStructuredOutputs === "boolean"
      ? { supportsStructuredOutputs: entry.supportsStructuredOutputs }
      : {}),
    ...(entry.shortLabel ? { shortLabel: entry.shortLabel } : {}),
    ...(entry.isDefault ? { isDefault: true } : {}),
    ...(entry.isFeatured ? { isFeatured: true } : {}),
    ...(entry.free ? { free: true } : {}),
    ...(Object.keys(updateArgs).length > 0 ? { updateArgs } : {}),
  };
}

/**
 * Replace the live catalog contents in place so existing imports of `models`
 * observe the refreshed data. Refuses obviously-broken payloads (empty, or
 * missing an Auto/default entry) so a bad deploy can't blank the selector.
 */
export function applyCatalogModels(
  next: CatalogModel[],
  options: { requireManagedDefault?: boolean } = {},
): boolean {
  if (
    next.length === 0 ||
    !next.every(isValidCachedModel) ||
    new Set(next.map((model) => model.id)).size !== next.length
  ) {
    return false;
  }
  if (options.requireManagedDefault !== false) {
    const defaults = next.filter(
      (model) => model.isDefault || model.id === "auto",
    );
    if (defaults.length !== 1) {
      return false;
    }
  }
  models.splice(0, models.length, ...next);
  return true;
}

/**
 * Load the persisted catalog cache (last successful refresh) into the live
 * catalog. Called once at startup, before any network fetch, so temporary
 * endpoint failures keep the freshest known cloud data. Missing or malformed
 * caches leave the runtime catalog empty until the endpoint succeeds.
 */
export function loadPersistedModelCatalog(source: string): boolean {
  try {
    const path = catalogCachePath();
    if (!existsSync(path)) {
      return false;
    }
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      schemaVersion?: unknown;
      source?: unknown;
      models?: unknown;
    };
    if (
      parsed.schemaVersion !== CACHE_SCHEMA_VERSION ||
      parsed.source !== normalizeCatalogSource(source) ||
      !Array.isArray(parsed.models)
    ) {
      return false;
    }
    // Cache rows are CatalogModels persisted post-mapping; reject the whole
    // cache on any invalid row.
    if (!parsed.models.every(isValidCachedModel)) {
      return false;
    }
    return applyCatalogModels(parsed.models);
  } catch {
    return false;
  }
}

function activateCatalogSource(source: string | null): number {
  if (activeCatalogSource === source) {
    return sourceGeneration;
  }
  activeCatalogSource = source;
  sourceGeneration += 1;
  models.splice(0, models.length);
  return sourceGeneration;
}

function modelIdFromHandle(handle: string): string {
  const slashIndex = handle.indexOf("/");
  return slashIndex === -1 ? handle : handle.slice(slashIndex + 1);
}

function uniqueLocalModelIds(
  entries: readonly AvailableModel[],
): Map<string, string> {
  const handlesById = new Map<string, Set<string>>();
  for (const entry of entries) {
    const id = entry.modelId ?? modelIdFromHandle(entry.handle);
    const handles = handlesById.get(id) ?? new Set<string>();
    handles.add(entry.handle);
    handlesById.set(id, handles);
  }
  return new Map(
    entries.map((entry) => {
      const id = entry.modelId ?? modelIdFromHandle(entry.handle);
      return [
        entry.handle,
        handlesById.get(id)?.size === 1 ? id : entry.handle,
      ];
    }),
  );
}

function reasoningEffortForThinkingLevel(level: string): string {
  return level === "off" ? "none" : level;
}

/** Project backend model inventory into the shared runtime catalog shape. */
export function toRuntimeCatalogModels(
  entries: readonly AvailableModel[],
): CatalogModel[] {
  const ids = uniqueLocalModelIds(entries);
  const catalog: CatalogModel[] = [];
  for (const entry of entries) {
    const baseId = ids.get(entry.handle) ?? entry.handle;
    const levels = entry.reasoningLevels ?? [];
    const variants = levels.length > 1 ? levels : [undefined];
    for (const level of variants) {
      const effort = level ? reasoningEffortForThinkingLevel(level) : undefined;
      const updateArgs: Record<string, unknown> = {
        ...(entry.providerType ? { provider_type: entry.providerType } : {}),
        ...(typeof entry.maxContextWindow === "number"
          ? { context_window: entry.maxContextWindow }
          : {}),
        ...(typeof entry.maxOutputTokens === "number"
          ? { max_output_tokens: entry.maxOutputTokens }
          : {}),
        ...(effort
          ? {
              reasoning_effort: effort,
              enable_reasoner: effort !== "none",
            }
          : {}),
        parallel_tool_calls: true,
      };
      catalog.push({
        id: effort ? `${baseId}-${effort}` : baseId,
        handle: entry.handle,
        label: entry.label,
        description: "",
        ...(typeof entry.supportsStructuredOutputs === "boolean"
          ? { supportsStructuredOutputs: entry.supportsStructuredOutputs }
          : {}),
        ...(Object.keys(updateArgs).length > 0 ? { updateArgs } : {}),
      });
    }
  }
  return catalog;
}

async function refreshRuntimeModelCatalog(
  source: string,
  options?: { force?: boolean },
): Promise<boolean> {
  const sourceChanged = activeCatalogSource !== source;
  activateCatalogSource(source);
  if (sourceChanged) clearAvailableModelsCache();
  try {
    const available = await getAvailableModelHandles(
      options?.force ? { forceRefresh: true } : undefined,
    );
    return applyCatalogModels(toRuntimeCatalogModels(available.models), {
      requireManagedDefault: false,
    });
  } catch (error) {
    debugLog("remote-model-catalog", "runtime catalog refresh errored", {
      source,
      error: String(error),
    });
    return false;
  }
}

/**
 * Refresh the live model catalog.
 *
 * The local in-process backend is the only backend, so this always projects the
 * runtime (pi-ai) inventory. The authenticated Cloud catalog endpoint and its
 * persisted cache went away with the API backend.
 */
export async function refreshModelCatalog(options?: {
  force?: boolean;
}): Promise<boolean> {
  // The API (Cloud) catalog endpoint went away with the API backend. The
  // local in-process backend is the only backend, so the runtime catalog
  // projected from pi-ai is the only source.
  return refreshRuntimeModelCatalog(LOCAL_CATALOG_SOURCE, options);
}

/** Initialize the local runtime catalog. */
export async function initializeModelCatalog(): Promise<void> {
  await refreshModelCatalog();
}

/** Fire-and-forget catalog warmup (startup path). */
export function prefetchModelCatalog(): void {
  void refreshModelCatalog().catch(() => {
    // Failures already logged inside refreshModelCatalog.
  });
}

/** Test hook: reset catalog source state. */
export function __testResetRemoteModelCatalog(): void {
  activeCatalogSource = null;
  sourceGeneration += 1;
  models.splice(0, models.length);
}
