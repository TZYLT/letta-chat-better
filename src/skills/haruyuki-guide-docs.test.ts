import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = process.cwd();
const skillDir = join(repoRoot, "src", "skills", "builtin", "haruyuki-guide");
const readerScript = join(skillDir, "scripts", "read-local-docs.mjs");
const tempDirs: string[] = [];

const CLI_DOC = `# CLI

## Commands

Text.

\`\`\`bash
# not a heading
\`\`\`

## Flags

Text.
`;

const NOTES_DOC = `# Notes

## Detail
`;

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "haruyuki-guide-docs-"));
  tempDirs.push(dir);
  return dir;
}

function writeDocs(files: Record<string, string>): string {
  const dir = makeTempDir();
  for (const [name, body] of Object.entries(files)) {
    const target = join(dir, name);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, body, "utf8");
  }
  return dir;
}

async function runScript(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const processHandle = Bun.spawn({
    cmd: ["node", readerScript, ...args],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function statusFromStderr(stderr: string): Record<string, unknown> {
  return JSON.parse(stderr.trim()) as Record<string, unknown>;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() ?? "", {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  }
});

describe("haruyuki-guide local reference reader", () => {
  test("indexes every bundled document with its heading outline", async () => {
    const docsDir = writeDocs({
      "cli.md": CLI_DOC,
      "deep/notes.md": NOTES_DOC,
    });

    const result = await runScript(["--docs-dir", docsDir, "--status-json"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Reference documents: ${docsDir}`);
    expect(result.stdout).toContain("## cli (14 lines)");
    expect(result.stdout).toContain("Commands (lines 3-10)");
    expect(result.stdout).toContain("Flags (lines 11-13)");
    // Nested documents keep a path-shaped slug.
    expect(result.stdout).toContain("## deep/notes (4 lines)");
    expect(result.stdout).toContain("Detail (lines 3-3)");
    // A `#` inside a fenced example is not a heading.
    expect(result.stdout).not.toContain("not a heading");

    expect(statusFromStderr(result.stderr)).toMatchObject({
      docsDir,
      documentCount: 2,
      documents: [
        { slug: "cli", lineCount: 14, headings: 3 },
        { slug: "deep/notes", lineCount: 4, headings: 2 },
      ],
    });
  });

  test("prints one document by slug and refuses an unknown slug", async () => {
    const docsDir = writeDocs({
      "cli.md": CLI_DOC,
      "deep/notes.md": NOTES_DOC,
    });

    const printed = await runScript(["--docs-dir", docsDir, "--doc", "cli"]);
    expect(printed.exitCode).toBe(0);
    expect(printed.stdout).toBe(CLI_DOC);

    const nested = await runScript([
      "--docs-dir",
      docsDir,
      "--doc",
      "deep/notes",
    ]);
    expect(nested.exitCode).toBe(0);
    expect(nested.stdout).toBe(NOTES_DOC);

    const missing = await runScript(["--docs-dir", docsDir, "--doc", "nope"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain('No reference document named "nope"');
    expect(missing.stderr).toContain("Available: cli, deep/notes");
  });

  test("searches across documents and reports an empty result honestly", async () => {
    const docsDir = writeDocs({
      "cli.md": CLI_DOC,
      "deep/notes.md": NOTES_DOC,
    });

    const hits = await runScript([
      "--docs-dir",
      docsDir,
      "--search",
      "not a heading",
      "--status-json",
    ]);
    expect(hits.exitCode).toBe(0);
    expect(hits.stdout).toContain("cli.md:8: # not a heading");
    expect(statusFromStderr(hits.stderr)).toMatchObject({
      search: { query: "not a heading", matches: 1 },
    });

    // Case-insensitive, and a miss is not an error.
    const miss = await runScript(["--docs-dir", docsDir, "--search", "ABSENT"]);
    expect(miss.exitCode).toBe(0);
    expect(miss.stdout).toBe(
      'No matches for "ABSENT" in 2 reference document(s).\n',
    );
  });

  test("says the reference is not generated yet instead of guessing", async () => {
    const emptyDir = makeTempDir();
    const index = await runScript(["--docs-dir", emptyDir]);
    expect(index.exitCode).toBe(0);
    expect(index.stdout).toContain("No reference documents are bundled yet");
    expect(index.stdout).toContain("Answer from this repository's own source");

    const nested = await runScript([
      "--docs-dir",
      join(emptyDir, "absent"),
      "--doc",
      "cli",
    ]);
    expect(nested.exitCode).toBe(1);
    expect(nested.stderr).toContain("No reference documents are bundled yet");
  });

  test("the reader route is local-only", async () => {
    const reader = readFileSync(readerScript, "utf8");
    for (const networkDependency of [
      "node:http",
      "node:https",
      "node:child_process",
      "curl",
      "fetch(",
      "XMLHttpRequest",
    ]) {
      expect(reader).not.toContain(networkDependency);
    }
  });

  test("the skill points at the bundled reference and drops upstream routes", () => {
    const skill = readFileSync(join(skillDir, "SKILL.md"), "utf8");
    expect(skill).toContain("name: haruyuki-guide");
    expect(skill).toContain("node <SKILL_DIR>/scripts/read-local-docs.mjs");
    expect(skill).toContain("--doc <slug>");
    expect(skill).toContain("--search");
    expect(skill).toContain("applies_to:");
    expect(skill).toContain("backends: [local]");
    for (const removedRoute of [
      "docs.letta.com",
      "status.letta.com",
      "discord.gg",
      "letta-ai/letta-code",
      "fetch-letta-docs",
      "fetch_webpage",
      "letta-docs-cache",
      "--docs-url",
      "--cache-dir",
    ]) {
      expect(skill).not.toContain(removedRoute);
    }
  });
});
