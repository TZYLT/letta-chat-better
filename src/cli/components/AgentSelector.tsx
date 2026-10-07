import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { Box, useInput } from "ink";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type AgentBackendMode, isLocalAgentId } from "@/agent/agent-id";
import { unpinAgentForCurrentUser } from "@/agent/favorites";
import { getBackendForMode } from "@/backend/backend";
import { listLocalAgentsFromDisk } from "@/cli/helpers/local-agent-listing";
import {
  listPinnedAgentsForCurrentUser,
  type PinnedAgentData,
} from "@/cli/helpers/pinned-agent-listing";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { DEFAULT_AGENT_NAME } from "@/constants";
import { AgentSelectorFooter } from "./AgentSelectorFooter";
import { AgentDeleteConfirmOverlay } from "./AgentSelectorViews";
import {
  AGENT_SELECTOR_TAB_DESCRIPTIONS,
  AGENT_SELECTOR_TAB_EMPTY_STATES,
  type AgentSelectorListAgent,
  type AgentSelectorTabId,
  formatAgentMemoryBlockCount,
  formatAgentModel,
  formatRelativeTime,
  getVisibleAgentSelectorTabs,
  truncateAgentId,
} from "./agent-selector-utils";
import { colors } from "./colors";
import { OverlayShell } from "./OverlayShell";
import { PasteAwareTextInput } from "./PasteAwareTextInput";
import { validateAgentName } from "./PinDialog";
import { TabBar } from "./TabBar";
import { Text } from "./Text";

interface AgentSelectorProps {
  currentAgentId: string;
  onSelect: (agentId: string, backendMode: AgentBackendMode) => void;
  onCancel: () => void;
  onLogin?: () => void;
  /** Called when user creates a new agent (from New tab or N shortcut) */
  onCreateNewAgent?: (name: string, backendMode: AgentBackendMode) => void;
  /** The command that triggered this selector (e.g., "/agents" or "/resume") */
  command?: string;
  /** Override the overlay title. */
  title?: string;
  /** Whether to show the New tab and N shortcut. */
  showNewTab?: boolean;
  /** Whether Shift+D can delete agents from the selector. */
  allowDelete?: boolean;
  /** Whether Shift+P can unpin agents from the selector. */
  allowPinActions?: boolean;
}

type ViewState =
  | { type: "list" }
  | {
      type: "deleteConfirm";
      agent: AgentState;
      agentId: string;
      isLocal: boolean;
    };

const DISPLAY_PAGE_SIZE = 5;

