/**
 * Regression pins for B-1: a conversation-scoped `model_settings` patch is
 * partial.
 *
 * Callers that change one key of a conversation's model settings — the
 * reasoning-strength ring, a mod's `updateLlmConfig`, a listener `model`
 * command — send only the keys they touched. The conversation path used to
 * replace the whole object, so a user's explicit `context_window_limit` /
 * `max_tokens` were silently reset to the catalog preset of the current model.
 * The agent-scoped path merged; the two scopes disagreed.
 *
 * These pins hold both halves of the contract: an unchanged model merges over
 * the stored settings, and a changed model still resets to the catalog values
 * of the new model (that half is also pinned in
 * `src/agent/modify-local.test.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "@/backend/local/local-store";

const agentId = "agent-conversation-model-settings";
const temporaryDirectories: string[] = [];

/**
 * Catalog defaults matched by a substring of the handle, so the pins survive
 * `normalizeLocalModelHandle` rewriting a handle the pi registry does not know.
 */
const CATALOG: ReadonlyArray<{
  match: string;
  defaults: Record<string, unknown>;
}> = [
  {
    match: "zzz-alpha",
    defaults: {
      provider_type: "openrouter",
      context_window_limit: 1_000_000,
      max_tokens: 384_000,
    },
  },
  {
    match: "zzz-beta",
    defaults: {
      provider_type: "openrouter",
      context_window_limit: 500_000,
      max_tokens: 128_000,
    },
  },
];

const USER_SETTINGS = {
  context_window_limit: 295_000,
  max_tokens: 256_000,
  reasoning_effort: "high",
};

async function createStore(): Promise<LocalStore> {
  const storageDir = await mkdtemp(join(tmpdir(), "local-model-settings-"));
  temporaryDirectories.push(storageDir);
  return new LocalStore(agentId, {
    storageDir,
    modelSettingsForModel: (handle) =>
      CATALOG.find((entry) => handle.includes(entry.match))?.defaults,
  });
}

function settingsOf(
  store: LocalStore,
  conversationId: string,
): Record<string, unknown> {
  const conversation = store.retrieveConversation(conversationId, agentId) as {
    model_settings?: Record<string, unknown> | null;
  };
  return conversation.model_settings ?? {};
}

/** A conversation whose model is `zzz-alpha` and whose window/max are user-set. */
async function conversationWithUserSettings(
  store: LocalStore,
): Promise<string> {
  const conversation = store.createConversation({ agent_id: agentId });
  store.updateConversation(conversation.id, {
    model: "zzz-alpha",
    model_settings: USER_SETTINGS,
  } as never);
  expect(settingsOf(store, conversation.id)).toMatchObject(USER_SETTINGS);
  return conversation.id;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("conversation-scoped model_settings patches", () => {
  test("a patch that omits window and max_tokens keeps them", async () => {
    const store = await createStore();
    const conversationId = await conversationWithUserSettings(store);

    store.updateConversation(conversationId, {
      model_settings: { reasoning_effort: "low" },
    } as never);

    expect(settingsOf(store, conversationId)).toMatchObject({
      context_window_limit: 295_000,
      max_tokens: 256_000,
      reasoning_effort: "low",
    });
  });

  test("a top-level max_tokens patch keeps the window", async () => {
    const store = await createStore();
    const conversationId = await conversationWithUserSettings(store);

    store.updateConversation(conversationId, {
      max_tokens: 111_000,
    } as never);

    expect(settingsOf(store, conversationId)).toMatchObject({
      context_window_limit: 295_000,
      max_tokens: 111_000,
      reasoning_effort: "high",
    });
  });

  test("an empty patch object does not wipe the stored settings", async () => {
    const store = await createStore();
    const conversationId = await conversationWithUserSettings(store);

    store.updateConversation(conversationId, {
      model_settings: {},
    } as never);

    expect(settingsOf(store, conversationId)).toMatchObject(USER_SETTINGS);
  });

  test("changing the model resets window and max_tokens to the catalog", async () => {
    const store = await createStore();
    const conversationId = await conversationWithUserSettings(store);

    store.updateConversation(conversationId, {
      model: "zzz-beta",
      model_settings: { reasoning_effort: "low" },
    } as never);

    expect(settingsOf(store, conversationId)).toMatchObject({
      context_window_limit: 500_000,
      max_tokens: 128_000,
      reasoning_effort: "low",
    });
  });

  test("an explicit null clears the settings and the defaults come back", async () => {
    const store = await createStore();
    const conversationId = await conversationWithUserSettings(store);

    store.updateConversation(conversationId, {
      model_settings: null,
    } as never);

    const settings = settingsOf(store, conversationId);
    expect(settings).toMatchObject({
      context_window_limit: 1_000_000,
      max_tokens: 384_000,
    });
    expect(settings.reasoning_effort).toBeUndefined();
  });
});
