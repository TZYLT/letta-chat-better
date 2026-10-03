import { describe, expect, test } from "bun:test";
import { refreshSubagentConfigs } from "./task-refresh";

describe("refreshSubagentConfigs", () => {
  test("reports the refreshed subagent counts", async () => {
    const output = await refreshSubagentConfigs();

    expect(output).toStartWith("Refreshed subagents list: found ");
    expect(output).toContain(" total (");
    expect(output).toContain(" custom)");
  });
});
