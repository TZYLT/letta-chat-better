export function buildLogoutSuccessMessage(hasEnvApiKey: boolean): string {
  if (!hasEnvApiKey) {
    // `/login` no longer exists, so re-authenticating is no longer the next
    // step. `/connect` is how a provider gets configured now.
    return "✓ Logged out successfully. Run 'letta' and use /connect to configure a provider.";
  }

  return [
    "✓ Cleared saved Letta credentials.",
    "",
    "Note: LETTA_API_KEY is still set in your shell or system environment.",
    "/logout does not clear environment variables. Remove it manually if you",
    "want to stop authenticating with that key.",
  ].join("\n");
}
