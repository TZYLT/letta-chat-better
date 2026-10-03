import { describe, expect, test } from "bun:test";
import { formatRecompileCommandOutput } from "@/cli/helpers/recompile-command";

describe("formatRecompileCommandOutput", () => {
  test("includes the applied summary between the confirmation and the warning", () => {
    const output = formatRecompileCommandOutput(
      "Applied: 1 memory commit(s), model change.",
    );
    expect(output).toBe(
      [
        "Recompiled current agent and conversation.",
        "Applied: 1 memory commit(s), model change.",
        "(warning: this will evict the cache and increase costs)",
      ].join("\n"),
    );
  });

  test("omits the summary line when the backend has no prefix freeze", () => {
    const output = formatRecompileCommandOutput(undefined);
    expect(output).not.toContain("Applied:");
    expect(output).toContain("Recompiled current agent and conversation.");
    expect(output).toContain("evict the cache");
  });
});
