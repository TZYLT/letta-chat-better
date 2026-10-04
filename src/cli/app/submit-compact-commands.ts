/**
 * `/compact` (feature ③ D-110 + D-119): the one interactive entry point that may
 * rewrite a conversation's context.
 *
 * Local compaction asks the user where to cut: `/compact <n>` keeps block `n`,
 * and a bare `/compact` opens the topic picker —except when nothing has been
 * marked, in which case the retention ratio decides and the command runs
 * straight away (D-119). The cloud backend keeps its mode-based behaviour, so
 * the mode words still work there and are rejected here by name.
 *
 * The branch lives in its own module because the submit handler is on the size
 * ratchet and because this is a whole flow, not a line of dispatch: the picker
 * handoff, the receipt, and the bookkeeping a compaction owes the reflection
 * runtime all belong together.
 */
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { isActiveMemfsEnabled } from "@/agent/memory-runtime";
import { getBackend } from "@/backend";
import { LocalBackend } from "@/backend/local/local-backend";
import type { LocalTopicTrimPick } from "@/backend/local/local-topic-trim";
import type { ActiveOverlay, AppCommandRunner } from "@/cli/app/types";
import type { CompactModeArgument } from "@/cli/helpers/compact-command";
import {
  COMPACT_COMMAND_USAGE,
  COMPACT_MODE_LOCAL_UNSUPPORTED,
  formatCompactPlanningFailure,
  formatNoMarkerCompactHint,
  formatTopicTrimReceipt,
  parseCompactCommandArgs,
} from "@/cli/helpers/compact-command";
import { getReflectionSettings } from "@/cli/helpers/memory-reminder";
import {
  buildReflectionArenaChoiceQuestions,
  REFLECTION_ARENA_MODEL_A_DEFAULT,
  type ReflectionArenaChoiceQuestion,
  sampleReflectionArenaComparisonModel,
} from "@/cli/helpers/reflection-arena";
import { launchReflectionArena } from "@/cli/helpers/reflection-arena-launcher";
import {
  AUTO_REFLECTION_DESCRIPTION,
  launchReflectionSubagent,
} from "@/cli/helpers/reflection-launcher";
import {
  clearTopicTrimRequest,
  setTopicTrimRequest,
} from "@/cli/helpers/topic-trim-request";
import { DEFAULT_SUMMARIZATION_MODEL } from "@/constants";
import { experimentManager } from "@/experiments/manager";
import { runPreCompactHooks } from "@/hooks";
import {
  markPostCompactionContextRemindersPending,
  type SharedReminderState,
} from "@/reminders/state";
import { shouldIncludeTopicMarking } from "@/settings-tool-gates";
import { debugLog } from "@/utils/debug";

export interface CompactCommandContext {
  agentDescription: string | null;
  agentId: string;
  agentName: string | null;
  agentStateRef: MutableRefObject<AgentState | null | undefined>;
  appendTaskNotificationEvents: (summaries: string[]) => boolean;
  commandRunner: AppCommandRunner;
  conversationIdRef: MutableRefObject<string>;
  generateConversationDescription: (options?: {
    force?: boolean;
  }) => Promise<void>;
  setActiveOverlay: Dispatch<SetStateAction<ActiveOverlay>>;
  setCommandRunning: (value: boolean) => void;
  setReflectionArenaChoicePending: Dispatch<
    SetStateAction<{
      questions: ReflectionArenaChoiceQuestion[];
      runId: string;
    } | null>
  >;
  sharedReminderStateRef: MutableRefObject<SharedReminderState>;
}

/**
 * Does this message belong to `/compact`? The command is intercepted before the
 * registry so the TUI can own the selector; every other channel still reaches
 * the registry entry. `/compaction` (mode settings) must not match.
 */
export function isCompactCommand(message: string): boolean {
  return /^\/compact(\s|$)/.test(message.trim());
}

function fail(
  ctx: CompactCommandContext,
  input: string,
  message: string,
): { submitted: boolean } {
  const cmd = ctx.commandRunner.start(input, message);
  cmd.fail(message);
  return { submitted: true };
}

/**
 * The cloud path (and the local one before this feature): summarize by the
 * configured strategy. Local compaction keeps sliding-window as its only mode,
 * so a mode argument is refused there by name rather than silently ignored.
 */
