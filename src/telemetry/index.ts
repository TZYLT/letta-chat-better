import { debugLogFile } from "@/utils/debug";
import { getVersion } from "@/version";
import {
  resolveTelemetryAgentOrigin,
  type TelemetryAgentOrigin,
} from "./agent-origin";
import { appendBoundaryError } from "./boundary-error-log";
import { extractInputChannel } from "./channel";
import { installFatalErrorHandlers } from "./fatal-error-handler";

export type TelemetrySurface =
  | "letta_code_tui"
  | "letta_code_headless"
  | "letta_code_cli_server"
  | "letta_code_desktop";

export interface TelemetryInitOptions {
  /**
   * Retained for call-site compatibility. The SIGINT drain handler that read it
   * belonged to the removed cloud transport.
   */
  handleSigint?: boolean;
}

export interface TelemetryEvent {
  type:
    | "session_start"
    | "session_end"
    | "tool_usage"
    | "error"
    | "user_input"
    | "channel_gateway_lifecycle"
    | "reflection_start"
    | "reflection_end"
    | "reflection_worktree_cleanup"
    | "reflection_arena_vote";
  timestamp: string;
  data: Record<string, unknown>;
}

export interface SessionStartData {
  startup_command: string;
  version: string;
  platform: string;
  node_version: string;
}

export interface SessionEndData {
  duration: number; // in seconds
  message_count: number;
  tool_call_count: number;
  exit_reason?: string; // e.g., "exit_command", "logout", "sigint", "process_exit"
  total_api_ms?: number;
  total_wall_ms?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cached_input_tokens?: number;
  cached_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
  context_tokens?: number;
  step_count?: number;
}

export interface ToolUsageData {
  tool_name: string;
  channel?: string;
  channel_action?: string;
  success: boolean;
  duration: number;
  response_length?: number;
  error_type?: string;
  stderr?: string;
}

export interface ErrorData {
  error_type: string;
  error_message: string;
  context?: string;
  http_status?: number;
  model_id?: string;
  run_id?: string;
  recent_chunks?: Record<string, unknown>[];
  debug_log_tail?: string;
  is_subagent?: boolean;
  subagent_type?: string;
  model_handle?: string;
  fallback_kind?: string;
  platform?: string;
  version?: string;
}

export interface UserInputData {
  input_length: number;
  channel?: string;
  is_command: boolean;
  command_name?: string;
  message_type: string;
  model_id: string;
}

export interface ChannelGatewayLifecycleData {
  lifecycle_event:
    | "exit"
    | "process_error"
    | "restart_scheduled"
    | "restart_ready"
    | "restart_exhausted";
  restart_attempt: number;
  max_restart_attempts: number;
  restore_mode: "explicit_channels" | "enabled_accounts";
  channel_types: string[];
  duration_ms?: number;
  delay_ms?: number;
  exit_code?: number | null;
  signal?: string | null;
  reached_ready?: boolean;
  version?: string;
  platform?: string;
}

export type ReflectionTriggerSource =
  | "manual"
  | "step-count"
  | "compaction-event";

export interface ReflectionStartData {
  trigger_source: ReflectionTriggerSource;
  subagent_id?: string;
  conversation_id?: string;
  start_message_id?: string;
  end_message_id?: string;
  model?: string;
  version?: string;
  platform?: string;
}

export interface ReflectionEndData {
  trigger_source: ReflectionTriggerSource;
  success: boolean;
  subagent_id?: string;
  conversation_id?: string;
  error?: string;
  step_count?: number;
  duration_ms?: number;
  model?: string;
  version?: string;
  platform?: string;
}

export type ReflectionWorktreeCleanupOutcome =
  | "parent_dirty"
  | "merge_conflict"
  | "reflection_worktree_dirty"
  | "subagent_failed";

export interface ReflectionWorktreeCleanupData {
  outcome: ReflectionWorktreeCleanupOutcome;
  integration_status:
    | "parent_dirty"
    | "merge_conflict"
    | "dirty_uncommitted"
    | "failed";
  trigger_source?: ReflectionTriggerSource;
  subagent_id?: string;
  conversation_id?: string;
  reflection_worktree_id?: string;
  commit_count?: number;
  model?: string;
  version?: string;
  platform?: string;
}

export interface ReflectionArenaVoteData {
  run_id: string;
  choice: "win_loss" | "tie";
  winner: string | null;
  loser: string | null;
  winner_agent_id: string | null;
  loser_agent_id: string | null;
  parent_agent_id: string;
  parent_convo_id: string;
  timestamp: string;
  feedbackstr: string | null;
  lc_version: string;
  memory_base_commit: string | null;
  memory_candidate_commit: string | null;
  transcript_payload: string | null;
  transcript_payload_chars: number | null;
  transcript_payload_truncated: boolean;
  version?: string;
  platform?: string;
}

