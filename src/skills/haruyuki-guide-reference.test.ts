import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();
const skillDir = join(repoRoot, "src", "skills", "builtin", "haruyuki-guide");
const docsDir = join(skillDir, "docs");
const readerScript = join(skillDir, "scripts", "read-local-docs.mjs");
const extractorScript = join(
  repoRoot,
  "scripts",
  "extract-haruyuki-reference.mjs",
);
const citationScript = join(
  repoRoot,
  "scripts",
  "check-reference-citations.mjs",
);

/** Documents the skill is expected to ship, beyond the generated index. */
const HAND_WRITTEN_DOCS = [
  "commands.md",
  "context-and-compaction.md",
  "memory-filesystem.md",
  "provenance.md",
  "settings-and-paths.md",
  "unsupported.md",
];

async function run(
  cmd: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const handle = Bun.spawn({
    cmd,
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    handle.exited,
    new Response(handle.stdout).text(),
    new Response(handle.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("haruyuki-guide bundled reference corpus", () => {
  test("ships the generated index and every hand-written document", () => {
    const shipped = readdirSync(docsDir).sort();
    expect(shipped).toContain("reference-index.md");
    for (const name of HAND_WRITTEN_DOCS) {
      expect(shipped).toContain(name);
    }
  });

  test("the reader indexes the shipped corpus", async () => {
    const result = await run(["node", readerScript]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(
      "No reference documents are bundled yet",
    );
    for (const name of ["reference-index", ...HAND_WRITTEN_DOCS]) {
      const slug = name.replace(/\.md$/, "");
      expect(result.stdout).toContain(`## ${slug} (`);
    }
  });

  test("the generated index still matches the command tree", async () => {
    // The extractor imports this repository's TypeScript, so it runs under the
    // same runtime as the test rather than under plain node.
    const result = await run([process.execPath, extractorScript]);
    expect(result.stderr).not.toContain("is out of date");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("matches the command tree");
  });

  test("every file:line citation resolves", async () => {
    const result = await run(["node", citationScript]);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("resolve to real lines");
  });
});

describe("haruyuki-guide document frontmatter", () => {
  test.each([...HAND_WRITTEN_DOCS, "reference-index.md"])(
    "%s declares the local backend and its interfaces",
    (name) => {
      const body = readFileSync(join(docsDir, name), "utf8");
      expect(body.startsWith("---\n")).toBe(true);
      const frontmatter = body.slice(4, body.indexOf("\n---", 4));
      expect(frontmatter).toContain("title:");
      expect(frontmatter).toContain("description:");
      expect(frontmatter).toContain("applies_to:");
      expect(frontmatter).toContain("backends: [local]");
      expect(frontmatter).toContain("interfaces:");
    },
  );
});
