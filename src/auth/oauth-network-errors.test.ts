import { afterEach, describe, expect, mock, test } from "bun:test";
import { OAuthRefreshError, refreshAccessToken } from "@/auth/oauth";

const originalFetch = globalThis.fetch;

function makeFetchFailure(message: string, code?: string): Error {
  const cause = Object.assign(new Error(message), code ? { code } : {});
  return new TypeError("fetch failed", { cause });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OAuth refresh errors", () => {
  test("refreshAccessToken includes auth host and low-level cause", async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(
        makeFetchFailure("certificate has expired", "CERT_HAS_EXPIRED"),
      ),
    ) as unknown as typeof fetch;

    let refreshError: unknown;
    try {
      await refreshAccessToken("refresh-token", "device-id", "device-name");
    } catch (error) {
      refreshError = error;
    }
    expect(refreshError).toBeInstanceOf(OAuthRefreshError);
    expect((refreshError as OAuthRefreshError).message).toContain(
      "Failed to refresh access token from app.letta.com: certificate has expired (CERT_HAS_EXPIRED).",
    );
    expect((refreshError as OAuthRefreshError).retryable).toBe(true);
  });

  test("refreshAccessToken distinguishes revoked credentials from server failures", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetch;

    try {
      await refreshAccessToken("revoked", "device-id");
      throw new Error("Expected revoked refresh to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(OAuthRefreshError);
      expect((error as OAuthRefreshError).retryable).toBe(false);
      expect((error as OAuthRefreshError).oauthCode).toBe("invalid_grant");
    }

    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "temporarily_unavailable" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetch;

    try {
      await refreshAccessToken("valid", "device-id");
      throw new Error("Expected server failure to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(OAuthRefreshError);
      expect((error as OAuthRefreshError).retryable).toBe(true);
      expect((error as OAuthRefreshError).status).toBe(503);
    }
  });

  test("refreshAccessToken returns the rotated token response", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "access-token",
            refresh_token: "rotated-refresh-token",
            token_type: "Bearer",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    ) as unknown as typeof fetch;

    await expect(
      refreshAccessToken("refresh-token", "device-id"),
    ).resolves.toMatchObject({
      access_token: "access-token",
      refresh_token: "rotated-refresh-token",
    });
  });
});
