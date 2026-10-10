import { Box } from "ink";
import type { SessionStatsSnapshot } from "@/agent/stats";
import { colors } from "@/cli/components/colors";
import { formatDuration } from "@/cli/components/SessionStats";
import { Text } from "@/cli/components/Text";
import { formatCompact } from "@/cli/helpers/format";
import { settingsManager } from "@/settings-manager";

export function ExitStats({
  stats,
  agentName,
  agentId,
  conversationId,
}: {
  stats: SessionStatsSnapshot;
  agentName: string | null;
  agentId: string;
  conversationId: string;
}) {
  const isPinned = agentName && settingsManager.isAgentPinned(agentId);

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Stats (3 lines). The upstream art slot is intentionally blank: the
          glyphs that used to sit here are upstream brand artwork, which the
          LICENSE "Brand Assets Exclusion" excludes from the Apache-2.0 grant.
          The reserved column is kept so the layout and the labels stay aligned
          when this fork draws its own mark. */}
      <Box>
        <Text color={colors.footer.agentName}>{"        "}</Text>
        <Text dimColor>
          Total duration (API): {formatDuration(stats.totalApiMs)}
        </Text>
      </Box>
      <Box>
        <Text color={colors.footer.agentName}>{"        "}</Text>
        <Text dimColor>
          Total duration (wall): {formatDuration(stats.totalWallMs)}
        </Text>
      </Box>
      <Box>
        <Text color={colors.footer.agentName}>{"        "}</Text>
        <Text dimColor>
          Session usage: {stats.usage.stepCount} steps,{" "}
          {formatCompact(stats.usage.promptTokens)} input,{" "}
          {formatCompact(stats.usage.completionTokens)} output
        </Text>
      </Box>
      {/* Resume commands (no art slot) */}
      <Box height={1} />
      <Text dimColor>Resume this agent with:</Text>
      <Text color={colors.link.url}>
        {isPinned
          ? `haruyuki -n "${agentName}"`
          : `haruyuki --agent ${agentId}`}
      </Text>
      {/* Only show conversation hint if not on default (default is resumed automatically) */}
      {conversationId !== "default" && conversationId !== agentId && (
        <>
          <Box height={1} />
          <Text dimColor>Resume this conversation with:</Text>
          <Text
            color={colors.link.url}
          >{`haruyuki --conv ${conversationId}`}</Text>
        </>
      )}
    </Box>
  );
}
