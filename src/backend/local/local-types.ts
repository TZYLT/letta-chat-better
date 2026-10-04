/**
 * Shared types for the local backend — extracted here to avoid circular
 * imports between LocalStore, LocalMessageProjection, compaction, and
 * systemPromptCompilation.
 */
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";

export type StoredMessage = Message & {
  id: string;
  message_type: string;
  date: string;
  content?: unknown;
  agent_id: string;
  conversation_id: string;
};

export interface LocalAgentRecord {
  id: string;
  name: string;
  description?: string | null;
  system: string;
  tags: string[];
  model: string;
  model_settings: Record<string, unknown>;
  hidden?: boolean | null;
  compaction_settings?: Record<string, unknown> | null;
}

export type StoredConversation = Conversation & {
  id: string;
  agent_id: string;
  in_context_message_ids: string[];
  hidden?: boolean;
  tags?: string[];
  /** Complete immutable system snapshot for an agent-free conversation. */
  system?: string;
  parent_agent_id?: string | null;
  is_subagent?: boolean;
  name?: string;
  /** Internal marker; public projections expose this ownership as null. */
  agent_free?: boolean;
  /**
   * Conversation-level small state for feature ③ (§2.2). Only the one-shot
   * nudge flag lives here: everything else about the topic channel is derived
   * from the messages and the transcript markers, so there is no second source
   * of truth to keep in sync.
   */
  context_management?: LocalConversationContextManagement;
};

export interface LocalConversationContextManagement {
  /** True once the no-marker nudge went out for the current streak. */
  nudge_sent_for_streak?: boolean;
}
