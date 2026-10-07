import { parseArgs } from "node:util";
import type { ChannelGatewaySupervisor } from "@/channels/gateway-supervisor";
import { startAppServer } from "@/websocket/app-server";
import { parseAppServerWebsocketAuthSettings } from "@/websocket/app-server-auth";

function printAppServerHelp(): void {
  console.log(
    `Usage: letta server [--listen [url]]

Run the local App Server using native v2 WebSocket frames.

Options:
  --listen [url]  WebSocket listen URL. Defaults to an available loopback port
  --channels <list>  Comma-separated channel names to enable (e.g. telegram)
  --install-channel-runtimes  Install missing runtime deps for the selected channels before startup
  --openai-api  Serve OpenAI-compatible /v1/models, /v1/chat/completions, and /v1/responses routes (each agent is a model)
  --ws-auth <mode>  WebSocket auth for non-loopback listeners and Origin-bearing native clients. Supported: capability-token, signed-bearer-token
  --ws-token-file <path>  Absolute path to the capability-token file
  --ws-token-sha256 <hex>  Hex-encoded SHA-256 digest of the capability token
  --ws-shared-secret-file <path>  Absolute path to the shared secret file for signed JWT bearer tokens
  --ws-issuer <issuer>  Expected issuer for signed JWT bearer tokens
  --ws-audience <audience>  Expected audience for signed JWT bearer tokens
  --ws-max-clock-skew-seconds <seconds>  Maximum clock skew for signed JWT bearer token validation
  -h, --help      Show this help message

Examples:
  letta server
  letta server --listen ws://127.0.0.1:4500
  letta server --channels telegram
  letta server --channels telegram --install-channel-runtimes
  letta server --listen ws://0.0.0.0:4500 --ws-auth capability-token --ws-token-file /path/to/token
  letta server --listen ws://0.0.0.0:4500 --ws-auth signed-bearer-token --ws-shared-secret-file /path/to/secret
  letta server --listen ws://127.0.0.1:4500 --openai-api`,
  );
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
    parsed = parseArgs({
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
