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

function isListenOption(arg: string): boolean {
  return arg === "--listen" || arg.startsWith("--listen=");
}

/**
 * Normalize `--listen` before the app-server parser sees it.
 *
 * `parseArgs` cannot express "flag with an optional value", so a bare
 * `--listen` has to be resolved here: it means "bind an available loopback
 * port", which the app-server already does when no URL is supplied.
 */
export function normalizeServerArgs(argv: string[]): string[] {
  const normalized: string[] = [];
  let foundListen = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) break;

    if (!isListenOption(arg)) {
      normalized.push(arg);
      continue;
    }

    if (foundListen) {
      throw new Error("--listen may only be specified once");
    }
    foundListen = true;

    if (arg.startsWith("--listen=")) {
      const listenUrl = arg.slice("--listen=".length);
      if (!listenUrl) {
        throw new Error(
          "--listen= requires a URL; use bare --listen for an available loopback port",
        );
      }
      normalized.push("--listen", listenUrl);
      continue;
    }

    const possibleUrl = argv[index + 1];
    if (possibleUrl && !possibleUrl.startsWith("-")) {
      normalized.push("--listen", possibleUrl);
      index += 1;
    }
  }

  return normalized;
}

export async function runServerSubcommand(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    printServerHelp();
    return 0;
  }

  let normalized: string[];
  try {
    normalized = normalizeServerArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? `Error: ${error.message}` : error);
    return 1;
  }

  return runAppServerSubcommand(normalized);
}
