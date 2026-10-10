/**
 * OAuth 2.0 utilities for Letta Cloud authentication.
 *
 * Only the refresh path survives in this fork: the device-code login flow,
 * token revocation and credential probing had no production caller once the
 * hosted backend was removed (the local backend owns credentials on disk).
 * `HARUYUKI_CLOUD_API_URL`, `OAUTH_CONFIG` and `refreshAccessToken` are live —
 * the first names the legacy Cloud namespace key, the last is what the API
 * client and the provider usage query refresh through.
 */

export const HARUYUKI_CLOUD_API_URL = "https://api.letta.com";

export const OAUTH_CONFIG = {
  clientId: "ci-let-724dea7e98f4af6f8f370f4b1466200c",
  clientSecret: "",
  authBaseUrl: "https://app.letta.com",
  apiBaseUrl: HARUYUKI_CLOUD_API_URL,
} as const;

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

interface OAuthError {
  error: string;
  error_description?: string;
}

export class OAuthRefreshError extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  readonly oauthCode?: string;

  constructor(
    message: string,
    options: {
      retryable: boolean;
      status?: number;
      oauthCode?: string;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "OAuthRefreshError";
    this.retryable = options.retryable;
    this.status = options.status;
    this.oauthCode = options.oauthCode;
  }
}

function getOAuthAuthHost(): string {
  try {
    return new URL(OAUTH_CONFIG.authBaseUrl).host;
  } catch {
    return OAUTH_CONFIG.authBaseUrl;
  }
}

function getErrorLikeMessage(value: unknown): string | null {
  if (value instanceof Error) {
    return value.message.trim() || null;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const message = (value as { message?: unknown }).message;
  return typeof message === "string" && message.trim().length > 0
    ? message.trim()
    : null;
}

function getErrorLikeCode(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const code = (value as { code?: unknown }).code;
  return typeof code === "string" && code.trim().length > 0
    ? code.trim()
    : null;
}

function isGenericFetchFailureMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return (
    normalized === "fetch failed" || normalized === "network request failed"
  );
}

function isOAuthTransportError(error: unknown): error is Error {
  if (!(error instanceof Error)) {
    return false;
  }

  if (isGenericFetchFailureMessage(error.message)) {
    return true;
  }

  return error.name === "TypeError" && error.cause !== undefined;
}

function extractOAuthTransportDetail(error: Error): string | null {
  const directMessage = isGenericFetchFailureMessage(error.message)
    ? null
    : error.message.trim() || null;
  const causeMessage = getErrorLikeMessage(error.cause);
  const causeCode = getErrorLikeCode(error.cause);

  let detail = causeMessage ?? directMessage;
  if (!detail && causeCode) {
    detail = causeCode;
  }

  if (detail && causeCode && !detail.includes(causeCode)) {
    detail = `${detail} (${causeCode})`;
  }

  return detail;
}

function toOAuthActionError(
  action: string,
  error: unknown,
  options?: { browserHint?: boolean },
): Error {
  if (isOAuthTransportError(error)) {
    const host = getOAuthAuthHost();
    const detail = extractOAuthTransportDetail(error);
    const reachabilityHint = options?.browserHint
      ? "Browser authorization may have succeeded, but the CLI could not reach Letta auth servers from this machine."
      : "The CLI could not reach Letta auth servers from this machine.";

    return new Error(
      `Failed to ${action} from ${host}${detail ? `: ${detail}` : ""}. ${reachabilityHint} Check your network, DNS, proxy, VPN, or TLS settings.`,
    );
  }

  if (error instanceof Error) {
    return error;
  }

  return new Error(`Failed to ${action}: ${String(error)}`);
}

/**
 * Refresh an access token using a refresh token
 */
export async function refreshAccessToken(
  refreshToken: string,
  deviceId: string,
  deviceName?: string,
): Promise<TokenResponse> {
  const authHost = getOAuthAuthHost();
  try {
    const response = await fetch(
      `${OAUTH_CONFIG.authBaseUrl}/api/oauth/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: OAUTH_CONFIG.clientId,
          refresh_token: refreshToken,
          refresh_token_mode: "new",
          device_id: deviceId,
          ...(deviceName && { device_name: deviceName }),
        }),
      },
    );

    if (!response.ok) {
      const error = (await response.json()) as OAuthError;
      throw new OAuthRefreshError(
        `Failed to refresh access token from ${authHost}: ${error.error_description || error.error}`,
        {
          retryable:
            response.status === 408 ||
            response.status === 429 ||
            response.status >= 500,
          status: response.status,
          oauthCode: error.error,
        },
      );
    }

    return (await response.json()) as TokenResponse;
  } catch (error) {
    if (error instanceof OAuthRefreshError) {
      throw error;
    }
    const actionError = toOAuthActionError("refresh access token", error);
    throw new OAuthRefreshError(actionError.message, {
      retryable: true,
      cause: error,
    });
  }
}
