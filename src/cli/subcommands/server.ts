import {
  printAppServerHelp,
  runAppServerSubcommand,
} from "@/cli/subcommands/app-server";

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
    printAppServerHelp();
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
