/**
 * The writes that rewrite a conversation's in-context list — replacing history
 * with a summary, and appending topic markers.
 *
 * `LocalStore` owns the resident window, the transcript files, and the message
 * index. This module owns the *order* those are touched in, which is the part
 * that is easy to get wrong: a rewrite must publish the transcript row, the
 * in-context id list, and the resident window together, or a reader can observe
 * a summary that nothing points at. It runs against a narrow port object rather
 * than the store so the sequencing can be read (and later tested) on its own,
 * and because both sliding-window compaction and a user-picked topic trim must
 * share exactly one write path.
 */
import { appendFileSync } from "node:fs";
import type { LocalCompactionStats } from "./compaction";
import type { LocalMessage } from "./local-message";
import { cloneLocalMessage } from "./local-message-projection";
import type { LocalTranscriptTopicEntry } from "./local-transcript";
import { timestampFromIso } from "./local-transcript";
import { readLocalTranscriptTopicEntries } from "./local-transcript-topics";
import type { StoredConversation } from "./local-types";
import {
  type LocalTopicMarker,
  userTurnsSinceLastTopicMarker,
} from "./topic-compaction";

export interface LocalCompactionStoreResult {
  numMessagesBefore: number;
  numMessagesAfter: number;
  summaryMessage: LocalMessage;
}

export interface LocalConversationRewriteInput {
  conversationId: string;
  agentId: string;
  /** Raw summary text recorded on the summary message's compaction metadata. */
  summary: string;
  /** Packed summary content the model will read. */
  packedSummary: string;
  stats?: LocalCompactionStats;
  /** Messages kept after the summary, in order. */
  remainingMessages?: LocalMessage[];
}

export interface LocalTopicMarkerAppendInput {
  conversationId: string;
  agentId: string;
  title: string;
  summary?: string;
  createdBy: "agent" | "user";
}

export interface LocalTopicMarkerAppendResult {
  marker: LocalTopicMarker;
  /** Transcript entry id, for receipts and follow-up lookups. */
  entryId: string;
  /** User turns since the previous marker, as of this write. */
  turnsSincePrevious: number;
  /** In-context messages at write time (`0` means there was no anchor). */
  contextMessageCount: number;
}

/** Transcript persistence options shared with `LocalStore`. */
export interface LocalTranscriptPersistOptions {
  transcript?: "append" | "append-compaction" | "rewrite" | "skip";
  message?: LocalMessage;
  compaction?: {
    summaryMessage: LocalMessage;
    summary: string;
    firstKeptMessageId?: string;
    previousMessages?: readonly LocalMessage[];
    stats?: LocalCompactionStats;
  };
}

/**
 * Everything the rewrite path needs from the store. Each member maps to one
 * store responsibility so the sequencing below stays readable.
 */
export interface LocalContextRewritePorts {
  ensureConversation(
    conversationId: string,
    agentId: string,
  ): StoredConversation;
  conversationKey(conversationId: string, agentId: string): string;
  /** `undefined` for an in-memory store with no transcript to write. */
  conversationMessagesPath(key: string): string | undefined;
  /** Load (and validate) the resident window before it is replaced. */
  ensureResidentMessages(conversationId: string, agentId: string): void;
  inContextMessages(
    conversationId: string,
    agentId: string,
  ): readonly LocalMessage[];
  validateUnreadTranscriptHead(key: string): void;
  nextLocalMessageId(): string;
  currentLocalMessageDate(): string;
  setResidentMessages(key: string, messages: LocalMessage[]): void;
  saveConversation(key: string, conversation: StoredConversation): void;
  persistConversation(
    conversationId: string,
    agentId: string,
    options: LocalTranscriptPersistOptions,
  ): void;
  rebuildMessageIndex(): void;
  now(): string;
  ensureTranscriptHeader(
    conversation: StoredConversation,
    messagesPath: string,
  ): void;
  nextSessionEntryId(key: string): string;
  lastSessionEntryId(key: string): string | null;
  recordSessionEntryId(key: string, entryId: string): void;
}

export class LocalContextRewrites {
  constructor(private readonly ports: LocalContextRewritePorts) {}

  /**
   * Every topic marker in the conversation transcript, oldest first.
   *
   * Reads the transcript file rather than the resident window on purpose: a
   * trim keeps every marker, so a marker can sit far before the window. Callers
   * are user commands and trim execution, never the per-turn request path.
   * Damaged rows are skipped.
   */
  readTopicMarkers(
    conversationId: string,
    agentId: string,
  ): LocalTopicMarker[] {
    const conversation = this.ports.ensureConversation(conversationId, agentId);
    const messagesPath = this.ports.conversationMessagesPath(
      this.ports.conversationKey(conversation.id, agentId),
    );
    if (!messagesPath) return [];
    return readLocalTranscriptTopicEntries(messagesPath).map((entry) => ({
      id: entry.id,
      title: entry.title,
      createdBy: entry.createdBy,
      anchorMessageId: entry.anchorMessageId,
      createdAt: entry.timestamp,
    }));
  }