export function AgentSelector({
  currentAgentId,
  onSelect,
  onCancel,
  onCreateNewAgent,
  command = "/agents",
  title = "Swap to a different agent",
  showNewTab = true,
  allowDelete = true,
  allowPinActions = true,
}: AgentSelectorProps) {
  const terminalWidth = useTerminalWidth();

  // Tab state
  // Eagerly check for local agents (synchronous disk read) to determine tab visibility
  const [hasLocalAgents, setHasLocalAgents] = useState(() => {
    try {
      return listLocalAgentsFromDisk().length > 0;
    } catch {
      return false;
    }
  });

  // Compute visible tabs — Local tab only shown when there are local agents
  const visibleTabs = useMemo(
    () => getVisibleAgentSelectorTabs({ showNewTab, hasLocalAgents }),
    [hasLocalAgents, showNewTab],
  );

  const [activeTab, setActiveTab] = useState<AgentSelectorTabId>("pinned");

  // If active tab is no longer visible (e.g. local tab hidden after deleting all
  // local agents), fall back to Pinned.
  useEffect(() => {
    if (activeTab === "local" && !hasLocalAgents) {
      setActiveTab("pinned");
    } else if (activeTab === "new" && !showNewTab) {
      setActiveTab("pinned");
    }
  }, [activeTab, hasLocalAgents, showNewTab]);

  // Pinned tab state
  const [pinnedAgents, setPinnedAgents] = useState<PinnedAgentData[]>([]);
  const [pinnedLoading, setPinnedLoading] = useState(true);
  const [pinnedSelectedIndex, setPinnedSelectedIndex] = useState(0);
  const [pinnedPage, setPinnedPage] = useState(0);

  // Local tab state (reads from disk, no API calls)
  const [localAgents, setLocalAgents] = useState<AgentState[]>([]);
  const [localLoading, setLocalLoading] = useState(false);
  const [localSelectedIndex, setLocalSelectedIndex] = useState(0);
  const [localPage, setLocalPage] = useState(0);
  const [localLoaded, setLocalLoaded] = useState(false);

  // Search state (shared across list tabs)
  const [searchInput, setSearchInput] = useState("");
  const [activeQuery, setActiveQuery] = useState("");

  // Delete confirmation state
  const [viewState, setViewState] = useState<ViewState>({ type: "list" });
  const [deleteConfirmInput, setDeleteConfirmInput] = useState("");
  const [deleteLoading, setDeleteLoading] = useState(false);

  // New agent tab state
  const [newAgentNameInput, setNewAgentNameInput] = useState("");
  const [newAgentNameError, setNewAgentNameError] = useState("");

  // Load pinned agents
  const loadPinnedAgents = useCallback(async () => {
    setPinnedLoading(true);
    try {
      const pinnedData = await listPinnedAgentsForCurrentUser();
      const validPinnedData = pinnedData.filter((p) => p.agent !== null);

      if (validPinnedData.length === 0) {
        setPinnedAgents([]);
        setPinnedLoading(false);
        return;
      }

      setPinnedAgents(pinnedData);
    } catch {
      setPinnedAgents([]);
    } finally {
      setPinnedLoading(false);
    }
  }, []);

  // Load local agents from disk
  const loadLocalAgents = useCallback(() => {
    setLocalLoading(true);
    try {
      const agents = listLocalAgentsFromDisk();
      setLocalAgents(agents);
      setHasLocalAgents(agents.length > 0);
      setLocalPage(0);
      setLocalSelectedIndex(0);
      setLocalLoaded(true);
    } catch {
      setLocalAgents([]);
      setHasLocalAgents(false);
    } finally {
      setLocalLoading(false);
    }
  }, []);

  // Load pinned agents on mount
  useEffect(() => {
    loadPinnedAgents();
  }, [loadPinnedAgents]);

  // Load tab data when switching tabs (only if not already loaded)
  useEffect(() => {
    if (activeTab === "local" && !localLoaded && !localLoading) {
      loadLocalAgents();
    }
  }, [activeTab, localLoaded, localLoading, loadLocalAgents]);

  // Pagination calculations - Pinned (filter out 404 agents)
  const validPinnedAgents = pinnedAgents.filter((p) => p.agent !== null);
  const pinnedTotalPages = Math.ceil(
    validPinnedAgents.length / DISPLAY_PAGE_SIZE,
  );
  const pinnedStartIndex = pinnedPage * DISPLAY_PAGE_SIZE;
  const pinnedPageAgents = validPinnedAgents.slice(
    pinnedStartIndex,
    pinnedStartIndex + DISPLAY_PAGE_SIZE,
  );

  // Pagination calculations - Local (current agent pinned to top)
  const sortedLocalAgents = useMemo(
    () =>
      localAgents.toSorted((a, b) => {
        if (a.id === currentAgentId) return -1;
        if (b.id === currentAgentId) return 1;
        return 0;
      }),
    [localAgents, currentAgentId],
  );
  const localTotalPages = Math.ceil(
    sortedLocalAgents.length / DISPLAY_PAGE_SIZE,
  );
  const localStartIndex = localPage * DISPLAY_PAGE_SIZE;
  const localPageAgents = sortedLocalAgents.slice(
    localStartIndex,
    localStartIndex + DISPLAY_PAGE_SIZE,
  );

  // Current tab's state (computed)
  let currentLoading = false;
  const currentError: string | null = null;
  let currentAgents: AgentSelectorListAgent[] = [];
  let setCurrentSelectedIndex = setPinnedSelectedIndex;
  if (activeTab === "pinned") {
    currentLoading = pinnedLoading;
    currentAgents = pinnedPageAgents
      .map((p) => p.agent)
      .filter((agent): agent is AgentState => agent !== null);
    setCurrentSelectedIndex = setPinnedSelectedIndex;
  } else if (activeTab === "local") {
    currentLoading = localLoading;
    currentAgents = localPageAgents;
    setCurrentSelectedIndex = setLocalSelectedIndex;
  }

  // Submit search
  const submitSearch = useCallback(() => {
    if (searchInput !== activeQuery) {
      setActiveQuery(searchInput);
    }
  }, [searchInput, activeQuery]);

  // Clear search (effect will handle reload when query changes)
  const clearSearch = useCallback(() => {
    setSearchInput("");
    if (activeQuery) {
      setActiveQuery("");
    }
  }, [activeQuery]);

  // Handle agent deletion
  const handleDeleteAgent = useCallback(async () => {
    if (viewState.type !== "deleteConfirm") return;
    const { agent, agentId, isLocal } = viewState;
    const expectedName = agent.name || agentId.slice(0, 12);

    if (deleteConfirmInput !== expectedName) return;

    setDeleteLoading(true);
    try {
      // One backend serves every mode; the mode only names the pin namespace.
      const backend = getBackendForMode(isLocal ? "local" : "api");
      await backend.deleteAgent(agentId);

      // Reset state and refresh tabs
      setViewState({ type: "list" });
      setDeleteConfirmInput("");
      // Reload pinned and invalidate cached tabs
      loadPinnedAgents();
      setLocalLoaded(false);
    } catch {
      // Stay on confirmation screen on error
    } finally {
      setDeleteLoading(false);
    }
  }, [viewState, deleteConfirmInput, loadPinnedAgents]);

  useInput((input, key) => {
    // CTRL-C: immediately cancel
    if (key.ctrl && input === "c") {
      onCancel();
      return;
    }

    // Handle delete confirmation view
    if (viewState.type === "deleteConfirm") {
      // Always allow Esc to back out (even during deletion)
      if (key.escape) {
        setViewState({ type: "list" });
        setDeleteConfirmInput("");
        return;
      }

      // Disable all other input while deleting
      if (deleteLoading) return;

      if (key.return) {
        handleDeleteAgent();
      } else if (key.backspace || key.delete) {
        setDeleteConfirmInput((prev) => prev.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setDeleteConfirmInput((prev) => prev + input);
      }
      return;
    }

    // List view handlers below

    // Tab key cycles through tabs
    if (key.tab) {
      const currentIndex = visibleTabs.findIndex((t) => t.id === activeTab);
      const nextIndex = (currentIndex + 1) % visibleTabs.length;
      setActiveTab(visibleTabs[nextIndex]?.id ?? "pinned");
      return;
    }

    if (currentLoading) return;

    // New tab has its own input handling via PasteAwareTextInput.
    // Only handle Escape here.
    if (activeTab === "new") {
      if (key.escape) {
        if (newAgentNameInput) {
          setNewAgentNameInput("");
          setNewAgentNameError("");
        } else {
          onCancel();
        }
      }
      return;
    }

    const maxIndex = currentAgents.length - 1;

    if (key.upArrow) {
      setCurrentSelectedIndex((prev: number) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setCurrentSelectedIndex((prev: number) => Math.min(maxIndex, prev + 1));
    } else if (key.return) {
      // If typing a search query (list tabs only), submit it
      if (
        activeTab !== "pinned" &&
        searchInput &&
        searchInput !== activeQuery
      ) {
        submitSearch();
        return;
      }

      // Select agent
      if (activeTab === "pinned") {
        const selected = pinnedPageAgents[pinnedSelectedIndex];
        if (selected?.agent) {
          onSelect(selected.agentId, selected.backendMode);
        }
      } else if (activeTab === "local") {
        const selected = localPageAgents[localSelectedIndex];
        if (selected?.id) {
          onSelect(selected.id, "local");
        }
      }
    } else if (key.escape) {
      // If typing search (list tabs), clear it first
      if (activeTab !== "pinned" && searchInput) {
        clearSearch();
        return;
      }
      onCancel();
    } else if (key.backspace || key.delete) {
      if (activeTab !== "pinned") {
        setSearchInput((prev) => prev.slice(0, -1));
      }
    } else if (key.leftArrow) {
      // Previous page
      if (activeTab === "pinned") {
        if (pinnedPage > 0) {
          setPinnedPage((prev) => prev - 1);
          setPinnedSelectedIndex(0);
        }
      } else if (activeTab === "local") {
        if (localPage > 0) {
          setLocalPage((prev) => prev - 1);
          setLocalSelectedIndex(0);
        }
      }
    } else if (key.rightArrow) {
      // Next page
      if (activeTab === "pinned") {
        if (pinnedPage < pinnedTotalPages - 1) {
          setPinnedPage((prev) => prev + 1);
          setPinnedSelectedIndex(0);
        }
      } else if (activeTab === "local") {
        if (localPage < localTotalPages - 1) {
          setLocalPage((prev) => prev + 1);
          setLocalSelectedIndex(0);
        }
      }
    } else if (
      allowPinActions &&
      activeTab === "pinned" &&
      (input === "p" || input === "P")
    ) {
      // Unpin from current scope (pinned tab only)
      const selected = pinnedPageAgents[pinnedSelectedIndex];
      if (selected) {
        const backend = getBackendForMode(selected.backendMode);
        void unpinAgentForCurrentUser(selected.agentId, backend).finally(() => {
          loadPinnedAgents();
        });
      }
    } else if (allowDelete && input === "D") {
      // Delete agent - open confirmation
      let selectedAgent: AgentState | null = null;
      let selectedAgentId: string | null = null;
      let selectedIsLocal = false;

      if (activeTab === "pinned") {
        const selected = pinnedPageAgents[pinnedSelectedIndex];
        if (selected?.agent) {
          selectedAgent = selected.agent;
          selectedAgentId = selected.agentId;
          selectedIsLocal = selected.backendMode === "local";
        }
      } else if (activeTab === "local") {
        selectedAgent = localPageAgents[localSelectedIndex] ?? null;
        selectedAgentId = selectedAgent?.id ?? null;
        selectedIsLocal = true;
      }

      if (selectedAgent && selectedAgentId) {
        setViewState({
          type: "deleteConfirm",
          agent: selectedAgent,
          agentId: selectedAgentId,
          isLocal: selectedIsLocal,
        });
        setDeleteConfirmInput("");
      }
    } else if (showNewTab && (input === "n" || input === "N")) {
      // Switch to New tab
      setActiveTab("new");
    } else if (activeTab !== "pinned" && input && !key.ctrl && !key.meta) {
      // Type to search (list tabs only)
      setSearchInput((prev) => prev + input);
    }
  });
  // Render agent item (shared between tabs)
  const renderAgentItem = (
    agent: AgentSelectorListAgent,
    _index: number,
    isSelected: boolean,
    extra?: { backend?: "local" | "cloud" | "shared" },
  ) => {
    const isCurrent = agent.id === currentAgentId;
    const isLocalAgent = isLocalAgentId(agent.id);
    const relativeTime = formatRelativeTime(agent.last_run_completion);
    const blockCountText = formatAgentMemoryBlockCount(agent.blocks?.length);
    const modelStr = formatAgentModel(agent);
    const metadataParts = [relativeTime];
    if (!isLocalAgent && extra?.backend !== "shared") {
      if (blockCountText) {
        metadataParts.push(blockCountText);
      }
      metadataParts.push(modelStr);
    }
    if (extra?.backend === "shared" && agent.creator?.name) {
      metadataParts.push(`Shared by ${agent.creator.name}`);
    }

    const nameLen = (agent.name || "Unnamed").length;
    const fixedChars = 2 + 3 + (isCurrent ? 10 : 0);
    const availableForId = Math.max(15, terminalWidth - nameLen - fixedChars);
    const displayId = truncateAgentId(agent.id, availableForId);

    let backendLabel = "";
    if (extra?.backend === "local") {
      backendLabel = "Local · ";
    } else if (extra?.backend === "cloud") {
      backendLabel = "Cloud · ";
    } else if (extra?.backend === "shared") {
      backendLabel = "Shared · ";
    }

    return (
      <Box key={agent.id} flexDirection="column" marginBottom={1}>
        <Box flexDirection="row">
          <Text
            color={isSelected ? colors.selector.itemHighlighted : undefined}
          >
            {isSelected ? ">" : " "}
          </Text>
          <Text> </Text>
          <Text
            bold={isSelected}
            color={isSelected ? colors.selector.itemHighlighted : undefined}
          >
            {agent.name || "Unnamed"}
          </Text>
          <Text dimColor>
            {" · "}
            {backendLabel}
            {displayId}
          </Text>
          {isCurrent && (
            <Text color={colors.selector.itemCurrent}> (current)</Text>
          )}
        </Box>
        <Box flexDirection="row" marginLeft={2}>
          <Text dimColor italic>
            {agent.description || "No description"}
          </Text>
        </Box>
        <Box flexDirection="row" marginLeft={2}>
          <Text dimColor>{metadataParts.join(" · ")}</Text>
        </Box>
      </Box>
    );
  };

  // Render pinned agent item (may have error)
  const renderPinnedItem = (
    data: PinnedAgentData,
    index: number,
    isSelected: boolean,
  ) => {
    if (data.agent) {
      return renderAgentItem(data.agent, index, isSelected, {});
    }

    // Error state for missing agent
    return (
      <Box key={data.agentId} flexDirection="column" marginBottom={1}>
        <Box flexDirection="row">
          <Text
            color={isSelected ? colors.selector.itemHighlighted : undefined}
          >
            {isSelected ? ">" : " "}
          </Text>
          <Text> </Text>
          <Text
            bold={isSelected}
            color={isSelected ? colors.selector.itemHighlighted : undefined}
          >
            {data.agentId.slice(0, 12)}
          </Text>
        </Box>
        <Box flexDirection="row" marginLeft={2}>
          <Text color="red" italic>
            {data.error}
          </Text>
        </Box>
      </Box>
    );
  };

  // If in delete confirmation view, render that instead of the list
  if (viewState.type === "deleteConfirm") {
    const displayName = viewState.agent.name || viewState.agentId.slice(0, 12);
    return (
      <AgentDeleteConfirmOverlay
        command={command}
        displayName={displayName}
        input={deleteConfirmInput}
        loading={deleteLoading}
      />
    );
  }

  return (
    <OverlayShell
      command={command}
      title={title}
      footer={
        activeTab !== "new" &&
        !currentLoading &&
        (activeTab === "pinned" ||
          (!currentError && currentAgents.length > 0)) ? (
          <AgentSelectorFooter
            terminalWidth={terminalWidth}
            activeTab={activeTab}
            pinnedPage={pinnedPage}
            pinnedTotalPages={pinnedTotalPages}
            pinnedAgentsCount={validPinnedAgents.length}
            localPage={localPage}
            localTotalPages={localTotalPages}
            allowDelete={allowDelete}
            allowPinActions={allowPinActions}
            hasSelectedPinnedAgent={
              pinnedPageAgents[pinnedSelectedIndex] !== undefined
            }
          />
        ) : undefined
      }
    >
      <Box flexDirection="column" paddingLeft={1}>
        <TabBar
          tabs={visibleTabs.map((t) => t.id)}
          activeTab={activeTab}
          getLabel={(tabId) =>
            visibleTabs.find((t) => t.id === tabId)?.label ?? tabId
          }
        />
        <Text dimColor> {AGENT_SELECTOR_TAB_DESCRIPTIONS[activeTab]}</Text>
        <Box height={1} />
      </Box>

      {/* Search input - list tabs only */}
      {activeTab !== "pinned" &&
        activeTab !== "new" &&
        (searchInput || activeQuery) && (
          <Box marginBottom={1}>
            <Text dimColor>Search: </Text>
            <Text>{searchInput}</Text>
            {searchInput && searchInput !== activeQuery && (
              <Text dimColor> (press Enter to search)</Text>
            )}
            {activeQuery && searchInput === activeQuery && (
              <Text dimColor> (Esc to clear)</Text>
            )}
          </Box>
        )}

      {/* Error state - list tabs */}
      {activeTab !== "pinned" && currentError && (
        <Box flexDirection="column">
          <Text color="red">Error: {currentError}</Text>
          <Text dimColor>Press ESC to cancel</Text>
        </Box>
      )}

      {/* Loading state */}
      {currentLoading && (
        <Box>
          <Text dimColor>{"  "}Loading agents...</Text>
        </Box>
      )}

      {/* Empty state */}
      {!currentLoading &&
        ((activeTab === "pinned" && validPinnedAgents.length === 0) ||
          (activeTab === "local" &&
            !currentError &&
            currentAgents.length === 0)) && (
          <Box
            flexDirection="column"
            paddingLeft={activeTab === "pinned" ? 2 : 0}
          >
            <Text dimColor>{AGENT_SELECTOR_TAB_EMPTY_STATES[activeTab]}</Text>
            {activeTab !== "pinned" && (
              <Text dimColor>Press ESC to cancel</Text>
            )}
          </Box>
        )}

      {/* Pinned tab content */}
      {activeTab === "pinned" &&
        !pinnedLoading &&
        validPinnedAgents.length > 0 && (
          <Box flexDirection="column">
            {pinnedPageAgents.map((data, index) =>
              renderPinnedItem(data, index, index === pinnedSelectedIndex),
            )}
          </Box>
        )}

      {/* Local tab content */}
      {activeTab === "local" && !localLoading && localAgents.length > 0 && (
        <Box flexDirection="column">
          {localPageAgents.map((agent, index) =>
            renderAgentItem(agent, index, index === localSelectedIndex, {
              backend: "local",
            }),
          )}
        </Box>
      )}

      {/* New tab content */}
      {activeTab === "new" && (
        <Box flexDirection="column">
          <Box paddingLeft={2}>
            <Text>
              Enter a name for your new agent, or press Enter for default.
            </Text>
          </Box>
          <Box height={1} />
          <Box flexDirection="column">
            <Box paddingLeft={2}>
              <Text>Agent name:</Text>
            </Box>
            <Box>
              <Text color={colors.selector.itemHighlighted}>{">"}</Text>
              <Text> </Text>
              <PasteAwareTextInput
                value={newAgentNameInput}
                onChange={(val) => {
                  setNewAgentNameInput(val);
                  setNewAgentNameError("");
                }}
                onSubmit={(text) => {
                  const trimmed = text.trim();
                  if (!trimmed) {
                    onCreateNewAgent?.(DEFAULT_AGENT_NAME, "local");
                    return;
                  }
                  const validationError = validateAgentName(trimmed);
                  if (validationError) {
                    setNewAgentNameError(validationError);
                    return;
                  }
                  onCreateNewAgent?.(trimmed, "local");
                }}
                placeholder={DEFAULT_AGENT_NAME}
              />
            </Box>
          </Box>
          {newAgentNameError && (
            <Box paddingLeft={2} marginTop={1}>
              <Text color="red">{newAgentNameError}</Text>
            </Box>
          )}
          <Box height={1} />
          <Box paddingLeft={2}>
            <Text dimColor>{"Enter create · Esc cancel"}</Text>
          </Box>
        </Box>
      )}
    </OverlayShell>
  );
}
