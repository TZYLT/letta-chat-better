/**
 * Runtime identity for all state and delta events.
 *
 * This is the address of a conversation: which agent, and which conversation
 * within it.
 *
 * `acting_user_id` remains part of the wire structure so older peers can still
 * send it, but nothing on this side produces, forwards, or reads it: there is
 * no outbound HTTP call left to attribute, and the listener does not track a
 * per-frame caller identity.
 */
export interface RuntimeScope<AgentId extends string | null = string> {
  agent_id: AgentId;
  conversation_id: string;
  acting_user_id?: string;
}

export type AgentRuntimeScope = RuntimeScope<string>;
export type ConversationRuntimeScope = RuntimeScope<string | null>;
