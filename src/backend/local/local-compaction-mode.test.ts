import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_DEFAULT_COMPACTION_MODE } from "@/backend/local/compaction";
import { LocalBackend } from "@/backend/local/local-backend";

describe("local compaction mode", () => {
  test("converges on sliding_window", () => {
    expect(LOCAL_DEFAULT_COMPACTION_MODE).toBe("sliding_window");
  });

  test("rejects writes of the removed all mode", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-compaction-mode-"));
    try {
      const backend = new LocalBackend({ storageDir, memfsEnabled: false });
      const agent = await backend.createAgent({
        name: "Compaction Mode",
        model: "openai/gpt-5.5",
      } as never);

      await expect(
        backend.updateAgent(agent.id, {
          compaction_settings: { mode: "all" },
        } as never),
      ).rejects.toThrow(
        'Local backend compaction supports only the "sliding_window" mode',
      );

      const updated = await backend.updateAgent(agent.id, {
        compaction_settings: { mode: "sliding_window" },
      } as never);
      expect(updated).toMatchObject({
        compaction_settings: { mode: "sliding_window" },
      });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
