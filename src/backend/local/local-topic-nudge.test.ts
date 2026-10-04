/**
 * The one-shot no-marker nudge (feature ③, D-114), at the port level.
 *
 * The claims here are the ones a real store would otherwise hide: the nudge
 * fires once per streak, the flag is written exactly once and cleared whenever
 * the streak ended, and the schedule is only ever consulted through the numbers
 * the caller read.
 */
import { describe, expect, test } from "bun:test";
import type { LocalMessage } from "@/backend/local/local-message";
import {
  consumeLocalTopicNudge,
  type LocalTopicNudgePorts,
} from "@/backend/local/local-topic-nudge";
import type { LocalConversationContextManagement } from "@/backend/local/local-types";

function userMessage(id: string): LocalMessage {
  return {
    id,
    role: "user",
    content: [{ type: "text", text: id }],
    metadata: { created_at: "2026-01-01T00:00:00.000Z" },
  } as LocalMessage;
}

interface FakePorts {
  ports: LocalTopicNudgePorts;
  writes: boolean[];
  stored: () => LocalConversationContextManagement;
}

function fakePorts(input: {
  turns: number;
  nudgeTurns: number;
  sent?: boolean;
}): FakePorts {
  const writes: boolean[] = [];
  let stored: LocalConversationContextManagement = input.sent
    ? { nudge_sent_for_streak: true }
    : {};
  const messages = Array.from({ length: input.turns }, (_, index) =>
    userMessage(`u${index}`),
  );
  return {
    writes,
    stored: () => stored,
    ports: {
      listMessages: () => messages,
      readMarkers: () => [],
      readContextManagement: () => ({ ...stored }),
      setTopicNudgeSent: (_conversationId, _agentId, sent) => {
        writes.push(sent);
        stored = sent ? { nudge_sent_for_streak: true } : {};
      },
    },
  };
}

describe("consumeLocalTopicNudge", () => {
  test("fires once at the threshold and records that it did", () => {
    const fake = fakePorts({ turns: 5, nudgeTurns: 5 });

    const decision = consumeLocalTopicNudge(fake.ports, {
      conversationId: "conv-1",
      agentId: "agent-1",
      nudgeTurns: 5,
    });

    expect(decision).toEqual({
      due: true,
      reason: "due",
      turnsSinceLastMarker: 5,
      nudgeTurns: 5,
    });
    expect(fake.writes).toEqual([true]);
    expect(fake.stored()).toEqual({ nudge_sent_for_streak: true });
  });

  test("does not fire twice for the same stretch", () => {
    const fake = fakePorts({ turns: 9, nudgeTurns: 5, sent: true });

    const decision = consumeLocalTopicNudge(fake.ports, {
      conversationId: "conv-1",
      agentId: "agent-1",
      nudgeTurns: 5,
    });

    expect(decision.due).toBe(false);
    expect(decision.reason).toBe("already_sent");
    // The flag stays set; the store drops the write because nothing changed.
    expect(fake.writes).toEqual([true]);
    expect(fake.stored()).toEqual({ nudge_sent_for_streak: true });
  });

  test("clears the flag when the stretch ended (a new marker or a trim)", () => {
    const fake = fakePorts({ turns: 1, nudgeTurns: 5, sent: true });

    const decision = consumeLocalTopicNudge(fake.ports, {
      conversationId: "conv-1",
      agentId: "agent-1",
      nudgeTurns: 5,
    });

    expect(decision.reason).toBe("below_threshold");
    expect(fake.writes).toEqual([false]);
    expect(fake.stored()).toEqual({});
  });

  test("respects a disabled threshold without recording anything", () => {
    const fake = fakePorts({ turns: 80, nudgeTurns: 0 });

    const decision = consumeLocalTopicNudge(fake.ports, {
      conversationId: "conv-1",
      agentId: "agent-1",
      nudgeTurns: 0,
    });

    expect(decision.due).toBe(false);
    expect(decision.reason).toBe("disabled");
    expect(fake.writes).toEqual([false]);
    expect(fake.stored()).toEqual({});
  });

  test("disabling the nudge mid-streak keeps the one-shot flag (L-5)", () => {
    // The stretch did not end just because the knob was turned off, so turning it
    // back on inside the same stretch must not produce a second reminder.
    const fake = fakePorts({ turns: 80, nudgeTurns: 0, sent: true });

    const decision = consumeLocalTopicNudge(fake.ports, {
      conversationId: "conv-1",
      agentId: "agent-1",
      nudgeTurns: 0,
    });

    expect(decision.reason).toBe("disabled");
    expect(fake.writes).toEqual([true]);
    expect(fake.stored()).toEqual({ nudge_sent_for_streak: true });
  });

  test("a trim that leaves the stretch long still re-arms the nudge (M-4)", () => {
    // The trim cleared the flag through the store; the next turn is over the
    // threshold again, so a fresh reminder is due rather than `already_sent`.
    const fake = fakePorts({ turns: 80, nudgeTurns: 50 });

    const decision = consumeLocalTopicNudge(fake.ports, {
      conversationId: "conv-1",
      agentId: "agent-1",
      nudgeTurns: 50,
    });

    expect(decision.reason).toBe("due");
    expect(fake.writes).toEqual([true]);
  });
});
