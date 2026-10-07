import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AGENT_SELECTOR_TABS,
  getVisibleAgentSelectorTabs,
} from "@/cli/components/agent-selector-utils";
import { getPinnedAgentBackendMode } from "@/cli/helpers/pinned-agent-listing";

describe("agent selector shortcuts", () => {
  test("uses Shift+D for delete so lowercase d can be typed in search", () => {
    const selectorPath = fileURLToPath(
      new URL("../cli/components/AgentSelector.tsx", import.meta.url),
    );
    const footerPath = fileURLToPath(
      new URL("../cli/components/AgentSelectorFooter.tsx", import.meta.url),
    );
    const source = readFileSync(selectorPath, "utf-8");
    const footerSource = readFileSync(footerPath, "utf-8");

    expect(source).toContain('allowDelete && input === "D"');
    expect(source).not.toContain('input === "d" || input === "D"');

    const deleteShortcutIndex = source.indexOf('allowDelete && input === "D"');
    const searchTypingIndex = source.indexOf(
      '} else if (activeTab !== "pinned" && input && !key.ctrl && !key.meta) {',
    );

    expect(deleteShortcutIndex).toBeGreaterThanOrEqual(0);
    expect(searchTypingIndex).toBeGreaterThan(deleteShortcutIndex);
    expect(footerSource).toContain("Shift+D delete");
  });

  test("pinned agent backend comes from agent id, not pin scope", () => {
    expect(
      getPinnedAgentBackendMode(
        "agent-local-c47c57d5-72c5-4f23-baea-3fb1d441273e",
      ),
    ).toBe("local");
    expect(
      getPinnedAgentBackendMode("agent-6b383e6f-f2df-43ed-ad88-8c832f1129d0"),
    ).toBe("api");
  });

  // The Cloud and Shared tabs are gone outright: both listed agents that live in
  // Letta Cloud, which this build has no backend for, so their branches in the
  // selector were unreachable. The tab ids are out of the union, which keeps the
  // compiler from letting them back in.
  test("offers only tabs this build can list", () => {
    const visible = getVisibleAgentSelectorTabs({
      showNewTab: true,
      hasLocalAgents: true,
    }).map((tab) => tab.id);

    expect(visible).toEqual(["pinned", "local", "new"]);
    expect(AGENT_SELECTOR_TABS.map((tab) => tab.id)).toEqual([
      "pinned",
      "local",
      "new",
    ]);
  });

  test("keeps one spacer after tab descriptions", () => {
    const selectorPath = fileURLToPath(
      new URL("../cli/components/AgentSelector.tsx", import.meta.url),
    );
    const source = readFileSync(selectorPath, "utf-8");

    expect(source).toContain("<Box height={1} />");
    expect(source).not.toContain("<Box height={2} />");
  });
});
