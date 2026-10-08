import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clearAvailableModelsCache,
  getAvailableModelHandles,
} from "@/agent/available-models";
import { models } from "@/agent/model";
import type { Backend } from "@/backend";
import { __testSetBackend } from "@/backend";
import {
  resolveBackendMode,
  setConfiguredBackendMode,
} from "@/backend/backend-mode";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import {
  clearRuntimeModelCatalogFixture,
  installRuntimeModelCatalogFixture,
} from "@/test-utils/runtime-model-catalog";
import {
  buildListModelsResponse,
  resolveModelForUpdate,
  resolveModelForUpdateWithInventory,
} from "./model-toolset";

class NativeCatalogBackend extends FakeHeadlessBackend {
  failListing = false;

  override async listModels(): ReturnType<Backend["listModels"]> {
    if (this.failListing) throw new Error("Inventory unavailable");
    return [
      ...byokModels.map(([handle, provider_type]) => ({
        handle,
        provider_type,
        provider_category: "byok",
      })),
      {
        handle: "opencode/deepseek-v4-flash-free",
        display_name: "DeepSeek V4 Flash Free",
        max_context_window: 200000,
        max_tokens: 128000,
        provider_type: "opencode",
      },
      {
        handle: "google/gemini-3.5-flash",
        display_name: "Gemini 3.5 Flash",
        max_context_window: 1000000,
        max_tokens: 65536,
        provider_type: "google",
      },
      {
        handle: "proxy/claude-opus-4-6",
        display_name: "Claude Opus 4.6",
        provider_type: "openai",
        provider_category: "byok",
        model_endpoint: "https://proxy.example.com/openai/v1",
      },
      {
        handle: "lc-openai/gpt-5.4",
        display_name: "GPT-5.4",
        provider_type: "openai",
        provider_category: "byok",
        model_endpoint: "https://api.openai.com/v1",
      },
      {
        handle: "chatgpt-jin/gpt-5.6-sol-fast",
        display_name: "GPT-5.6 Sol Fast",
        provider_type: "chatgpt_oauth",
        provider_category: "byok",
      },
      {
        handle: "openai-codex/gpt-5.6-sol",
        display_name: "GPT-5.6 Sol",
        provider_type: "chatgpt_oauth",
        provider_category: "byok",
      },
    ] as never;
  }
}

const byokModels = [
  ["my-anthropic/claude-fable-5", "anthropic"],
  ["my-google/gemini-3.5-flash", "google_ai"],
  ["my-minimax/minimax-m2.7", "minimax"],
] as const;

