import packageJson from "../../../package.json";

/**
 * Get standard headers for manual HTTP calls to Letta API.
 * Use this for any direct fetch() calls (not SDK calls).
 */
export function getHaruyukiHeaders(apiKey?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "User-Agent": `letta-code/${packageJson.version}`,
    "X-Letta-Source": "letta-code",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

/**
 * Get headers for MCP OAuth connections (includes Accept header for SSE).
 */
export function getMcpOAuthHeaders(apiKey: string): Record<string, string> {
  return {
    ...getHaruyukiHeaders(apiKey),
    Accept: "text/event-stream",
  };
}
