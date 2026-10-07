import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { listSharedAgentsForCurrentUser } from "@/cli/helpers/shared-agent-listing";
import { settingsManager } from "@/settings-manager";

const originalFetch = globalThis.fetch;
const originalGetSettingsWithSecureTokens =
  settingsManager.getSettingsWithSecureTokens;

beforeEach(() => {
  settingsManager.getSettingsWithSecureTokens = mock(async () => ({
    env: {
      LETTA_BASE_URL: "https://example.test",
      LETTA_API_KEY: "test-key",
    },
  })) as unknown as typeof settingsManager.getSettingsWithSecureTokens;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  settingsManager.getSettingsWithSecureTokens =
    originalGetSettingsWithSecureTokens;
});

test("shared agent discovery sends the API key without a caller identity", async () => {
  const headers: Array<Headers> = [];
  globalThis.fetch = mock(async (_input, init) => {
    headers.push(new Headers(init?.headers));
    return new Response(JSON.stringify({ agents: [], nextCursor: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  await listSharedAgentsForCurrentUser({});

  expect(headers).toHaveLength(1);
  expect(headers[0]?.get("Authorization")).toBe("Bearer test-key");
});
