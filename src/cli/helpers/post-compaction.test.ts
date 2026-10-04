/**
 * The shared post-compaction tail (L-18): ordering and failure policy.
 *
 * The point of the module is that both `/compact` surfaces run the *same* three
 * steps in the same order, and that a reflection failure never escapes — so this
 * pins the order and the swallowing rather than the individual launchers.
 */
import { describe, expect, test } from "bun:test";
import { runPostCompactionTail } from "@/cli/helpers/post-compaction";
import {
  createSharedReminderState,
  type SharedReminderState,
} from "@/reminders/state";

/** A state whose one-shot reminders already went out, as before a compaction. */
function spentState(): SharedReminderState {
  const state = createSharedReminderState();
  state.hasSentAgentInfo = true;
  state.hasSentSessionContext = true;
  state.hasSentSecretsInfo = true;
  state.hasSentMcpServersInfo = true;
  return state;
}

describe("runPostCompactionTail", () => {
  test("re-arms the reminders, reflects, then regenerates the description", () => {
    const state = spentState();
    const order: string[] = [];

    runPostCompactionTail({
      reminderState: state,
      reflect: () => {
        order.push("reflect");
        // The reminders are already re-armed when the reflection runs.
        expect(state.hasSentAgentInfo).toBe(false);
      },
      regenerateDescription: () => {
        order.push("describe");
      },
    });

    expect(order).toEqual(["reflect", "describe"]);
    expect(state.hasSentAgentInfo).toBe(false);
    expect(state.hasSentSessionContext).toBe(false);
    expect(state.pendingSessionContextReason).toBe("post_compaction");
  });

  test("a throwing reflection is swallowed and the description still runs", () => {
    const state = spentState();
    let described = false;

    expect(() =>
      runPostCompactionTail({
        reminderState: state,
        reflect: () => {
          throw new Error("reflection unavailable");
        },
        regenerateDescription: () => {
          described = true;
        },
      }),
    ).not.toThrow();

    expect(described).toBe(true);
    expect(state.hasSentSessionContext).toBe(false);
  });
});
