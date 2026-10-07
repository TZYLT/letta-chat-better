import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAvailableModelsCache } from "@/agent/available-models";
import { models, resolveModel } from "@/agent/model-catalog";
import {
  __testResetRemoteModelCatalog,
  applyCatalogModels,
  initializeModelCatalog,
  requireModelCatalog,
  toCatalogModel,
  toRuntimeCatalogModels,
} from "@/agent/remote-model-catalog";
import { __testSetBackend } from "@/backend";
import { setConfiguredBackendMode } from "@/backend/backend-mode";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { settingsManager } from "@/settings-manager";

await settingsManager.initialize();

/**
 * Catalog semantics.
 *
 * The Cloud catalog endpoint (`GET /v1/models/catalog`) and its persisted cache
 * went away with the API backend. The local in-process backend is the only
 * backend, so the catalog is the projected runtime (pi-ai) inventory.
 */

const originalFetch = globalThis.fetch;
const originalBaseUrl = process.env.LETTA_BASE_URL;
const originalApiKey = process.env.LETTA_API_KEY;
const snapshot = models.map((model) => ({ ...model }));

function restoreSnapshot() {
  models.splice(0, models.length, ...snapshot.map((model) => ({ ...model })));
}

function runtimeCatalogBackend(): FakeHeadlessBackend {
  return new FakeHeadlessBackend(
    "agent-runtime-catalog",
    undefined,
    {},
    { modelHandle: "anthropic/claude-haiku-4-5" },
  );
}

let cacheDir: string;

beforeEach(() => {
  __testResetRemoteModelCatalog();
  setConfiguredBackendMode("api");
  process.env.LETTA_BASE_URL = "https://api.letta.com";
  process.env.LETTA_API_KEY = "test-key";
  cacheDir = mkdtempSync(join(tmpdir(), "lc-model-catalog-test-"));
  process.env.LETTA_MODEL_CATALOG_CACHE_DIR = cacheDir;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreSnapshot();
  clearAvailableModelsCache();
  __testSetBackend(null);
  setConfiguredBackendMode("api");
  delete process.env.LETTA_MODEL_CATALOG_CACHE_DIR;
  rmSync(cacheDir, { recursive: true, force: true });
  if (originalBaseUrl === undefined) {
    delete process.env.LETTA_BASE_URL;
  } else {
    process.env.LETTA_BASE_URL = originalBaseUrl;
  }
  if (originalApiKey === undefined) {
    delete process.env.LETTA_API_KEY;
  } else {
    process.env.LETTA_API_KEY = originalApiKey;
  }
});

describe("toCatalogModel", () => {
  test("recombines typed fields and config into updateArgs", () => {
    const mapped = toCatalogModel({
      id: "opus",
      handle: "anthropic/claude-opus-4-8",
      label: "Opus 4.8",
      brand: "anthropic",
      maxContextWindow: 950000,
      description: "Opus 4.8 (high reasoning)",
      isFeatured: true,
      contextWindow: 200000,
      maxOutputTokens: 128000,
      config: { reasoning_effort: "high", enable_reasoner: true },
    });

    expect(mapped).toEqual({
      id: "opus",
      handle: "anthropic/claude-opus-4-8",
      label: "Opus 4.8",
      description: "Opus 4.8 (high reasoning)",
      isFeatured: true,
      updateArgs: {
        reasoning_effort: "high",
        enable_reasoner: true,
        context_window: 200000,
        max_output_tokens: 128000,
      },
    });
  });

  test("omits absent optional fields instead of emitting false/undefined", () => {
    const mapped = toCatalogModel({
      id: "bare",
      handle: "openai/some-model",
      label: "Some Model",
      brand: "openai",
      maxContextWindow: 100000,
    });

    expect(mapped).toEqual({
      id: "bare",
      handle: "openai/some-model",
      label: "Some Model",
      description: "",
    });
    expect("isFeatured" in mapped).toBe(false);
    expect("updateArgs" in mapped).toBe(false);
    expect("supportsStructuredOutputs" in mapped).toBe(false);
  });

  test("preserves both structured-output values as capability metadata", () => {
    for (const supported of [true, false]) {
      const mapped = toCatalogModel({
        id: "structured-output-model",
        handle: "openai/example",
        label: "Example",
        brand: "openai",
        maxContextWindow: 100000,
        supportsStructuredOutputs: supported,
      });
      expect(mapped.supportsStructuredOutputs).toBe(supported);
      expect(mapped.updateArgs).toBeUndefined();
    }
  });
});