export function isLettaCodeDesktopRuntime(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.LETTA_DESKTOP_MODE === "1";
}

export function getTerminalTelemetrySurface(
  isHeadless: boolean,
): TelemetrySurface {
  return isHeadless ? "letta_code_headless" : "letta_code_tui";
}

export function getListenerTelemetrySurface(
  env: NodeJS.ProcessEnv = process.env,
): TelemetrySurface {
  return isLettaCodeDesktopRuntime(env)
    ? "letta_code_desktop"
    : "letta_code_cli_server";
}

/**
 * Returns true for error messages that are non-actionable noise:
 * - Billing/plan limit responses (premium-unavailable, usage-exceeded, not-enough-credits)
 * - User-initiated actions (cancelled, Ctrl+Z)
 * - Transient connection errors (DNS, SSL, socket hang up) — NOT Cloudflare 521/520 (filtered in PostHog)
 * - Environment issues (git/npm not installed)
 * - Expected concurrency (409 CONFLICT)
 * - Placeholder agent names (@author/agent)
 */
function isNonActionableError(message: string): boolean {
  return (
    /premium-unavailable|not-enough-credits|usage-exceeded/i.test(message) ||
    /Cancelled by user|SIGTSTP/i.test(message) ||
    /ENOTFOUND|EAI_AGAIN|ECONNRESET|socket hang up|EPROTO/i.test(message) ||
    /Connection error\./i.test(message) ||
    /\{"isTrusted":\s*true\}/.test(message) ||
    /spawn (git|npm) ENOENT/.test(message) ||
    /\bCONFLICT\b/.test(message) ||
    /@author\/agent not found/.test(message)
  );
}

