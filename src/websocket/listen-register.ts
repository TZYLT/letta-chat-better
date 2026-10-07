/**
 * Listener identity and local transport contract.
 *
 * This module used to own the Cloud environment registration request. The
 * registration half is gone with the Cloud relay: a listener is now always a
 * locally accepted app-server connection, so nothing dereferences a
 * server-assigned connection id or ws url any more. What remains is the stable
 * listener-instance identity that local ownership locks are keyed on.
 */

import { createHash } from "node:crypto";

export interface RegisterResult {
  connectionId: string;
  wsUrl: string;
  supportsSplitStatusChannels: boolean;
  supportsPairedListenerGenerations: boolean;
}

export interface RegisterOptions {
  serverUrl: string;
  apiKey: string;
  deviceId: string;
  connectionName: string;
  /**
   * Stable identifier for this listener process, so multiple listeners on
   * one device get separate identity slots instead of contesting a single
   * per-device row. Optional: servers that predate the field ignore it.
   */
  listenerInstanceId?: string;
}

/**
 * Derive a stable listener instance id from the listener surface and its
 * connection name. Deterministic (no stored state): the same surface + name
 * maps to the same instance across restarts, while a rename creates a new
 * instance.
 *
 * Surfaces:
 * - "server": `letta server` CLI process
 * - "listen": in-app /listen command
 */
export function deriveListenerInstanceId(
  surface: "server" | "listen",
  connectionName: string,
): string {
  const nameHash = createHash("sha256")
    .update(connectionName)
    .digest("hex")
    .slice(0, 16);
  return `${surface}-${nameHash}`;
}
