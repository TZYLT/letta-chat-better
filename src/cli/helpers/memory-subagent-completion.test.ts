import { describe, expect, test } from "bun:test";
import { handleMemorySubagentCompletion } from "@/cli/helpers/memory-subagent-completion";

describe("handleMemorySubagentCompletion messaging", () => {
  test("reflection success reports the dream", async () => {
    expect(
      await handleMemorySubagentCompletion({
        subagentType: "reflection",
        success: true,
      }),
    ).toBe("Dreamed and made some memories.");
  });

  test("init success points at the palace", async () => {
    expect(
      await handleMemorySubagentCompletion({
        subagentType: "init",
        success: true,
      }),
    ).toBe("Built a memory palace of you. Visit it with /palace.");
  });

  test("reflection failure reports getting lost (detail hidden outside debug)", async () => {
    const message = await handleMemorySubagentCompletion({
      subagentType: "reflection",
      success: false,
      error: "boom",
    });
    expect(message).toBe("Tried to reflect, but got lost in the palace");
  });

  test("init failure surfaces the error", async () => {
    expect(
      await handleMemorySubagentCompletion({
        subagentType: "init",
        success: false,
        error: "disk full",
      }),
    ).toBe("Memory initialization failed: disk full");
  });

  test("a string success override replaces the default message", async () => {
    expect(
      await handleMemorySubagentCompletion({
        subagentType: "init",
        success: true,
        successMessageOverride: "Custom completion.",
      }),
    ).toBe("Custom completion.");
  });

  test("a function success override receives the action and default message", async () => {
    let seenAction = "";
    let seenDefault = "";
    const message = await handleMemorySubagentCompletion({
      subagentType: "reflection",
      success: true,
      successMessageOverride: ({ action, defaultMessage }) => {
        seenAction = action;
        seenDefault = defaultMessage;
        return "done";
      },
    });
    expect(message).toBe("done");
    expect(seenAction).toBe("Dreamed");
    expect(seenDefault).toBe("Dreamed and made some memories.");
  });
});
