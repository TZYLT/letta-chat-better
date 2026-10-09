import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { addTask } from "@/cron";
import { resolveTaskName } from "./cron-task-ref";

/**
 * Name resolution for `haruyuki cron get`/`delete` (LET-10492).
 *
 * These tests exercise the device-local store, which never touches the network.
 * The Cloud schedule inventory this resolver used to search was removed with
 * the rest of the Cloud surface.
 */

const TEST_DIR = path.join(import.meta.dir, "__cron_task_ref_test_tmp__");

const origHome = process.env.HARUYUKI_HOME;
const origXdg = process.env.XDG_CONFIG_HOME;

beforeEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.HARUYUKI_HOME = TEST_DIR;
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  if (origHome) process.env.HARUYUKI_HOME = origHome;
  else delete process.env.HARUYUKI_HOME;
  if (origXdg) process.env.XDG_CONFIG_HOME = origXdg;
  else delete process.env.XDG_CONFIG_HOME;
});

function addNamedTask(name: string): string {
  const result = addTask({
    agent_id: "agent-local-test",
    conversation_id: "default",
    name,
    description: `task ${name}`,
    cron: "*/5 * * * *",
    recurring: true,
    prompt: "do the thing",
  });
  return result.task.id;
}

describe("resolveTaskName", () => {
  test("resolves a unique name to its task id", () => {
    const id = addNamedTask("nightly-report");

    expect(resolveTaskName("nightly-report")).toEqual({ id, store: "local" });
  });

  test("returns null when no task has the name", () => {
    addNamedTask("nightly-report");

    expect(resolveTaskName("does-not-exist")).toBeNull();
  });

  test("reports ambiguity when multiple tasks share the name", () => {
    const first = addNamedTask("dup-name");
    const second = addNamedTask("dup-name");

    expect(resolveTaskName("dup-name")).toEqual({
      ambiguous: [
        { id: first, store: "local" },
        { id: second, store: "local" },
      ],
    });
  });

  test("does not match task ids as names", () => {
    const id = addNamedTask("some-task");

    // The resolver is name-only; ID addressing is the caller's first pass.
    expect(resolveTaskName(id)).toBeNull();
  });
});
