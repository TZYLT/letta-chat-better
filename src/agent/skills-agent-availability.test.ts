import { describe, expect, test } from "bun:test";
import { isSkillAvailableForAgent, type Skill } from "@/agent/skills";

const baseSkill: Skill = {
  id: "base",
  name: "Base",
  description: "Base skill",
  path: "/tmp/base/SKILL.md",
  source: "bundled",
};

describe("isSkillAvailableForAgent", () => {
  test("offers a bundled skill to local and Cloud agents alike", () => {
    const skill: Skill = { ...baseSkill, id: "curating-memory-palace" };
    expect(isSkillAvailableForAgent(skill, "agent-local-123")).toBe(true);
    expect(isSkillAvailableForAgent(skill, "agent-123")).toBe(true);
    expect(isSkillAvailableForAgent(skill, undefined)).toBe(true);
  });

  test("offers a project override of the same skill", () => {
    const skill: Skill = {
      ...baseSkill,
      id: "curating-memory-palace",
      source: "project",
    };
    expect(isSkillAvailableForAgent(skill, "agent-local-123")).toBe(true);
  });
});
