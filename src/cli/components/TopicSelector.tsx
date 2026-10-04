/**
 * The topic picker (D-111): the overlay `/compact` opens when a conversation has
 * markers to choose between.
 *
 * Rows are built by a pure function so the copy, the ordering, and the cursor
 * default are testable without rendering Ink. The trailing row is always
 * "Cancel", and the first block is shown disabled because keeping everything
 * means there is nothing to trim. The row copy itself comes from
 * `helpers/topic-list.ts` so the picker and `/topics` describe a boundary the
 * same way.
 */
import { memo, useCallback, useMemo, useRef } from "react";
import type { TopicBlock } from "@/backend/local/topic-compaction";
import {
  CURRENT_TOPIC_LABEL,
  shortTimestamp,
  topicBlockBoundaryNote,
} from "@/cli/helpers/topic-list";
import type { TopicTrimRequest } from "@/cli/helpers/topic-trim-request";
import { OverlayShell } from "./OverlayShell";
import { type SelectableItem, SingleSelectPicker } from "./SingleSelectPicker";

export const TOPIC_TRIM_CANCEL_KEY = "cancel";

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
  // One shot: the overlay unmounts on the first outcome, but a burst of Enter
  // keys inside one tick could otherwise run the handler twice — two trims, or a
  // trim after a cancel. A ref keeps it out of the render path.
  const settledRef = useRef(false);
  const settle = useCallback((action: () => void) => {
    if (settledRef.current) return;
    settledRef.current = true;
    action();
  }, []);
  // Dismissing means different things to the two flows that open this picker:
  // nothing for `/compact`, "send the message anyway" for the pre-send offer.
  const dismiss = useCallback(() => {
    settle(() => {
      request.onCancel?.();
      onCancel();
    });
  }, [settle, request, onCancel]);

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
          settle(() => request.onPick(Number(key)));
        }}
        onCancel={dismiss}
        footer=" Enter trim · ↑↓/jk navigate · Esc cancel"
      />
    </OverlayShell>
  );
});
