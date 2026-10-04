/**
 * The topic picker (D-111): the overlay `/compact` opens when a conversation has
 * markers to choose between.
 *
 * Rows are built by a pure function so the copy, the ordering, and the cursor
 * default are testable without rendering Ink. The trailing row is always
 * "Cancel", and the first block is shown disabled because keeping everything
 * means there is nothing to trim.
 */
import { memo, useCallback, useMemo } from "react";
import type { TopicBlock } from "@/backend/local/topic-compaction";
import type { TopicTrimRequest } from "@/cli/helpers/topic-trim-request";
import { OverlayShell } from "./OverlayShell";
import { type SelectableItem, SingleSelectPicker } from "./SingleSelectPicker";

export const TOPIC_TRIM_CANCEL_KEY = "cancel";

const CURRENT_TOPIC_LABEL = "Current topic (not marked finished)";

function shortTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toISOString().slice(0, 16).replace("T", " ");
}

/** How a block's first message was chosen, in the picker's words. */
export function topicBlockBoundaryNote(
  block: TopicBlock,
  previous: TopicBlock | undefined,
): string {
  if (block.index === 1) return "the start of the context";
  const previousTitle = previous?.title ?? CURRENT_TOPIC_LABEL;
  const rewound =
    block.rewindTurns === 0
      ? "no rewind"
      : `rewound ${block.rewindTurns} user turn${block.rewindTurns === 1 ? "" : "s"}`;
  return `marker "${previousTitle}" ${rewound}`;
}

/**
 * The picker rows, oldest block first. Block 1 is visible but not selectable:
 * keeping the whole context is the no-op case, and `/compact 1` still reports it
 * explicitly for scripted channels.
 */
export function buildTopicPickRows(
  blocks: readonly TopicBlock[],
): SelectableItem[] {
  return blocks.map((block, position) => ({
    key: String(block.index),
    label: `${block.index}. ${block.title ?? CURRENT_TOPIC_LABEL}`,
    description: `${block.messageCount} messages · ~${block.tokens} tokens · from ${shortTimestamp(block.startsAt)} · ${topicBlockBoundaryNote(block, blocks[position - 1])}`,
    disabled: block.index === 1,
  }));
}

/** The full item list, cancel last. */
export function buildTopicPickItems(
  blocks: readonly TopicBlock[],
): SelectableItem[] {
  return [
    ...buildTopicPickRows(blocks),
    {
      key: TOPIC_TRIM_CANCEL_KEY,
      label: "Cancel",
      description: "keep the context as it is",
    },
  ];
}

/**
 * Cursor default: the suggested block, falling back to the oldest selectable
 * block when the suggestion is the un-selectable first one.
 */
export function initialTopicPickIndex(
  items: readonly SelectableItem[],
  suggestionIndex: number,
): number {
  const suggested = items.findIndex(
    (item) => item.key === String(suggestionIndex) && !item.disabled,
  );
  if (suggested >= 0) return suggested;
  const firstSelectable = items.findIndex((item) => !item.disabled);
  return firstSelectable >= 0 ? firstSelectable : items.length - 1;
}

interface TopicSelectorProps {
  request: TopicTrimRequest;
  onCancel: () => void;
}

export const TopicSelector = memo(function TopicSelector({
  request,
  onCancel,
}: TopicSelectorProps) {
  const items = useMemo(() => buildTopicPickItems(request.blocks), [request]);
  const initialCursorIndex = useMemo(
    () => initialTopicPickIndex(items, request.suggestionIndex),
    [items, request.suggestionIndex],
  );
  // Dismissing means different things to the two flows that open this picker:
  // nothing for `/compact`, "send the message anyway" for the pre-send offer.
  const dismiss = useCallback(() => {
    request.onCancel?.();
    onCancel();
  }, [request, onCancel]);

  return (
    <OverlayShell command="/compact" title="Choose the topic block to keep">
      <SingleSelectPicker
        items={items}
        initialCursorIndex={initialCursorIndex}
        onSelect={(key) => {
          if (key === TOPIC_TRIM_CANCEL_KEY) {
            dismiss();
            return;
          }
          request.onPick(Number(key));
        }}
        onCancel={dismiss}
        footer=" Enter trim · ↑↓/jk navigate · Esc cancel"
      />
    </OverlayShell>
  );
});