describe("listener native model selection", () => {
  const originalBaseUrl = process.env.LETTA_BASE_URL;
  const originalMode = resolveBackendMode();
  beforeEach(() => {
    setConfiguredBackendMode("api");
    process.env.LETTA_BASE_URL = "https://api.letta.com";
    installRuntimeModelCatalogFixture();
  });
  afterEach(() => {
    setConfiguredBackendMode(originalMode);
    if (originalBaseUrl === undefined) delete process.env.LETTA_BASE_URL;
    else process.env.LETTA_BASE_URL = originalBaseUrl;
    clearRuntimeModelCatalogFixture();
    clearAvailableModelsCache();
    __testSetBackend(null);
  });

  test("resolves a backend-native list_models id from the cached catalog", async () => {
    __testSetBackend(new NativeCatalogBackend());
    await getAvailableModelHandles();

    expect(
      resolveModelForUpdate({
        model_id: "opencode/deepseek-v4-flash-free",
      }),
    ).toEqual({
      id: "opencode/deepseek-v4-flash-free",
      handle: "opencode/deepseek-v4-flash-free",
      label: "DeepSeek V4 Flash Free",
      updateArgs: undefined,
    });
  });

  test("channel picker IDs resolve to catalog handles, not echoed IDs", async () => {
    for (const preset of models) {
      const resolved = await resolveModelForUpdateWithInventory({
        model_id: preset.id,
        model_handle: preset.id,
      });
      expect(resolved?.handle).toBe(preset.handle);
      expect(resolved?.updateArgs).toEqual(preset.updateArgs);
    }
  });

  test.each(["api", "local"] as const)(
    "%s runtime responses retain the full inventory outside Cloud",
    async (mode) => {
      setConfiguredBackendMode(mode);
      if (mode === "api") process.env.LETTA_BASE_URL = "http://localhost:8283";
      __testSetBackend(new NativeCatalogBackend());
      const response = await buildListModelsResponse("runtime-models");
      expect(response.available_handles).toContain(
        "opencode/deepseek-v4-flash-free",
      );
      expect(response.entries.map((entry) => entry.handle)).toContain(
        "opencode/deepseek-v4-flash-free",
      );
    },
  );

  test("BYOK tier selection preserves the requested preset and execution handle", async () => {
    __testSetBackend(new NativeCatalogBackend());
    await getAvailableModelHandles();
    const preset = models.find(
      (model) => model.handle === "anthropic/claude-fable-5",
    );
    expect(preset).toBeDefined();
    expect(
      resolveModelForUpdate({
        model_id: preset?.id,
        model_handle: "my-anthropic/claude-fable-5",
      }),
    ).toMatchObject({
      handle: "my-anthropic/claude-fable-5",
      updateArgs: { ...preset?.updateArgs, provider_type: "anthropic" },
    });
  });

  test("applies explicit proxy effort from a device update without leaking it to direct OpenAI", async () => {
    __testSetBackend(new NativeCatalogBackend());
    await getAvailableModelHandles();

    expect(
      resolveModelForUpdate({
        model_id: "proxy/claude-opus-4-6",
        reasoning_effort: null,
      })?.updateArgs,
    ).toEqual({
      provider_type: "openai",
      openai_compatible_proxy: true,
      reasoning_effort: null,
    });
    expect(
      resolveModelForUpdate({
        model_id: "lc-openai/gpt-5.4",
        reasoning_effort: null,
      })?.updateArgs,
    ).toMatchObject({ provider_type: "openai" });
  });

  test("honors device reasoning effort for a ChatGPT OAuth model", () => {
    expect(
      resolveModelForUpdate({
        model_id: "gpt-5.6-sol-none",
        model_handle: "openai-codex/gpt-5.6-sol",
        reasoning_effort: "medium",
      })?.updateArgs,
    ).toMatchObject({
      reasoning_effort: "medium",
    });
  });

  test("preserves ChatGPT OAuth provider identity for native Fast aliases", async () => {
    __testSetBackend(new NativeCatalogBackend());
    await getAvailableModelHandles();

    expect(
      resolveModelForUpdate({
        model_id: "chatgpt-jin/gpt-5.6-sol-fast",
      }),
    ).toEqual({
      id: "chatgpt-jin/gpt-5.6-sol-fast",
      handle: "chatgpt-jin/gpt-5.6-sol-fast",
      label: "GPT-5.6 Sol Fast",
      updateArgs: { provider_type: "chatgpt_oauth" },
    });
  });

  test("preserves a native handle id if the availability cache was cleared", () => {
    expect(
      resolveModelForUpdate({
        model_id: "opencode/deepseek-v4-flash-free",
      }),
    ).toEqual({
      id: "opencode/deepseek-v4-flash-free",
      handle: "opencode/deepseek-v4-flash-free",
      label: "opencode/deepseek-v4-flash-free",
      updateArgs: undefined,
    });
  });

  test("applies a curated preset to the equivalent native Pi handle on a custom server", async () => {
    process.env.LETTA_BASE_URL = "http://localhost:8283";
    __testSetBackend(new NativeCatalogBackend());
    await getAvailableModelHandles();
    const preset = models.find(
      (model) => model.handle === "google_ai/gemini-3.5-flash",
    );
    expect(preset).toBeDefined();

    const resolved = resolveModelForUpdate({ model_id: preset?.id });

    expect(resolved).toMatchObject({
      id: preset?.id,
      handle: "google/gemini-3.5-flash",
      label: preset?.label,
      updateArgs: { provider_type: "google" },
    });
  });
});