class TelemetryManager {
  private sessionId: string;
  private currentAgentId: string | null = null;
  private currentAgentOrigin: TelemetryAgentOrigin | null = null;
  private surface: TelemetrySurface = "letta_code_tui";
  private sessionStartTime: number;
  private messageCount = 0;
  private toolCallCount = 0;
  private sessionEndTracked = false;
  private initialized = false;
  private removeFatalErrorHandlers: (() => void) | null = null;
  private sessionStatsGetter?: () => {
    totalWallMs: number;
    totalApiMs: number;
    usage: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      cachedInputTokens: number;
      cacheWriteTokens: number;
      reasoningTokens: number;
      contextTokens?: number;
      stepCount: number;
    };
  };

  constructor() {
    this.sessionId = this.generateSessionId();
    this.sessionStartTime = Date.now();
  }

  private generateSessionId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
  }

  /**
   * Check if telemetry is enabled based on environment variables.
   * Enabled by default unless explicitly disabled.
   */
  private isTelemetryEnabled(): boolean {
    // LETTA_CODE_TELEM is Letta Code's specific opt-out. DO_NOT_TRACK is a
    // broader convention also honored by install-time analytics packages.
    const envValue = process.env.LETTA_CODE_TELEM;
    if (envValue === "0" || envValue === "false") {
      return false;
    }

    if (process.env.DO_NOT_TRACK === "1") {
      return false;
    }

    return true;
  }

  /**
   * Install the crash handlers.
   *
   * Analytics are no longer collected, so this is the only thing init() still
   * does: it keeps the fatal handlers that pin a non-zero exit code and route
   * the crash into the local boundary-error log.
   */
  init(_options: TelemetryInitOptions = {}) {
    if (!this.isTelemetryEnabled() || this.initialized) {
      return;
    }
    this.initialized = true;

    this.removeFatalErrorHandlers = installFatalErrorHandlers({
      drain: () => this.drain(),
      trackError: (errorType, message, context) => {
        this.trackError(errorType, message, context);
      },
    });
  }

  /**
   * Analytics sink, intentionally inert.
   *
   * The event pipeline, its queue and its transport are gone. The typed
   * per-event methods below are retained so their ~100 call sites stay
   * untouched; they still maintain local counters and session state, and
   * trackError writes to the local boundary-error log rather than calling
   * here. Deleting the remaining call sites is a pure-deletion follow-up.
   */
  private track(_type: TelemetryEvent["type"], _data: unknown) {
    // No transport remains: nothing is collected, queued or transmitted.
  }

  /**
   * Set the current agent ID (called from App.tsx when agent changes).
   * trackError stamps it onto local boundary-error entries.
   */
  setCurrentAgentId(agentId: string | null) {
    this.currentAgentId = agentId;
    this.currentAgentOrigin = null;
  }

  /**
   * Record the origin of an agent the caller already loaded, so boundary
   * errors carry it without another API request.
   */
  setCurrentAgent(
    agentId: string | null,
    tags: readonly string[] | null | undefined,
  ) {
    this.currentAgentId = agentId;
    this.currentAgentOrigin = agentId
      ? (resolveTelemetryAgentOrigin(tags) ?? null)
      : null;
  }

  setSurface(surface: TelemetrySurface) {
    this.surface = surface;
  }

  /**
   * Always null: the version came from a /v1/health probe against the cloud
   * server. Callers keep the method so their payload shape is unchanged.
   */
  getServerVersion(): string | null {
    return null;
  }

  /**
   * Set a getter function for session stats (called from App.tsx)
   * This allows safety net handlers to access stats even if not explicitly passed
   * Pass undefined to clear the getter (for cleanup)
   */
  setSessionStatsGetter(
    getter?: () => {
      totalWallMs: number;
      totalApiMs: number;
      usage: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        cachedInputTokens: number;
        cacheWriteTokens: number;
        reasoningTokens: number;
        contextTokens?: number;
        stepCount: number;
      };
    },
  ) {
    this.sessionStatsGetter = getter;
  }

  /**
   * Get the current session ID
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Get the current message count
   */
  getMessageCount(): number {
    return this.messageCount;
  }

  /**
   * Get the current tool call count
   */
  getToolCallCount(): number {
    return this.toolCallCount;
  }

  /**
   * Track session start
   */
  trackSessionStart() {
    // Extract agent ID from startup args if --agent or -a is provided
    const args = process.argv.slice(2);
    const agentFlagIndex = args.findIndex(
      (arg) => arg === "--agent" || arg === "-a",
    );
    if (agentFlagIndex !== -1 && agentFlagIndex + 1 < args.length) {
      const agentId = args[agentFlagIndex + 1];
      if (agentId) {
        this.currentAgentId = agentId;
      }
    }

    const data: SessionStartData = {
      startup_command: args.join(" "),
      version: getVersion(),
      platform: process.platform,
      node_version: process.version,
    };
    this.track("session_start", data);
  }

  /**
   * Track session end
   * @param stats Optional session stats (from sessionStatsRef.current.getSnapshot() in App.tsx)
   * @param exitReason Optional reason for exit (e.g., "exit_command", "logout", "sigint", "process_exit")
   */
  trackSessionEnd(
    stats?: {
      totalWallMs: number;
      totalApiMs: number;
      usage: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        cachedInputTokens: number;
        cacheWriteTokens: number;
        reasoningTokens: number;
        contextTokens?: number;
        stepCount: number;
      };
    },
    exitReason?: string,
  ) {
    // Prevent double-tracking (can be called from both handleExit and process.on("exit"))
    if (this.sessionEndTracked) {
      return;
    }
    this.sessionEndTracked = true;

    // Try to get stats from getter if not provided (for safety net handlers)
    let sessionStats = stats;
    if (!sessionStats && this.sessionStatsGetter) {
      try {
        sessionStats = this.sessionStatsGetter();
      } catch {
        // Ignore errors - stats will be undefined
      }
    }

    const duration = Math.floor((Date.now() - this.sessionStartTime) / 1000);
    const data: SessionEndData = {
      duration,
      message_count: this.messageCount,
      tool_call_count: this.toolCallCount,
      exit_reason: exitReason,
      // Include optional stats if available
      total_api_ms: sessionStats?.totalApiMs,
      total_wall_ms: sessionStats?.totalWallMs,
      prompt_tokens: sessionStats?.usage.promptTokens,
      completion_tokens: sessionStats?.usage.completionTokens,
      total_tokens: sessionStats?.usage.totalTokens,
      cached_input_tokens: sessionStats?.usage.cachedInputTokens,
      cached_tokens: sessionStats?.usage.cachedInputTokens,
      cache_write_tokens: sessionStats?.usage.cacheWriteTokens,
      reasoning_tokens: sessionStats?.usage.reasoningTokens,
      context_tokens: sessionStats?.usage.contextTokens,
      step_count: sessionStats?.usage.stepCount,
    };
    this.track("session_end", data);
  }

  /**
   * Track tool usage
   */
  trackToolUsage(
    toolName: string,
    success: boolean,
    duration: number,
    responseLength?: number,
    errorType?: string,
    stderr?: string,
    channelMetadata?: Pick<ToolUsageData, "channel" | "channel_action">,
  ) {
    this.toolCallCount++;
    const data: ToolUsageData = {
      tool_name: toolName,
      success,
      duration,
      response_length: responseLength,
      error_type: errorType,
      stderr,
      ...channelMetadata,
    };
    this.track("tool_usage", data);
  }

  trackChannelGatewayLifecycle(
    data: Omit<ChannelGatewayLifecycleData, "version" | "platform">,
  ) {
    this.track("channel_gateway_lifecycle", {
      ...data,
      version: getVersion(),
      platform: process.platform,
    });
  }

  /**
   * Append a boundary error to the local JSONL log.
   *
   * The cloud-only guard is gone on purpose: it read isCloudUser(), which is
   * false under the local backend, so every one of the callers below used to
   * drop its error silently. The local log replaces the upload, which means
   * local mode keeps diagnostics it never had before.
   */
  trackError(
    errorType: string,
    errorMessage: string,
    context?: string,
    options?: {
      httpStatus?: number;
      modelId?: string;
      runId?: string;
      recentChunks?: Record<string, unknown>[];
      isSubagent?: boolean;
      subagentType?: string;
      modelHandle?: string;
      fallbackKind?: string;
      omitDebugLogTail?: boolean;
    },
  ) {
    if (isNonActionableError(errorMessage)) {
      return;
    }

    appendBoundaryError({
      errorType,
      message: errorMessage,
      context,
      httpStatus: options?.httpStatus,
      modelId: options?.modelId,
      runId: options?.runId,
      recentChunks: options?.recentChunks,
      debugLogTail: options?.omitDebugLogTail
        ? undefined
        : debugLogFile.getTail(),
      isSubagent: options?.isSubagent,
      subagentType: options?.subagentType,
      modelHandle: options?.modelHandle,
      fallbackKind: options?.fallbackKind,
      sessionId: this.sessionId,
      agentId: this.currentAgentId ?? undefined,
      agentOrigin: this.currentAgentOrigin ?? undefined,
      surface: this.surface,
      platform: process.platform,
      version: getVersion(),
    });
  }

  /** Agent ID is automatically added to user input from currentAgentId. */
  trackUserInput(input: string, messageType: string, modelId: string) {
    this.messageCount++;

    const isCommand = input.trim().startsWith("/");
    const commandName = isCommand ? input.trim().split(/\s+/)[0] : undefined;

    const data: UserInputData = {
      input_length: input.length,
      is_command: isCommand,
      command_name: commandName,
      message_type: messageType,
      model_id: modelId,
      channel: extractInputChannel(input),
    };
    this.track("user_input", data);
  }

  /**
   * Track reflection start events (manual and auto-triggered).
   */
  trackReflectionStart(
    triggerSource: ReflectionTriggerSource,
    options?: {
      subagentId?: string;
      conversationId?: string;
      startMessageId?: string;
      endMessageId?: string;
      model?: string | null;
    },
  ) {
    const data: ReflectionStartData = {
      trigger_source: triggerSource,
      subagent_id: options?.subagentId,
      conversation_id: options?.conversationId,
      start_message_id: options?.startMessageId,
      end_message_id: options?.endMessageId,
      model: options?.model ?? undefined,
      version: getVersion(),
      platform: process.platform,
    };
    this.track("reflection_start", data);
  }

  /**
   * Track reflection completion events.
   */
  trackReflectionEnd(
    triggerSource: ReflectionTriggerSource,
    success: boolean,
    options?: {
      subagentId?: string;
      conversationId?: string;
      error?: string;
      stepCount?: number;
      durationMs?: number;
      model?: string | null;
    },
  ) {
    const data: ReflectionEndData = {
      trigger_source: triggerSource,
      success,
      subagent_id: options?.subagentId,
      conversation_id: options?.conversationId,
      error: options?.error,
      step_count: options?.stepCount,
      duration_ms: options?.durationMs,
      model: options?.model ?? undefined,
      version: getVersion(),
      platform: process.platform,
    };
    this.track("reflection_end", data);
  }

  trackReflectionWorktreeCleanup(
    options: Omit<ReflectionWorktreeCleanupData, "version" | "platform">,
  ) {
    const data: ReflectionWorktreeCleanupData = {
      ...options,
      version: getVersion(),
      platform: process.platform,
    };
    this.track("reflection_worktree_cleanup", data);
  }

  trackReflectionArenaVote(
    vote: Omit<ReflectionArenaVoteData, "version" | "platform">,
  ) {
    this.track("reflection_arena_vote", {
      ...vote,
      version: getVersion(),
      platform: process.platform,
    });
  }

  /**
   * No-op: there is no queue and no transport left. Boundary errors are written
   * synchronously by trackError, so shutdown has nothing to flush. The method
   * stays because ~10 call sites await it on exit paths.
   */
  flush(): Promise<void> {
    return Promise.resolve();
  }

  /** No-op counterpart to flush(), retained for shutdown call sites. */
  drain(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Clean up resources
   */
  cleanup() {
    this.removeFatalErrorHandlers?.();
    this.removeFatalErrorHandlers = null;
    this.initialized = false;
  }
}

// Export singleton instance
export const telemetry = new TelemetryManager();
