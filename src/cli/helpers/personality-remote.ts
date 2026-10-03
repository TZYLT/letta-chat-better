import {
  getPersonalityBlockValues,
  type PersonalityId,
} from "@/agent/personality-presets";
import { getClient } from "@/backend/api/client";

/** How long to wait for the pushed memory to reach the remote agent's blocks. */
const PROPAGATION_TIMEOUT_MS = 300_000;
const PROPAGATION_POLL_MS = 1_000;

export interface RemotePersonalitySwapResult {
  /** The text the `/personality` command should finish with. */
  message: string;
  propagated: boolean;
}

/**
 * Wait for a remote (API-backed) agent to pick up the pushed persona/human
 * blocks, then recompile it. Cloud has no client-side frozen prefix, so this
 * recompiles immediately — the opposite of the local backend, which only
 * registers the change (see `formatPersonalitySwappedMessage`).
 *
 * A block that never appears is terminal and throws (the user is told to run
 * `/doctor`); transient API errors keep polling until the timeout.
 */
export async function applyPersonalityToRemoteAgent(input: {
  agentId: string;
  conversationId: string | null;
  personalityId: PersonalityId;
  label: string;
  onProgress: (output: string) => void;
}): Promise<RemotePersonalitySwapResult> {
  const blockValues = getPersonalityBlockValues(input.personalityId);
  const expectedBlocks = new Map<string, string>([
    ["system/persona", blockValues.persona.trim()],
    ["system/human", blockValues.human.trim()],
  ]);

  input.onProgress("Waiting for changes to propagate...");
  const client = await getClient();
  const start = Date.now();
  let propagated = false;

  while (Date.now() - start < PROPAGATION_TIMEOUT_MS) {
    try {
      const blockPage = await client.agents.blocks.list(input.agentId);
      const missingLabels = Array.from(expectedBlocks.keys()).filter(
        (label) => !blockPage.items.some((block) => block.label === label),
      );
      if (missingLabels.length > 0) {
        throw new Error(
          `${missingLabels.join(", ")} block not found on agent. Run \`/doctor\` to diagnose.`,
        );
      }

      const allBlocksPropagated = Array.from(expectedBlocks.entries()).every(
        ([label, expectedContent]) =>
          blockPage.items.some(
            (block) =>
              block.label === label && block.value.includes(expectedContent),
          ),
      );
      if (allBlocksPropagated) {
        propagated = true;
        break;
      }
    } catch (pollError) {
      if (
        pollError instanceof Error &&
        pollError.message.includes("not found on agent")
      ) {
        throw pollError;
      }
      // Transient API error — keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, PROPAGATION_POLL_MS));
  }

  if (!propagated) {
    return {
      propagated: false,
      message: `Personality swapped to ${input.label}. Block propagation timed out — run \`/recompile\` manually`,
    };
  }

  input.onProgress("Recompiling agent...");
  await client.agents.recompile(input.agentId, { update_timestamp: true });
  await client.conversations.recompile(
    input.conversationId ?? "default",
    input.conversationId === "default"
      ? { agent_id: input.agentId }
      : undefined,
  );

  return {
    propagated: true,
    message: `Personality swapped to ${input.label}. Run \`/clear\` or \`/new\` to reset your message history for the personality to take full effect.`,
  };
}
