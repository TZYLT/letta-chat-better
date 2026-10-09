import { describe, expect, test } from "bun:test";
import { __testParseAppServerArgs } from "@/cli/subcommands/app-server";
import {
  normalizeServerArgs,
  runServerSubcommand,
} from "@/cli/subcommands/server";

/** Capture what `haruyuki server --help` prints. */
async function captureServerHelp(): Promise<string> {
  const messages: string[] = [];
  const originalLog = console.log;
  console.log = (message?: unknown) => {
    messages.push(String(message));
  };
  try {
    expect(await runServerSubcommand(["--help"])).toBe(0);
  } finally {
    console.log = originalLog;
  }
  return messages.join("\n");
}

describe("server subcommand", () => {
  test("prints help and succeeds for --help", async () => {
    expect(await runServerSubcommand(["--help"])).toBe(0);
    expect(await runServerSubcommand(["-h"])).toBe(0);
  });

  // Regression: the help used to be a hand-written list next to a separate
  // parser, and it advertised `--debug`, which the parser has never accepted.
  test("every flag the help prints is one the parser accepts", async () => {
    const help = await captureServerHelp();
    const flags = [...new Set(help.match(/--[a-z][a-z0-9-]*/g) ?? [])];
    expect(flags.length).toBeGreaterThan(0);

    for (const flag of flags) {
      const accepted = (() => {
        for (const argv of [[flag], [flag, "dummy-value"]]) {
          try {
            __testParseAppServerArgs(argv);
            return true;
          } catch {
            // Try the other shape: booleans reject a value, strings need one.
          }
        }
        return false;
      })();
      expect(`${flag} accepted=${accepted}`).toBe(`${flag} accepted=true`);
    }
  });

  test("a bare --listen means an available loopback port", () => {
    expect(normalizeServerArgs(["--listen"])).toEqual([]);
    expect(normalizeServerArgs(["--listen", "--openai-api"])).toEqual([
      "--openai-api",
    ]);
  });

  test("accepts space-separated and equals-form listen URLs", () => {
    expect(normalizeServerArgs(["--listen", "ws://127.0.0.1:4500"])).toEqual([
      "--listen",
      "ws://127.0.0.1:4500",
    ]);
    expect(normalizeServerArgs(["--listen=ws://127.0.0.1:4500"])).toEqual([
      "--listen",
      "ws://127.0.0.1:4500",
    ]);
  });

  test("keeps channel options alongside --listen", () => {
    expect(normalizeServerArgs(["--channels", "telegram", "--listen"])).toEqual(
      ["--channels", "telegram"],
    );
  });

  test("rejects ambiguous listen arguments", () => {
    expect(() =>
      normalizeServerArgs(["--listen", "--listen=ws://127.0.0.1:4500"]),
    ).toThrow("--listen may only be specified once");
    expect(() => normalizeServerArgs(["--listen="])).toThrow(
      "--listen= requires a URL",
    );
  });
});
