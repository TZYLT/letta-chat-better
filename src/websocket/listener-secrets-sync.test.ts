import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type WebSocket from "ws";
import { createSharedReminderState } from "@/reminders/state";
import {
  __testOverrideLocalSecretStorage,
  __testSeedSecretsCache,
  clearSecretsCache,
  loadSecrets,
} from "@/utils/secrets-store";
import { __listenClientTestUtils } from "@/websocket/listen-client";
import { handleSecretsCommand } from "@/websocket/listener/commands/secrets";
import {
  __testSetFreshnessMs,
  ensureSecretsHydratedForAgent,
  invalidateSecretsCacheForAgent,
} from "@/websocket/listener/secrets-sync";

const AGENT_ID = "agent-listener-secret";
const INDEX_NAME = `agent:${AGENT_ID}:secrets:index`;
const valueName = (key: string): string => `agent:${AGENT_ID}:secrets:${key}`;

/**
 * Agent secrets live in the local secret store now (the server-backed store went
 * away with the API backend). This in-memory store plays the role the mocked
 * server fetch used to: it holds the source values and counts how many times a
 * hydrating read reached it, which is what the freshness/coalescing assertions
 * are really about.
 */
function installSourceStore() {
  const values = new Map<string, string>();
  let reads = 0;
  let holdNextIndexRead = false;
  let held: { resolve: () => void } | null = null;

  __testOverrideLocalSecretStorage({
    delete: async (name) => values.delete(name),
    get: async (name) => {
      if (name !== INDEX_NAME) return values.get(name) ?? null;
      reads += 1;
      if (!holdNextIndexRead) return values.get(name) ?? null;
      holdNextIndexRead = false;
      // Snapshot now: the test may mutate the source while this read is held.
      const snapshot = values.get(name) ?? null;
      return await new Promise<string | null>((resolve) => {
        held = {
          resolve: () => {
            held = null;
            resolve(snapshot);
          },
        };
      });
    },
    set: async (name, value) => {
      values.set(name, value);
    },
  });

  return {
    values,
    get readCount(): number {
      return reads;
    },
    isReadHeld(): boolean {
      return held !== null;
    },
    setSource(secrets: Record<string, string>): void {
      const names = Object.keys(secrets);
      values.set(INDEX_NAME, JSON.stringify(names));
      for (const [key, value] of Object.entries(secrets)) {
        values.set(valueName(key), value);
      }
    },
    holdNextRead(): void {
      holdNextIndexRead = true;
    },
    releaseHeldRead(): void {
      held?.resolve();
    },
  };
}

