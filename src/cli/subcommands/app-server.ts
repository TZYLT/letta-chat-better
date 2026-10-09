import { parseArgs } from "node:util";
import type { ChannelGatewaySupervisor } from "@/channels/gateway-supervisor";
import { startAppServer } from "@/websocket/app-server";
import { parseAppServerWebsocketAuthSettings } from "@/websocket/app-server-auth";

/**
 * The documented App Server options, in display order.
 *
 * This table is the single source for `haruyuki server --help`. It is deliberately
 * separate from the parser's option list (which needs literal types), so
 * `server.test.ts` re-parses every flag printed here: a help line that names a
 * flag the parser rejects — the `--debug` drift — fails a test instead of
 * reaching users.
 */
const APP_SERVER_OPTION_HELP: ReadonlyArray<{
  flag: string;
  description: string;
}> = [
  {
    flag: "--listen [url]",
    description:
      "Accept App Server connections. If URL is omitted, binds to an available loopback port",
  },
  {
    flag: "--channels <list>",
    description: "Comma-separated channel names to enable (e.g. telegram)",
  },
  {
    flag: "--install-channel-runtimes",
    description:
      "Install missing runtime deps for the selected channels before startup",
  },
  {
    flag: "--openai-api",
    description:
      "Serve OpenAI-compatible /v1/models, /v1/chat/completions, and /v1/responses routes (each agent is a model)",
  },
  {
    flag: "--ws-auth <mode>",
    description:
      "WebSocket auth for non-loopback listeners and Origin-bearing native clients: capability-token or signed-bearer-token",
  },
  {
    flag: "--ws-token-file <path>",
    description: "Absolute path to the capability-token file",
  },
  {
    flag: "--ws-token-sha256 <hex>",
    description: "Hex-encoded SHA-256 digest of the capability token",
  },
  {
    flag: "--ws-shared-secret-file <path>",
    description:
      "Absolute path to the shared secret file for signed JWT bearer tokens",
  },
  {
    flag: "--ws-issuer <issuer>",
    description: "Expected issuer for signed JWT bearer tokens",
  },
  {
    flag: "--ws-audience <audience>",
    description: "Expected audience for signed JWT bearer tokens",
  },
  {
    flag: "--ws-max-clock-skew-seconds <seconds>",
    description: "Maximum clock skew for signed JWT bearer token validation",
  },
];

const APP_SERVER_EXAMPLES: readonly string[] = [
  "haruyuki server",
  "haruyuki server --listen ws://127.0.0.1:4500",
  "haruyuki server --channels telegram",
  "haruyuki server --channels telegram --install-channel-runtimes",
  "haruyuki server --listen ws://0.0.0.0:4500 --ws-auth capability-token --ws-token-file /path/to/token",
  "haruyuki server --listen ws://0.0.0.0:4500 --ws-auth signed-bearer-token --ws-shared-secret-file /path/to/secret",
  "haruyuki server --listen ws://127.0.0.1:4500 --openai-api",
];

/**
 * The one help text for `haruyuki server` and `haruyuki app-server`.
 *
 * `server.ts` prints this rather than keeping a second copy: the copy it used to
 * keep advertised `--debug`, which the parser below has never accepted.
 */
export function printAppServerHelp(): void {
  const options = APP_SERVER_OPTION_HELP.map(
    ({ flag, description }) => `  ${flag}  ${description}`,
  ).join("\n");
  const examples = APP_SERVER_EXAMPLES.join("\n  ");
  console.log(`Usage:
  haruyuki server [App Server options]

Run the local agent server: accept App Server connections and serve messaging
channels. The server binds a local WebSocket endpoint; it never registers with,
or dials out to, a remote environment service.

App Server options:
${options}
  -h, --help  Show this help message

Examples:
  ${examples}`);
}

function parseAppServerArgs(argv: string[]): ReturnType<typeof parseArgs> {
  return parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      help: { type: "boolean", short: "h" },
      listen: { type: "string" },
      channels: { type: "string" },
      "install-channel-runtimes": { type: "boolean" },
      "openai-api": { type: "boolean" },
      "ws-auth": { type: "string" },
      "ws-token-file": { type: "string" },
      "ws-token-sha256": { type: "string" },
      "ws-shared-secret-file": { type: "string" },
      "ws-issuer": { type: "string" },
      "ws-audience": { type: "string" },
      "ws-max-clock-skew-seconds": { type: "string" },
    },
  });
}

/**
 * @internal Test seam: run the real parser over `argv`, so `server.test.ts` can
 * assert that every flag the help prints is one this parser accepts.
 */
export function __testParseAppServerArgs(argv: string[]): void {
  parseAppServerArgs(argv);
}

