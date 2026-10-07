import { describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  recompileAgentSystemPrompt,
  updateAgentSystemPromptMemfs,
} from "@/agent/modify";
import { __testSetBackend, type Backend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";

describe("recompileAgentSystemPrompt", () => {
  test("calls the conversation recompile endpoint with mapped params", async () => {
    const conversationsRecompileMock = mock(
      (_conversationId: string, _params?: Record<string, unknown>) =>
        Promise.resolve("compiled-system-prompt"),
    );
    const client = {
      conversations: {
        recompile: conversationsRecompileMock,
      },
    };

    const compiledPrompt = await recompileAgentSystemPrompt(
      "conv-123",
      "agent-123",
      true,
      client,
    );

    expect(compiledPrompt).toBe("compiled-system-prompt");
    expect(conversationsRecompileMock).toHaveBeenCalledWith("conv-123", {
      dry_run: true,
      agent_id: "agent-123",
    });
  });

  test("passes agent_id for default conversation recompiles", async () => {
    const conversationsRecompileMock = mock(
      (_conversationId: string, _params?: Record<string, unknown>) =>
        Promise.resolve("compiled-system-prompt"),
    );
    const client = {
      conversations: {
        recompile: conversationsRecompileMock,
      },
    };

    await recompileAgentSystemPrompt("default", "agent-123", undefined, client);

    expect(conversationsRecompileMock).toHaveBeenCalledWith("default", {
      dry_run: undefined,
      agent_id: "agent-123",
    });
  });

  test("passes non-default conversation ids through unchanged", async () => {
    const conversationsRecompileMock = mock(
      (_conversationId: string, _params?: Record<string, unknown>) =>
        Promise.resolve("compiled-system-prompt"),
    );
    const client = {
      conversations: {
        recompile: conversationsRecompileMock,
      },
    };

    await recompileAgentSystemPrompt(
      "['default']",
      "agent-123",
      undefined,
      client,
    );

    expect(conversationsRecompileMock).toHaveBeenCalledWith("['default']", {
      dry_run: undefined,
      agent_id: "agent-123",
    });
  });

  test("throws when conversation recompile has empty agent id", async () => {
    const conversationsRecompileMock = mock(
      (_conversationId: string, _params?: Record<string, unknown>) =>
        Promise.resolve("compiled-system-prompt"),
    );
    const client = {
      conversations: {
        recompile: conversationsRecompileMock,
      },
    };

    await expect(
      recompileAgentSystemPrompt("default", "", undefined, client),
    ).rejects.toThrow("recompileAgentSystemPrompt requires agentId");
    expect(conversationsRecompileMock).not.toHaveBeenCalled();
  });

  test("throws clearly when backend has no server-side recompile", async () => {
    try {
      __testSetBackend(new FakeHeadlessBackend());

      await expect(
        recompileAgentSystemPrompt("default", "agent-123"),
      ).rejects.toThrow(
        "Server-side prompt recompile is not supported by this backend yet",
      );
    } finally {
      __testSetBackend(null);
    }
  });
});

// The three cases that used to live here drove `reconcileCloudPromptForMemoryMode`
// through a `{ remoteMemfs: true }` backend: resetting an old bundled Cloud
// prompt, reporting a Cloud server that did not persist a null prompt, and
// honouring `LETTA_CODE_PRESERVE_CLOUD_SYSTEM_PROMPT`. That module and its call
// site are gone with the Cloud backend, so only the local case remains.
describe("prompt memory mode without a Cloud backend", () => {
  test("does not turn a null Cloud system prompt into an empty override", async () => {
    const agentId = `agent-${randomUUID()}`;
    const updateAgent = mock(() => Promise.resolve());
    __testSetBackend({
      capabilities: {},
      retrieveAgent: async () => ({ id: agentId, system: null }),
      updateAgent,
    } as unknown as Backend);

    try {
      const result = await updateAgentSystemPromptMemfs(agentId);
      expect(result.success).toBe(true);
      expect(updateAgent).not.toHaveBeenCalled();
    } finally {
      __testSetBackend(null);
    }
  });
});
