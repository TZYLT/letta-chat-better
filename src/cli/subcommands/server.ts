import { runAppServerSubcommand } from "@/cli/subcommands/app-server";

function printServerHelp(): void {
  console.log(`Usage:
  letta server [App Server options]

Run the local agent server: accept App Server connections and serve messaging
channels. The server binds a local WebSocket endpoint; it never registers with,
or dials out to, a remote environment service.

App Server options:
  --listen [url]  Accept App Server connections. If URL is omitted, binds to an available loopback port
  --channels <list>  Comma-separated channel names to enable (e.g. telegram)
  --install-channel-runtimes  Install missing runtime dependencies for selected channels
  --debug  Log WebSocket events instead of showing the interactive status UI
  --openai-api  Serve OpenAI-compatible /v1/models, /v1/chat/completions, and /v1/responses routes (each agent is a model)
  --ws-auth <mode>  Authentication for non-loopback listeners and Origin-bearing native clients: capability-token or signed-bearer-token
  --ws-token-file <path>  Absolute path to the capability-token file
  --ws-token-sha256 <hex>  Hex-encoded SHA-256 digest of the capability token
  --ws-shared-secret-file <path>  Absolute path to the shared secret file for signed JWT bearer tokens
  --ws-issuer <issuer>  Expected issuer for signed JWT bearer tokens
  --ws-audience <audience>  Expected audience for signed JWT bearer tokens
  --ws-max-clock-skew-seconds <seconds>  Maximum signed-token clock skew

Common options:
  -h, --help  Show this help message

Examples:
  letta server
  letta server --listen ws://127.0.0.1:4500
  letta server --channels telegram
  letta server --listen ws://0.0.0.0:4500 --ws-auth capability-token --ws-token-file /path/to/token`);
}

export async function runServerSubcommand(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    printServerHelp();
    return 0;
  }

  return runAppServerSubcommand(argv);
}