describe("applyCatalogModels", () => {
  test("rejects empty payloads", () => {
    expect(applyCatalogModels([])).toBe(false);
    expect(models).toEqual([]);
  });

  test("rejects payloads without a default/auto entry", () => {
    const before = models.length;
    const applied = applyCatalogModels([
      {
        id: "opus",
        handle: "anthropic/claude-opus-4-8",
        label: "Opus 4.8",
        description: "",
      },
    ]);

    expect(applied).toBe(false);
    expect(models.length).toBe(before);
  });

  test("replaces catalog contents in place", () => {
    const reference = models; // simulate an existing import-time capture
    const applied = applyCatalogModels([
      {
        id: "auto",
        handle: "letta/auto",
        label: "Auto",
        description: "",
        isDefault: true,
      },
      {
        id: "new-model",
        handle: "openai/gpt-9",
        label: "GPT-9",
        description: "",
      },
    ]);

    expect(applied).toBe(true);
    expect(reference.length).toBe(2);
    expect(reference.find((m) => m.id === "new-model")?.handle).toBe(
      "openai/gpt-9",
    );
  });
});

describe("refreshModelCatalog", () => {
  test("fails clearly when API mode has no endpoint or cached catalog", () => {
    expect(requireModelCatalog).toThrow(
      "GET /v1/models/catalog failed and no valid cache exists",
    );
  });

  test("accepts a valid cached API catalog when the endpoint is unavailable", () => {
    expect(
      applyCatalogModels([
        {
          id: "auto",
          handle: "letta/auto",
          label: "Auto",
          description: "",
          isDefault: true,
        },
      ]),
    ).toBe(true);
    expect(requireModelCatalog).not.toThrow();
  });

  test("local startup uses runtime inventory without requesting the Cloud catalog", async () => {
    setConfiguredBackendMode("local");
    __testSetBackend(runtimeCatalogBackend());
    const fetchMock = mock(() => Promise.reject(new Error("unexpected fetch")));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(initializeModelCatalog()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(resolveModel("haiku")).toBe("anthropic/claude-haiku-4-5");
  });

  test("custom API startup uses runtime model inventory", async () => {
    process.env.LETTA_BASE_URL = "http://localhost:8283";
    __testSetBackend(runtimeCatalogBackend());
    const fetchMock = mock(() => Promise.reject(new Error("unexpected fetch")));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(initializeModelCatalog()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(resolveModel("haiku")).toBe("anthropic/claude-haiku-4-5");
    expect(() => requireModelCatalog("http://localhost:8283")).not.toThrow();
  });

  test("projects runtime metadata without requiring a managed default", () => {
    const projected = toRuntimeCatalogModels([
      {
        handle: "anthropic/claude-sonnet-4-6",
        modelId: "claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        maxContextWindow: 200000,
        maxOutputTokens: 128000,
        providerType: "anthropic",
        reasoningLevels: ["off", "medium", "high"],
      },
    ]);

    expect(projected.map((model) => model.id)).toEqual([
      "claude-sonnet-4-6-none",
      "claude-sonnet-4-6-medium",
      "claude-sonnet-4-6-high",
    ]);
    expect(
      applyCatalogModels(projected, { requireManagedDefault: false }),
    ).toBe(true);
    expect(models[2]?.updateArgs).toMatchObject({
      context_window: 200000,
      max_output_tokens: 128000,
      provider_type: "anthropic",
      reasoning_effort: "high",
    });
  });
});
