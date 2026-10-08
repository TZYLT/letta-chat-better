import { expect, test } from "bun:test";
import { SUBAGENT_LAUNCH_PROFILE_ENV } from "@/utils/subagent-launch-marker";
import {
  composeSubagentChildEnv,
  shouldLaunchThroughListener,
} from "./subagent-launcher";

test("only an explicit computer route sends a child through a listener", () => {
  expect(
    shouldLaunchThroughListener({
      launchProfile: "default",
      computer: "cloud",
    }),
  ).toBe(true);
  expect(
    shouldLaunchThroughListener({
      launchProfile: "default",
      computer: "remote",
    }),
  ).toBe(true);
  expect(shouldLaunchThroughListener({ launchProfile: "default" })).toBe(false);
});

test("ephemeral launches stay local and reject explicit computer routing", () => {
  expect(shouldLaunchThroughListener({ ephemeral: true })).toBe(false);
  expect(() =>
    shouldLaunchThroughListener({ computer: "cloud", ephemeral: true }),
  ).toThrow("Ephemeral conversations");
});

test("memory workers remain confined processes, without a listener route", () => {
  const env = composeSubagentChildEnv({
    parentProcessEnv: {},
    subagentType: "memory",
    parentAgentId: "agent-parent",
    launchProfile: "memory-subagent",
    inheritedPrimaryRoot: "/memory",
  });
  expect(env[SUBAGENT_LAUNCH_PROFILE_ENV]).toBe("memory-subagent");
  expect(env.MEMORY_DIR).toBe("/memory");
  expect(
    shouldLaunchThroughListener({ launchProfile: "memory-subagent" }),
  ).toBe(false);
  expect(() =>
    shouldLaunchThroughListener({
      computer: "cloud",
      launchProfile: "memory-subagent",
    }),
  ).toThrow("confined local process");
});

test("an ordinary child's caller routes it without changing the parent's environment", () => {
  const parentProcessEnv = { USER_CWD: "/workspace" };
  const env = composeSubagentChildEnv({
    parentProcessEnv,
    subagentType: "general-purpose",
    parentAgentId: "agent-parent",
    inheritedPrimaryRoot: null,
    launchProfile: "default",
  });
  expect(parentProcessEnv).toEqual({ USER_CWD: "/workspace" });
  expect(env.USER_CWD).toBe("/workspace");
});
