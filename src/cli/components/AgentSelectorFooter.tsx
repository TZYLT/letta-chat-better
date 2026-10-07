import { Box } from "ink";
import type { ReactElement } from "react";
import type { AgentSelectorTabId } from "./agent-selector-utils";
import { MarkdownDisplay } from "./MarkdownDisplay";

interface AgentSelectorFooterProps {
  terminalWidth: number;
  activeTab: AgentSelectorTabId;
  pinnedPage: number;
  pinnedTotalPages: number;
  pinnedAgentsCount: number;
  localPage: number;
  localTotalPages: number;
  allowDelete: boolean;
  allowPinActions: boolean;
  hasSelectedPinnedAgent: boolean;
}

function buildPageText(params: AgentSelectorFooterProps): string {
  if (params.activeTab === "pinned") {
    return `Page ${params.pinnedPage + 1}/${params.pinnedTotalPages || 1}`;
  }
  return `Page ${params.localPage + 1}/${params.localTotalPages || 1}`;
}

function buildHintsText(params: AgentSelectorFooterProps): string {
  const deleteHint = params.allowDelete ? " · Shift+D delete" : "";
  const pinnedHint =
    params.allowPinActions &&
    params.activeTab === "pinned" &&
    params.hasSelectedPinnedAgent
      ? " · Shift+P unpin"
      : "";
  return `Enter select · ↑↓ ←→ navigate · Tab switch${deleteHint}${pinnedHint} · Esc cancel`;
}

export function AgentSelectorFooter(
  props: AgentSelectorFooterProps,
): ReactElement {
  const footerWidth = Math.max(0, props.terminalWidth - 2);
  if (props.activeTab === "pinned" && props.pinnedAgentsCount === 0) {
    return (
      <Box flexDirection="row">
        <Box width={2} flexShrink={0} />
        <Box flexGrow={1} width={footerWidth}>
          <MarkdownDisplay text="Tab switch · Esc cancel" dimColor />
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box width={2} flexShrink={0} />
        <Box flexGrow={1} width={footerWidth}>
          <MarkdownDisplay text={buildPageText(props)} dimColor />
        </Box>
      </Box>
      <Box flexDirection="row">
        <Box width={2} flexShrink={0} />
        <Box flexGrow={1} width={footerWidth}>
          <MarkdownDisplay text={buildHintsText(props)} dimColor />
        </Box>
      </Box>
    </Box>
  );
}