async function compactByMode(
  ctx: CompactCommandContext,
  input: string,
  mode: CompactModeArgument | undefined,
): Promise<{ submitted: boolean }> {
  const modeDisplay = mode ? ` (mode: ${mode})` : "";
  const cmd = ctx.commandRunner.start(
    input,
    `Compacting conversation history${modeDisplay}...`,
  );
  ctx.setCommandRunning(true);
  try {
    const preCompact = await runPreCompactHooks(
      undefined, // context_length - not available here
      undefined, // max_context_length - not available here
      ctx.agentId,
      ctx.conversationIdRef.current,
    );
    if (preCompact.blocked) {
      const feedback = preCompact.feedback.join("\n") || "Blocked by hook";
      cmd.fail(`Compact blocked: ${feedback}`);
      return { submitted: true };
    }

    const compactParams = mode
      ? {
          compaction_settings: {
            mode,
            model:
              ctx.agentStateRef.current?.compaction_settings?.model?.trim() ||
              DEFAULT_SUMMARIZATION_MODEL,
          },
        }
      : undefined;
    const conversationId = ctx.conversationIdRef.current;
    const body =
      conversationId === "default"
        ? { agent_id: ctx.agentId, ...(compactParams ?? {}) }
        : compactParams;
    const result = await getBackend().compactConversationMessages(
      conversationId,
      body,
    );
    await afterCompaction(ctx, conversationId);
    cmd.finish(
      [
        `Compaction completed${modeDisplay}. Message buffer length reduced from ${result.num_messages_before} to ${result.num_messages_after}.`,
        "",
        `Summary: ${result.summary}`,
      ].join("\n"),
      true,
    );
  } catch (error) {
    const apiError = error as {
      status?: number;
      error?: { detail?: string };
    };
    const detail = apiError?.error?.detail;
    if (
      apiError?.status === 400 &&
      detail?.includes("Summarization failed to reduce the number of messages")
    ) {
      cmd.finish(
        "Compaction run, but the number of messages is the same",
        true,
      );
      return { submitted: true };
    }
    cmd.fail(`Failed: ${formatCompactPlanningFailure(error)}`);
  } finally {
    ctx.setCommandRunning(false);
  }
  return { submitted: true };
}

/**
 * Everything a succeeded compaction owes the rest of the runtime: the reminder
 * that the context changed, the reflection trigger, and a fresh conversation
 * description. All best-effort —a failure here must not undo the trim.
 */
async function afterCompaction(
  ctx: CompactCommandContext,
  conversationId: string,
): Promise<void> {
  markPostCompactionContextRemindersPending(ctx.sharedReminderStateRef.current);
  try {
    if (
      getReflectionSettings(ctx.agentId).trigger === "compaction-event" &&
      isActiveMemfsEnabled(ctx.agentId)
    ) {
      const feedbackContext = {
        parentAgentName: ctx.agentName,
        parentAgentDescription: ctx.agentDescription,
        surface: "letta_code_tui",
      };
      if (experimentManager.isEnabled("reflection_arena")) {
        void launchReflectionArena({
          agentId: ctx.agentId,
          conversationId,
          triggerSource: "compaction-event",
          models: [
            REFLECTION_ARENA_MODEL_A_DEFAULT,
            sampleReflectionArenaComparisonModel(),
          ],
          feedbackContext,
          onReady: (message, readyRun) => {
            ctx.appendTaskNotificationEvents([message]);
            ctx.setReflectionArenaChoicePending({
              runId: readyRun.runId,
              questions: buildReflectionArenaChoiceQuestions(readyRun.runId),
            });
          },
        }).catch((reflectionError) => {
          debugLog(
            "memory",
            "Skipping post-compaction reflection arena:",
            reflectionError instanceof Error
              ? reflectionError.message
              : String(reflectionError),
          );
        });
      } else {
        void launchReflectionSubagent({
          agentId: ctx.agentId,
          conversationId,
          memfsEnabled: isActiveMemfsEnabled(ctx.agentId),
          triggerSource: "compaction-event",
          description: AUTO_REFLECTION_DESCRIPTION,
          completionConversationId: () => ctx.conversationIdRef.current,
          onCompletionMessage: (completionMessage) => {
            ctx.appendTaskNotificationEvents([completionMessage]);
          },
          feedbackContext,
        });
      }
    }
  } catch (reflectionError) {
    debugLog(
      "memory",
      "Skipping post-compaction reflection:",
      reflectionError instanceof Error
        ? reflectionError.message
        : String(reflectionError),
    );
  }
  void ctx.generateConversationDescription({ force: true });
}

/**
 * Run a trim and report it. A refusal is a result, not a failure: the plan said
 * there is nothing to cut, so the command succeeds with the reason.
 */