  /**
   * Append a topic marker to the transcript. Markers are metadata: the context,
   * the in-context id list, and the message index are untouched, so a marker
   * never disturbs the frozen request prefix.
   *
   * The anchor is the newest in-context message at write time. An empty context
   * yields a `null` anchor (and `contextMessageCount: 0`), which callers treat
   * as "cannot mark here".
   */
  appendTopicMarker(
    input: LocalTopicMarkerAppendInput,
  ): LocalTopicMarkerAppendResult {
    const conversation = this.ports.ensureConversation(
      input.conversationId,
      input.agentId,
    );
    const key = this.ports.conversationKey(conversation.id, input.agentId);
    const messagesPath = this.ports.conversationMessagesPath(key);
    if (!messagesPath) {
      throw new Error(
        "Topic markers need a local storage directory to append to a transcript.",
      );
    }
    const messages = this.ports.inContextMessages(
      conversation.id,
      input.agentId,
    );
    const existing = this.readTopicMarkers(conversation.id, input.agentId);
    const anchorMessageId = messages.at(-1)?.id ?? null;
    const turnsSincePrevious = userTurnsSinceLastTopicMarker(
      messages,
      existing,
    );
    const timestamp = this.ports.now();
    const entry: LocalTranscriptTopicEntry = {
      type: "topic",
      id: this.ports.nextSessionEntryId(key),
      parentId: this.ports.lastSessionEntryId(key),
      timestamp,
      title: input.title,
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      createdBy: input.createdBy,
      anchorMessageId,
      turnsSincePrevious,
    };
    this.appendTopicEntry(conversation, key, messagesPath, entry);
    return {
      marker: {
        id: entry.id,
        title: entry.title,
        createdBy: entry.createdBy,
        anchorMessageId,
        createdAt: timestamp,
      },
      entryId: entry.id,
      turnsSincePrevious,
      contextMessageCount: messages.length,
    };
  }

  /**
   * Replace a conversation's in-context list with `[summary, ...remaining]` and
   * append the matching `compaction` entry to the transcript.
   *
   * This is the single write path for "history became a summary": both the
   * sliding-window compaction and a user-picked topic trim go through it, so the
   * transcript, the resident window, and the message index can only be mutated
   * one way.
   */
  rewriteInContext(
    input: LocalConversationRewriteInput,
  ): LocalCompactionStoreResult {
    const conversation = this.ports.ensureConversation(
      input.conversationId,
      input.agentId,
    );
    const key = this.ports.conversationKey(conversation.id, input.agentId);
    // Ensure the resident tail first; validate its unread head pre-rewrite.
    this.ports.ensureResidentMessages(conversation.id, input.agentId);
    this.ports.validateUnreadTranscriptHead(key);
    const previousMessages = this.ports.inContextMessages(
      conversation.id,
      input.agentId,
    );
    const date = this.ports.currentLocalMessageDate();
    const summaryMessage: LocalMessage = {
      id: this.ports.nextLocalMessageId(),
      role: "user",
      metadata: {
        created_at: date,
        updated_at: date,
        agent_id: input.agentId,
        conversation_id: conversation.id,
        compaction: {
          summary: input.summary,
          ...(input.stats ? { stats: input.stats } : {}),
        },
      },
      content: [{ type: "text", text: input.packedSummary }],
      timestamp: timestampFromIso(date),
    };
    const compactedMessages = [
      summaryMessage,
      ...(input.remainingMessages ?? []).map(cloneLocalMessage),
    ];
    conversation.in_context_message_ids = compactedMessages.map(
      (message) => message.id,
    );
    this.ports.setResidentMessages(key, compactedMessages);
    conversation.last_message_at = date;
    conversation.updated_at = date;
    this.ports.saveConversation(key, conversation);
    this.ports.persistConversation(conversation.id, input.agentId, {
      transcript: "append-compaction",
      compaction: {
        summaryMessage,
        summary: input.summary,
        firstKeptMessageId: input.remainingMessages?.[0]?.id,
        previousMessages,
        ...(input.stats ? { stats: input.stats } : {}),
      },
    });
    this.ports.rebuildMessageIndex();
    return {
      numMessagesBefore: previousMessages.length,
      numMessagesAfter: compactedMessages.length,
      summaryMessage: cloneLocalMessage(summaryMessage),
    };
  }

  /**
   * Append a `topic` row. Unlike message and compaction rows it carries no
   * `message`, so it only joins the entry-id and parent-chain bookkeeping —
   * never the message-id maps or the persisted message snapshots. That is what
   * keeps markers out of every content reader.
   */
  private appendTopicEntry(
    conversation: StoredConversation,
    key: string,
    messagesPath: string,
    entry: LocalTranscriptTopicEntry,
  ): void {
    this.ports.ensureTranscriptHeader(conversation, messagesPath);
    this.ports.validateUnreadTranscriptHead(key);
    appendFileSync(messagesPath, `${JSON.stringify(entry)}\n`);
    this.ports.recordSessionEntryId(key, entry.id);
  }
}
