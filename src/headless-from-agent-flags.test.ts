import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createIsolatedCliTestEnv } from "@/test-utils/test-process-env";

/**
 * Headless startup rejects `--from-agent` without a destination, and rejects it
 * alongside `--new-agent`, before any conversation is created.
 *
 * These two cases are what remains of the former cloud-recipient startup suite:
 * that suite asserted the Cloud delivery path selected by `--computer` /
 * `--environment` / `--env`, which no longer exists now that the local
 * in-process backend is the only backend. The `--from-agent` guard itself is
 * still enforced in `src/headless.ts` and is still reachable in local mode.
 */
async function runStartup(args: string[]) {
  const home = await mkdtemp(join(tmpdir(), "letta-from-agent-flags-"));
  const requestLog = join(home, "requests.jsonl");
  try {
    await mkdir(join(home, ".haruyuki"));
    await writeFile(
      join(home, ".haruyuki", "settings.json"),
      JSON.stringify({
        agents: [{ agentId: "agent-named-target", pinned: true }],
      }),
    );
    await writeFile(requestLog, "");
    const child = Bun.spawn(
      [
        process.execPath,
        `--config=${resolve(import.meta.dir, "..", "bunfig.toml")}`,
        "--preload",
        resolve(import.meta.dir, "test-utils/fixtures/cloud-send-startup.ts"),
        resolve(import.meta.dir, "index.ts"),
        "-p",
        "startup target check",
        "--backend",
        "local",
        ...args,
      ],
      {
        cwd: home,
        env: createIsolatedCliTestEnv({
          HOME: home,
          HARUYUKI_MODEL_CATALOG_CACHE_DIR: join(home, "cache"),
          HARUYUKI_SKIP_KEYCHAIN_CHECK: "1",
          LETTA_API_KEY: "test-only-no-network",
          LETTA_BASE_URL: "https://api.letta.com",
          CLI_STARTUP_REQUEST_LOG: requestLog,
          HARUYUKI_SUBAGENT_LAUNCH: undefined,
        }),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const deadline = setTimeout(() => child.kill(), 20_000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const requests = (await readFile(requestLog, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as { method: string; path: string; body?: string },
        );
      return { code, stdout, stderr, requests };
    } finally {
      clearTimeout(deadline);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test.each([
  {
    destination: [],
    error: "--from-agent requires --agent <id> or --conversation <id>",
  },
  {
    destination: ["--conversation", "default"],
    error: "--from-agent cannot be used with --new-agent",
  },
])(
  "startup still rejects --new-agent plus --from-agent after skipping enqueue: %j",
  async ({ destination, error }) => {
    const result = await runStartup([
      "--new-agent",
      "--from-agent",
      "agent-sender",
      ...destination,
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(error);
    expect(
      result.requests.filter(
        (request) =>
          request.method === "POST" &&
          (request.path.replace(/\/$/, "") === "/v1/agents" ||
            request.path.includes("/conversations")),
      ),
    ).toEqual([]);
  },
  25_000,
);