async function runTrim(
  ctx: CompactCommandContext,
  input: string,
  pick: LocalTopicTrimPick,
  backend: LocalBackend,
  extraNote?: string,
): Promise<{ submitted: boolean }> {
  const conversationId = ctx.conversationIdRef.current;
  const cmd = ctx.commandRunner.start(input, "Trimming context...");
  ctx.setCommandRunning(true);
  try {
    const preCompact = await runPreCompactHooks(
      undefined,
      undefined,
      ctx.agentId,
      conversationId,
    );
    if (preCompact.blocked) {
      const feedback = preCompact.feedback.join("\n") || "Blocked by hook";
      cmd.fail(`Compact blocked: ${feedback}`);
      return { submitted: true };
    }

    const outcome = await backend.trimConversationToTopic({
      conversationId,
      agentId: ctx.agentId,
      pick,
    });
    const receipt = formatTopicTrimReceipt(outcome);
    if (!outcome.executed) {
      cmd.finish(receipt, true);
      return { submitted: true };
    }
    cmd.finish(extraNote ? `${receipt}\n\n${extraNote}` : receipt, true);
    await afterCompaction(ctx, conversationId);
  } catch (error) {
    cmd.fail(`Failed: ${formatCompactPlanningFailure(error)}`);
  } finally {
    ctx.setCommandRunning(false);
  }
  return { submitted: true };
}

/**
 * Local `/compact`: pick a cut point from the topic blocks, or let the ratio
 * decide when nothing is marked.
 */
async function compactLocal(
  ctx: CompactCommandContext,
  input: string,
  request: { kind: "auto" } | { kind: "block"; index: number },
  backend: LocalBackend,
): Promise<{ submitted: boolean }> {
  const conversationId = ctx.conversationIdRef.current;
  const list = backend.listTopics(conversationId, ctx.agentId);
  if (list.contextMessageCount === 0) {
    return fail(
      ctx,
      input,
      "There is nothing in this conversation's context to trim.",
    );
  }

  if (request.kind === "block") {
    if (request.index > list.blocks.length) {
      return fail(
        ctx,
        input,
        `There is no topic block ${request.index}. Run /topics to list the blocks.`,
      );
    }
    return runTrim(
      ctx,
      input,
      { kind: "topic", index: request.index },
      backend,
    );
  }

  if (list.markers.length > 0) {
    // Hand the picker its rows and keep the trim in this environment: only the
    // submit handler knows how to finish the compaction bookkeeping.
    setTopicTrimRequest({
      blocks: list.blocks,
      suggestionIndex: list.suggestedBlockIndex ?? 1,
      onPick: (blockIndex) => {
        ctx.setActiveOverlay(null);
        void runTrim(
          ctx,
          `/compact ${blockIndex}`,
          { kind: "topic", index: blockIndex },
          backend,
        );
      },
    });
    ctx.setActiveOverlay("compaction");
    return { submitted: true };
  }

  // D-119: no markers means one block, so the ratio decides instead of asking.
  clearTopicTrimRequest();
  return runTrim(
    ctx,
    input,
    { kind: "ratio_suggestion" },
    backend,
    formatNoMarkerCompactHint(shouldIncludeTopicMarking()),
  );
}

export async function handleCompactCommand(
  msg: string,
  ctx: CompactCommandContext,
): Promise<{ submitted: boolean }> {
  const input = msg.trim();
  const request = parseCompactCommandArgs(input.split(/\s+/).slice(1));
  const backend = getBackend();

  if (request.kind === "help") {
    const cmd = ctx.commandRunner.start(input, "Showing compact help...");
    cmd.finish(COMPACT_COMMAND_USAGE, true);
    return { submitted: true };
  }
  if (request.kind === "invalid") {
    const cmd = ctx.commandRunner.start(input, "Invalid /compact arguments.");
    cmd.fail(`${request.message}\n\n${COMPACT_COMMAND_USAGE}`);
    return { submitted: true };
  }

  if (!(backend instanceof LocalBackend)) {
    // Cloud behaviour is unchanged: no topic blocks, no picker, mode words kept.
    if (request.kind === "block") {
      return fail(
        ctx,
        input,
        "Picking a context cut point by number requires the local backend. Run /compact help.",
      );
    }
    return compactByMode(
      ctx,
      input,
      request.kind === "mode" ? request.mode : undefined,
    );
  }

  if (request.kind === "mode") {
    return fail(ctx, input, COMPACT_MODE_LOCAL_UNSUPPORTED);
  }
  clearTopicTrimRequest();
  return compactLocal(ctx, input, request, backend);
}
