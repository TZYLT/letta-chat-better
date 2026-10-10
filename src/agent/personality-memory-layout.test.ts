import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import {
  applyPersonalityToMemory,
  detectPersonalityFromPersonaFile,
} from "@/agent/personality";
import { getPersonalityContent } from "@/agent/personality-presets";
import { configureBackendMode } from "@/backend";

const AGENT_ID = "agent-personality-layout";
const LOCAL_BACKEND_DIR_ENV = "LETTA_LOCAL_BACKEND_DIR";

let storageDir = "";
let previousStorageDir: string | undefined;

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

function initMemoryRepo(repo: string): void {
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test Agent"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "agent@example.com"], {
    cwd: repo,
  });
}

function seedCommit(repo: string): void {
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "seed memory"], { cwd: repo });
}

/** v2 (root-marker) files carry both `name` and `description`. */
function v2File(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${name} block\n---\n\n${body}\n`;
}

/** v1 files live under system/ and carry only `description`. */
function v1File(body: string): string {
  return `---\ndescription: local block\n---\n\n${body}\n`;
}

/** The canonical local layout this fork creates: indexes and core memory at the root. */
function seedRootMarkerRepo(repo: string): void {
  initMemoryRepo(repo);
  writeFileSync(join(repo, "MEMORY.md"), "# Memory\n");
  writeFileSync(
    join(repo, "persona.md"),
    v2File("Persona", getPersonalityContent("memo")),
  );
  writeFileSync(join(repo, "human.md"), v2File("Human", "Old human.\n"));
  seedCommit(repo);
}

function seedLegacyRepo(repo: string): void {
  initMemoryRepo(repo);
  mkdirSync(join(repo, "system"), { recursive: true });
  writeFileSync(
    join(repo, "system", "persona.md"),
    v1File(getPersonalityContent("memo")),
  );
  writeFileSync(join(repo, "system", "human.md"), v1File("Old human.\n"));
  seedCommit(repo);
}

function useTemporaryLocalBackend(): string {
  storageDir = mkdtempSync(join(tmpdir(), "personality-layout-"));
  previousStorageDir = process.env[LOCAL_BACKEND_DIR_ENV];
  process.env[LOCAL_BACKEND_DIR_ENV] = storageDir;
  configureBackendMode("local");
  return getScopedMemoryFilesystemRoot(AGENT_ID);
}

afterEach(() => {
  configureBackendMode("api");
  if (previousStorageDir === undefined) {
    delete process.env[LOCAL_BACKEND_DIR_ENV];
  } else {
    process.env[LOCAL_BACKEND_DIR_ENV] = previousStorageDir;
  }
  previousStorageDir = undefined;
  if (storageDir) {
    rmSync(storageDir, { recursive: true, force: true });
    storageDir = "";
  }
});

describe("personality switch memory layout", () => {
  test("rewrites the root persona of a root-marker repo and commits it", async () => {
    const memoryDir = useTemporaryLocalBackend();
    seedRootMarkerRepo(memoryDir);

    const result = await applyPersonalityToMemory({
      agentId: AGENT_ID,
      personalityId: "kawaii",
    });

    expect(result.changed).toBe(true);
    expect(result.personaRelativePath).toBe("persona.md");
    expect(result.humanRelativePath).toBe("human.md");

    // The reported bug: an unindexed `system/` directory is rejected by the
    // repo's own pre-commit hook, so the switch left stray files behind.
    expect(existsSync(join(memoryDir, "system"))).toBe(false);

    const persona = readFileSync(join(memoryDir, "persona.md"), "utf8");
    expect(persona).toContain("name: Persona");
    expect(detectPersonalityFromPersonaFile(persona)).toBe("kawaii");
    expect(git(memoryDir, ["status", "--porcelain"]).trim()).toBe("");
  });

  test("creates a missing v2 core file with the frontmatter the hook requires", async () => {
    const memoryDir = useTemporaryLocalBackend();
    initMemoryRepo(memoryDir);
    writeFileSync(join(memoryDir, "MEMORY.md"), "# Memory\n");
    writeFileSync(
      join(memoryDir, "persona.md"),
      v2File("Persona", getPersonalityContent("memo")),
    );
    seedCommit(memoryDir);

    const result = await applyPersonalityToMemory({
      agentId: AGENT_ID,
      personalityId: "kawaii",
    });

    expect(result.changed).toBe(true);
    const human = readFileSync(join(memoryDir, "human.md"), "utf8");
    expect(human).toContain("name: Human");
    expect(human).toContain("description: ");
    expect(git(memoryDir, ["status", "--porcelain"]).trim()).toBe("");
  });

  test("keeps system/ paths for a legacy repo", async () => {
    const memoryDir = useTemporaryLocalBackend();
    seedLegacyRepo(memoryDir);

    const result = await applyPersonalityToMemory({
      agentId: AGENT_ID,
      personalityId: "kawaii",
    });

    expect(result.changed).toBe(true);
    expect(result.personaRelativePath).toBe("system/persona.md");
    expect(result.humanRelativePath).toBe("system/human.md");
    expect(existsSync(join(memoryDir, "persona.md"))).toBe(false);

    const persona = readFileSync(
      join(memoryDir, "system", "persona.md"),
      "utf8",
    );
    expect(detectPersonalityFromPersonaFile(persona)).toBe("kawaii");
    expect(git(memoryDir, ["status", "--porcelain"]).trim()).toBe("");
  });
});
