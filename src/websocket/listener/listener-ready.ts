/**
 * Parser for the `listener_ready` lifecycle frame.
 *
 * The frame is emitted by an app-server peer once it has finished its own
 * startup handshake. It carries the peer's connection generation and attempt
 * counters so a client can tell a superseded generation from the live one.
 */

import type { WebSocket } from "ws";

export interface ListenerReadyMessage {
  type: "listener_ready";
  connection_generation: string;
  connection_attempt: number;
}

export function parseListenerReadyMessage(
  data: WebSocket.RawData,
): ListenerReadyMessage | null {
  try {
    const parsed = JSON.parse(data.toString()) as Partial<ListenerReadyMessage>;
    if (
      parsed.type === "listener_ready" &&
      typeof parsed.connection_generation === "string" &&
      typeof parsed.connection_attempt === "number" &&
      Number.isInteger(parsed.connection_attempt) &&
      parsed.connection_attempt > 0
    ) {
      return parsed as ListenerReadyMessage;
    }
  } catch {
    // Other frames belong to the normal listener message parser.
  }
  return null;
}
