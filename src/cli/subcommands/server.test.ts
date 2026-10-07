import { describe, expect, test } from "bun:test";
import { runServerSubcommand } from "@/cli/subcommands/server";

describe("server subcommand", () => {
  test("prints help and succeeds for --help", async () => {
    expect(await runServerSubcommand(["--help"])).toBe(0);
    expect(await runServerSubcommand(["-h"])).toBe(0);
  });
});