describe("listener secrets sync", () => {
  let source: ReturnType<typeof installSourceStore>;

  beforeEach(() => {
    source = installSourceStore();
    // Use a short freshness window for deterministic tests.
    __testSetFreshnessMs(500);
    clearSecretsCache(AGENT_ID);
    clearSecretsCache("agent-other-secret");
  });

  afterEach(() => {
    __testOverrideLocalSecretStorage(null);
    __testSetFreshnessMs(null);
    clearSecretsCache(AGENT_ID);
    clearSecretsCache("agent-other-secret");
  });

  test("hydrates the agent-scoped secrets cache from local storage", async () => {
    source.setSource({ WS_SECRET_TOKEN: "listenersecret" });
    const listener = __listenClientTestUtils.createListenerRuntime();

    await ensureSecretsHydratedForAgent(listener, AGENT_ID);

    expect(source.readCount).toBe(1);
    expect(loadSecrets(AGENT_ID)).toEqual({
      WS_SECRET_TOKEN: "listenersecret",
    });
  });

  test("returns cached secrets within the freshness window (cache hit)", async () => {
    source.setSource({ WS_SECRET_TOKEN: "first" });
    const listener = __listenClientTestUtils.createListenerRuntime();

    await ensureSecretsHydratedForAgent(listener, AGENT_ID);
    // A second source value that the cache-hit path must never read.
    source.setSource({ WS_SECRET_TOKEN: "second" });
    await ensureSecretsHydratedForAgent(listener, AGENT_ID);

    // Only one source read — the second call hit the cache.
    expect(source.readCount).toBe(1);
    expect(loadSecrets(AGENT_ID)).toEqual({
      WS_SECRET_TOKEN: "first",
    });
  });

  test("re-fetches after the freshness window expires", async () => {
    // Use a very short freshness window so it expires immediately.
    __testSetFreshnessMs(1);
    source.setSource({ WS_SECRET_TOKEN: "first" });
    const listener = __listenClientTestUtils.createListenerRuntime();

    await ensureSecretsHydratedForAgent(listener, AGENT_ID);
    // Wait for the freshness window to expire.
    await new Promise((resolve) => setTimeout(resolve, 10));
    source.setSource({ WS_SECRET_TOKEN: "second" });
    await ensureSecretsHydratedForAgent(listener, AGENT_ID);

    expect(source.readCount).toBe(2);
    expect(loadSecrets(AGENT_ID)).toEqual({
      WS_SECRET_TOKEN: "second",
    });
  });

  test("coalesces concurrent refreshes for the same agent", async () => {
    source.setSource({ WS_SECRET_TOKEN: "coalesced" });
    source.holdNextRead();
    const listener = __listenClientTestUtils.createListenerRuntime();

    const first = ensureSecretsHydratedForAgent(listener, AGENT_ID);
    const second = ensureSecretsHydratedForAgent(listener, AGENT_ID);

    for (let i = 0; i < 10 && !source.isReadHeld(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(source.isReadHeld()).toBe(true);
    source.releaseHeldRead();
    await Promise.all([first, second]);

    expect(source.readCount).toBe(1);
    expect(loadSecrets(AGENT_ID)).toEqual({
      WS_SECRET_TOKEN: "coalesced",
    });
  });

  test("invalidation during in-flight refresh forces a follow-up fetch", async () => {
    source.setSource({ WS_SECRET_TOKEN: "stale" });
    source.holdNextRead();
    const listener = __listenClientTestUtils.createListenerRuntime();

    const first = ensureSecretsHydratedForAgent(listener, AGENT_ID);
    for (let i = 0; i < 10 && !source.isReadHeld(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(source.isReadHeld()).toBe(true);

    invalidateSecretsCacheForAgent(listener, AGENT_ID);
    source.setSource({ WS_SECRET_TOKEN: "updated" });
    const second = ensureSecretsHydratedForAgent(listener, AGENT_ID);

    // The held read still resolves with the stale snapshot it captured.
    source.releaseHeldRead();
    await Promise.all([first, second]);

    expect(source.readCount).toBe(2);
    expect(loadSecrets(AGENT_ID)).toEqual({
      WS_SECRET_TOKEN: "updated",
    });
  });

  test("invalidation forces re-fetch even within the freshness window", async () => {
    source.setSource({ WS_SECRET_TOKEN: "first" });
    const listener = __listenClientTestUtils.createListenerRuntime();

    await ensureSecretsHydratedForAgent(listener, AGENT_ID);
    expect(source.readCount).toBe(1);

    // Simulate a GUI secret mutation invalidating the cache.
    invalidateSecretsCacheForAgent(listener, AGENT_ID);
    source.setSource({ WS_SECRET_TOKEN: "updated" });

    // Next call should re-fetch even though the freshness window hasn't expired.
    await ensureSecretsHydratedForAgent(listener, AGENT_ID);
    expect(source.readCount).toBe(2);
    expect(loadSecrets(AGENT_ID)).toEqual({
      WS_SECRET_TOKEN: "updated",
    });
  });

  test("secret_apply schedules fresh secrets reminders for existing conversations", async () => {
    __testSeedSecretsCache(AGENT_ID, {
      WS_SECRET_TOKEN: "first",
    });
    source.setSource({ WS_SECRET_TOKEN: "first" });
    const listener = __listenClientTestUtils.createListenerRuntime();
    const state = createSharedReminderState();
    state.hasSentSecretsInfo = true;
    const otherAgentState = createSharedReminderState();
    otherAgentState.hasSentSecretsInfo = true;
    listener.reminderStateByConversation.set(
      `agent:${AGENT_ID}::conversation:conv-a`,
      state,
    );
    listener.reminderStateByConversation.set(
      "agent:agent-other-secret::conversation:conv-b",
      otherAgentState,
    );
    const sent: unknown[] = [];
    const tasks: Promise<void>[] = [];

    const handled = handleSecretsCommand(
      {
        type: "secret_apply",
        request_id: "req-secret-apply",
        agent_id: AGENT_ID,
        set: { WS_SECRET_TOKEN: "updated" },
        unset: [],
      },
      {
        socket: {} as WebSocket,
        runtime: listener,
        safeSocketSend: (_socket, message) => {
          sent.push(message);
          return true;
        },
        runDetachedListenerTask: (_name, task) => {
          tasks.push(task());
        },
      },
    );

    expect(handled).toBe(true);
    await Promise.all(tasks);

    expect(source.values.get(valueName("WS_SECRET_TOKEN"))).toBe("updated");
    expect(listener.secretsDirtyAgents.has(AGENT_ID)).toBe(true);
    expect(state.hasSentSecretsInfo).toBe(false);
    expect(state.pendingSecretsInfoRefresh).toBe(true);
    expect(otherAgentState.hasSentSecretsInfo).toBe(true);
    expect(otherAgentState.pendingSecretsInfoRefresh).toBe(false);
    expect(sent).toEqual([
      {
        type: "secret_apply_response",
        request_id: "req-secret-apply",
        success: true,
        names: ["WS_SECRET_TOKEN"],
      },
    ]);
  });

  test("approval reuse: same-turn call after preflight hits cache", async () => {
    source.setSource({ WS_SECRET_TOKEN: "preflight" });
    const listener = __listenClientTestUtils.createListenerRuntime();

    // Simulate the turn preflight hydration.
    await ensureSecretsHydratedForAgent(listener, AGENT_ID);

    // Simulate the approval execution path calling again in the same turn.
    await ensureSecretsHydratedForAgent(listener, AGENT_ID);

    // Only one source read — the approval path reused the cached hydration.
    expect(source.readCount).toBe(1);
    expect(loadSecrets(AGENT_ID)).toEqual({
      WS_SECRET_TOKEN: "preflight",
    });
  });

  test("invalidation clears dirty flag after successful re-fetch", async () => {
    source.setSource({ WS_SECRET_TOKEN: "first" });
    const listener = __listenClientTestUtils.createListenerRuntime();

    // First hydration.
    await ensureSecretsHydratedForAgent(listener, AGENT_ID);
    expect(source.readCount).toBe(1);

    // Invalidate and re-fetch.
    invalidateSecretsCacheForAgent(listener, AGENT_ID);
    source.setSource({ WS_SECRET_TOKEN: "second" });
    await ensureSecretsHydratedForAgent(listener, AGENT_ID);
    expect(source.readCount).toBe(2);

    // After re-fetch, the dirty flag is cleared and the cache is fresh again.
    // A third call within the freshness window should be a cache hit.
    await ensureSecretsHydratedForAgent(listener, AGENT_ID);
    expect(source.readCount).toBe(2); // no new fetch
  });
});
