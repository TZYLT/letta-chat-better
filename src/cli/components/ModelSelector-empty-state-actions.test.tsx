import { describe, expect, test } from "bun:test";
import { getEmptyStateActionDescriptors } from "@/cli/components/ModelSelector";

describe("ModelSelector empty-state actions", () => {
  // `/login` used to be appended here when the user had no Cloud refresh token.
  // That command is gone, and so is the only way to reach a hosted model through
  // Letta Cloud, so `/connect` is the single remaining action.
  test("offers /connect and nothing else", () => {
    expect(getEmptyStateActionDescriptors()).toEqual([
      {
        id: "connect",
        label: "/connect",
        description: "Connect your LLM API keys (OpenAI, Anthropic, etc.)",
      },
    ]);
  });
});
