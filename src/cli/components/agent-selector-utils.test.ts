import { describe, expect, test } from "bun:test";
import {
  formatAgentMemoryBlockCount,
  getVisibleAgentSelectorTabs,
} from "@/cli/components/agent-selector-utils";

describe("formatAgentMemoryBlockCount", () => {
  test("omits unavailable block counts", () => {
    expect(formatAgentMemoryBlockCount(undefined)).toBeNull();
    expect(formatAgentMemoryBlockCount(null)).toBeNull();
  });

  test("omits zero block counts", () => {
    expect(formatAgentMemoryBlockCount(0)).toBeNull();
  });

  test("formats positive singular and plural block counts", () => {
    expect(formatAgentMemoryBlockCount(1)).toBe("1 memory block");
    expect(formatAgentMemoryBlockCount(2)).toBe("2 memory blocks");
  });
});

describe("getVisibleAgentSelectorTabs", () => {
  // Regression: the Cloud and Shared tabs listed agents through the SDK client
  // against api.letta.com, which this build has no backend for, so they queried
  // the configured server for agents that cannot be listed.
  test("never offers the Cloud or Shared tabs", () => {
    const ids = getVisibleAgentSelectorTabs({
      showNewTab: true,
      hasLocalAgents: true,
    }).map((tab) => tab.id);

    expect(ids).not.toContain("cloud");
    expect(ids).not.toContain("shared");
  });

  test("keeps Pinned first and gates Local and New", () => {
    expect(
      getVisibleAgentSelectorTabs({ showNewTab: true, hasLocalAgents: true }),
    ).toEqual([
      { id: "pinned", label: "Pinned" },
      { id: "local", label: "Local" },
      { id: "new", label: "New" },
    ]);

    expect(
      getVisibleAgentSelectorTabs({ showNewTab: false, hasLocalAgents: false }),
    ).toEqual([{ id: "pinned", label: "Pinned" }]);
  });
});
