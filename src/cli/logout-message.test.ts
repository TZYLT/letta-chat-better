import { describe, expect, test } from "bun:test";
import { buildLogoutSuccessMessage } from "@/cli/helpers/logout-message";

describe("buildLogoutSuccessMessage", () => {
  test("points at /connect instead of the removed /login flow", () => {
    expect(buildLogoutSuccessMessage(false)).toBe(
      "✓ Logged out successfully. Run 'letta' and use /connect to configure a provider.",
    );
  });

  test("warns when LETTA_API_KEY remains set in the environment", () => {
    const message = buildLogoutSuccessMessage(true);

    expect(message).toContain("✓ Cleared saved Letta credentials.");
    expect(message).toContain("LETTA_API_KEY is still set");
    expect(message).toContain("/logout does not clear environment variables");
    expect(message).not.toContain("re-authenticate");
  });
});
