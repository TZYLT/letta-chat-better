import { describe, expect, test } from "bun:test";
import {
  normalizeServerArgs,
  runServerSubcommand,
} from "@/cli/subcommands/server";

describe("server subcommand", () => {
  test("prints help and succeeds for --help", async () => {
    expect(await runServerSubcommand(["--help"])).toBe(0);
    expect(await runServerSubcommand(["-h"])).toBe(0);
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
