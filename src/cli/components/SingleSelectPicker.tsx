// Reusable single-select vertical list picker.
//
// Renders a vertical list with cursor navigation (↑↓),
// Enter to confirm, Escape to cancel.
// Items are identified by key (string), not index.

import { Box, type Key, useInput } from "ink";
import {
  memo,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import { colors } from "./colors";
import { Text } from "./Text";

export interface SelectableItem {
  key: string;
  label: string;
  description?: string;
  /** When true, shows "(current)" marker and uses `colors.selector.itemCurrent` */
  isCurrent?: boolean;
  /** When true, item is dimmed and Enter is a no-op */
  disabled?: boolean;
  /** When true, label renders dimmed but item is still selectable */
  dimLabel?: boolean;
}

export interface SingleSelectPickerProps {
  items: SelectableItem[];
  /** Start cursor at this index (default 0) */
  initialCursorIndex?: number;
  /** Called when user presses Enter on an item */
  onSelect: (key: string) => void;
  /** Called when user presses Escape or Ctrl-C */
  onCancel: () => void;
  /**
   * Override item rendering. When provided, the picker uses this
   * instead of its default label + description rendering.
   * The picker still handles cursor state and input. Return `null` for
   * nothing — a raw string would be rendered outside `<Text>`, which Ink
   * rejects, so the type does not allow one.
   */
  renderItem?: (
    item: SelectableItem,
    index: number,
    isSelected: boolean,
  ) => ReactElement | null;
  /**
   * Called for keys the picker doesn't handle itself
   * (anything that isn't ↑↓/Enter/Escape/Ctrl-C).
   * Useful for pagination (←→), shortcuts (N), etc.
   */
  onUnhandledKey?: (input: string, key: Key) => void;
  /**
   * Override the footer content. When provided, replaces the default
   * "Enter select · ↑↓/jk navigate · Esc cancel" hint. A plain string is
   * wrapped in `<Text>` for you — Ink rejects a string child inside `<Box>`,
   * so passing one raw would crash the whole overlay.
   */
  footer?: ReactNode;
}

/**
 * Ink only accepts text that sits inside `<Text>`, but `footer` is a
 * `ReactNode`: a caller handing the hint over as a plain string (TopicSelector
 * does) would otherwise throw during commit. `null`/`undefined` means "use the
 * default hint". The return type is what keeps this site safe — everything
 * leaves here as an element.
 */
function resolvePickerFooter(footer: ReactNode): ReactElement {
  if (footer == null) {
    return <Text dimColor> Enter select · ↑↓/jk navigate · Esc cancel</Text>;
  }
  if (typeof footer === "string" || typeof footer === "number") {
    return <Text dimColor>{footer}</Text>;
  }
  // Anything else (element, array of them, conditional `false`) renders as it
  // would have; the fragment keeps the return type an element.
  return <>{footer}</>;
}

export const SingleSelectPicker = memo(function SingleSelectPicker({
  items,
  initialCursorIndex = 0,
  onSelect,
  onCancel,
  renderItem,
  onUnhandledKey,
  footer,
}: SingleSelectPickerProps) {
  const [cursor, setCursor] = useState(initialCursorIndex);

  // Clamp cursor when items change
  useEffect(() => {
    if (items.length === 0) return;
    setCursor((c) => Math.min(c, items.length - 1));
  }, [items.length]);

  const handleInput = useCallback(
    (input: string, key: Key) => {
      if (key.ctrl && input === "c") {
        onCancel();
        return;
      }
      // Up: arrow or vim-style "k"
      if (key.upArrow || input === "k") {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      // Down: arrow or vim-style "j"
      if (key.downArrow || input === "j") {
        setCursor((c) => Math.min(items.length - 1, c + 1));
        return;
      }
      if (key.return) {
        const item = items[cursor];
        if (item && !item.disabled) {
          onSelect(item.key);
        }
        return;
      }
      if (key.escape) {
        onCancel();
        return;
      }
      // Pass unhandled keys to the wrapper
      if (onUnhandledKey) {
        onUnhandledKey(input, key);
      }
    },
    [items, cursor, onCancel, onSelect, onUnhandledKey],
  );

  useInput(handleInput, { isActive: true });

  return (
    <Box flexDirection="column">
      {items.map((item, index) => {
        const isCursor = index === cursor;

        if (renderItem) {
          return <Box key={item.key}>{renderItem(item, index, isCursor)}</Box>;
        }

        const isCurrent = item.isCurrent ?? false;
        const isDisabled = item.disabled ?? false;
        const isDimLabel = item.dimLabel ?? false;

        const cursorColor = isDisabled
          ? undefined
          : isCursor
            ? colors.selector.itemHighlighted
            : undefined;
        const labelColor = isDisabled
          ? undefined
          : isCursor
            ? colors.selector.itemHighlighted
            : isCurrent
              ? colors.selector.itemCurrent
              : undefined;

        return (
          <Box key={item.key} flexDirection="row">
            <Text color={cursorColor}>{isCursor ? "> " : "  "}</Text>
            <Text
              color={labelColor}
              bold={isCursor && !isDisabled}
              dimColor={isDisabled || isDimLabel}
            >
              {item.label}
              {isCurrent && " (current)"}
            </Text>
            {item.description && (
              <Text dimColor>{` · ${item.description}`}</Text>
            )}
          </Box>
        );
      })}

      {/* Footer */}
      <Box marginTop={footer == null ? 1 : 0}>
        {resolvePickerFooter(footer)}
      </Box>
    </Box>
  );
});
