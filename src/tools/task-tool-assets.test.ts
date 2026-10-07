import { afterEach, describe, expect, test } from "bun:test";
import TaskDescriptionRaw from "./descriptions/Task.md";
import type { JsonSchema } from "./model-facing-tool";
import TaskSchema from "./schemas/Task.json";
import {
  stripComputerFromTaskDescription,
  stripComputerFromTaskSchema,
} from "./task-tool-assets";

const taskSchema = TaskSchema as JsonSchema;
const taskDescription = (TaskDescriptionRaw as string).trim();

describe("stripComputerFromTaskSchema", () => {
  test("removes the computer property from the real Task schema", () => {
    expect(taskSchema.properties?.computer).toBeDefined();
    const stripped = stripComputerFromTaskSchema(taskSchema);
    expect(stripped.properties?.computer).toBeUndefined();
    expect(stripped.properties?.prompt).toBeDefined();
    expect(stripped.properties?.subagent_type).toBeDefined();
    expect(stripped.required).toEqual(taskSchema.required);
  });

  test("does not mutate the input schema", () => {
    stripComputerFromTaskSchema(taskSchema);
    expect(taskSchema.properties?.computer).toBeDefined();
  });

  test("returns schemas without a computer property unchanged", () => {
    const schema: JsonSchema = { properties: { prompt: { type: "string" } } };
    expect(stripComputerFromTaskSchema(schema)).toBe(schema);
  });
});

describe("stripComputerFromTaskDescription", () => {
  test("removes the Running on Another Computer section from the real description", () => {
    expect(taskDescription).toContain("## Running on Another Computer");
    const stripped = stripComputerFromTaskDescription(taskDescription);
    expect(stripped).not.toContain("## Running on Another Computer");
    expect(stripped).not.toContain("computer:");
    expect(stripped).not.toContain("`computer`");
  });

  test("keeps the surrounding sections intact", () => {
    const stripped = stripComputerFromTaskDescription(taskDescription);
    expect(stripped).toContain("## Forking Parent Context");
    expect(stripped).toContain("## Concurrency and Safety:");
    expect(stripped).not.toContain("\n\n\n");
  });

  test("returns descriptions without the section unchanged", () => {
    const description = "## Intro\n\nBody text.";
    expect(stripComputerFromTaskDescription(description)).toBe(description);
  });
});

describe("task() computer guard", () => {
  test("task.ts rejects computer args before spawning", async () => {
    const source = await Bun.file(
      new URL("./impl/task.ts", import.meta.url),
    ).text();
    const guardIndex = source.indexOf(
      "The computer option requires a Letta Cloud backend",
    );
    const launchStart = source.indexOf("export async function launchSubagent(");
    const spawnIndex = source.indexOf(
      "spawnBackgroundSubagentTask({",
      launchStart,
    );
    expect(guardIndex).toBeGreaterThan(-1);
    expect(spawnIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(spawnIndex);
    // The guard is unconditional now: no backend in the product can route to a
    // connected computer, so there is no capability left to consult.
    expect(source).not.toContain("capabilities.remoteMemfs");
  });
});

describe("resolveBackendSpecificToolAssets Task dispatch", () => {
  const originalBaseUrl = process.env.LETTA_BASE_URL;

  afterEach(() => {
    if (originalBaseUrl === undefined) {
      delete process.env.LETTA_BASE_URL;
    } else {
      process.env.LETTA_BASE_URL = originalBaseUrl;
    }
  });

  test("strips computer for a non-cloud server", async () => {
    process.env.LETTA_BASE_URL = "http://localhost:8283";
    const { resolveBackendSpecificToolAssets } = await import(
      "./task-tool-assets"
    );
    const resolved = await resolveBackendSpecificToolAssets(
      "Task",
      taskDescription,
      taskSchema,
    );
    expect(resolved.inputSchema.properties?.computer).toBeUndefined();
    expect(resolved.description).not.toContain(
      "## Running on Another Computer",
    );
  });

  // "keeps computer for a server-backed backend" was deleted with the guard it
  // exercised: it installed a `remoteMemfs: true` fixture to reach a branch that
  // no backend can reach any more.
});