async function waitForShutdown(
  close: () => Promise<void>,
  closeChannels?: () => Promise<void>,
): Promise<number> {
  return await new Promise<number>((resolve) => {
    let shuttingDown = false;
    const shutdown = (signal: NodeJS.Signals) => {
      if (shuttingDown) return;
      shuttingDown = true;
      void (async () => {
        try {
          await closeChannels?.();
          await close();
          console.log(`\nStopped App Server (${signal}).`);
          resolve(0);
        } catch (error) {
          console.error(
            error instanceof Error ? `Error: ${error.message}` : String(error),
          );
          resolve(1);
        }
      })();
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

/**
 * The channel gateway exhausted its restart budget. Stop the process rather
 * than leaving an App Server running with no way to reach any channel.
 */
async function exitAfterChannelFailure(
  supervisor: ChannelGatewaySupervisor,
  closeAppServer: () => Promise<void>,
): Promise<void> {
  try {
    await supervisor.close();
  } catch {
    // The supervisor is already unusable; the App Server still must stop.
  }
  try {
    await closeAppServer();
  } catch {
    // Nothing left to unwind.
  }
  process.exit(1);
}

export async function runAppServerSubcommand(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseAppServerArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? `Error: ${error.message}` : error);
    return 1;
  }

  if (parsed.values.help) {
    printAppServerHelp();
    return 0;
  }

  try {
    const websocketAuth = parseAppServerWebsocketAuthSettings({
      wsAuth:
        typeof parsed.values["ws-auth"] === "string"
          ? parsed.values["ws-auth"]
          : undefined,
      wsTokenFile:
        typeof parsed.values["ws-token-file"] === "string"
          ? parsed.values["ws-token-file"]
          : undefined,
      wsTokenSha256:
        typeof parsed.values["ws-token-sha256"] === "string"
          ? parsed.values["ws-token-sha256"]
          : undefined,
      wsSharedSecretFile:
        typeof parsed.values["ws-shared-secret-file"] === "string"
          ? parsed.values["ws-shared-secret-file"]
          : undefined,
      wsIssuer:
        typeof parsed.values["ws-issuer"] === "string"
          ? parsed.values["ws-issuer"]
          : undefined,
      wsAudience:
        typeof parsed.values["ws-audience"] === "string"
          ? parsed.values["ws-audience"]
          : undefined,
      wsMaxClockSkewSeconds:
        typeof parsed.values["ws-max-clock-skew-seconds"] === "string"
          ? parsed.values["ws-max-clock-skew-seconds"]
          : undefined,
    });

    const openaiApi = parsed.values["openai-api"] === true;
    const channelNames =
      typeof parsed.values.channels === "string"
        ? parsed.values.channels
            .split(",")
            .map((name) => name.trim())
            .filter(Boolean)
        : [];
    const handle = await startAppServer({
      listen:
        typeof parsed.values.listen === "string"
          ? parsed.values.listen
          : undefined,
      websocketAuth,
      openaiApi,
      onListening: (info) => {
        console.log(`Listening on ${info.url}`);
        console.log(`WebSocket: ${info.controlUrl}`);
        if (openaiApi) {
          const openaiBase = new URL(info.url);
          openaiBase.protocol = "http:";
          console.log(`OpenAI:  ${openaiBase.origin}/v1`);
        }
      },
      onLog: (message) => {
        console.error(message);
      },
    });

    if (channelNames.length === 0) {
      return await waitForShutdown(handle.close);
    }

    const { startChannelGatewaySupervisor } = await import(
      "@/channels/gateway-supervisor"
    );
    const { broadcastServiceProtocolMessage } = await import(
      "@/websocket/listener/protocol-outbound"
    );
    const { getActiveRuntime } = await import("@/websocket/listener/runtime");
    const supervisor = await startChannelGatewaySupervisor({
      appServerUrl: handle.controlUrl,
      channelNames,
      failOnStartupError: true,
      installChannelRuntimes:
        parsed.values["install-channel-runtimes"] === true,
      onLog: (message) => console.error(message),
      onUnexpectedExit: (error) => console.error(error.message),
      onRestartExhausted: (error) => {
        console.error(error.message);
        void exitAfterChannelFailure(supervisor, handle.close);
      },
      onServiceEvent: (event) => {
        if (event.kind !== "protocol") return;
        const runtime = getActiveRuntime();
        if (runtime) broadcastServiceProtocolMessage(runtime, event.message);
      },
    });

    return await waitForShutdown(handle.close, () => supervisor.close());
  } catch (error) {
    console.error(error instanceof Error ? `Error: ${error.message}` : error);
    return 1;
  }
}
