import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { detectPackageManager } from "@/utils/package-manager-detect";

describe("detectPackageManager", () => {
  let originalArgv1: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalArgv1 = process.argv[1] || "";
    originalEnv = process.env.LETTA_PACKAGE_MANAGER;
    delete process.env.LETTA_PACKAGE_MANAGER;
  });

  afterEach(() => {
    process.argv[1] = originalArgv1;
    if (originalEnv !== undefined) {
      process.env.LETTA_PACKAGE_MANAGER = originalEnv;
    } else {
      delete process.env.LETTA_PACKAGE_MANAGER;
    }
  });

  test("detects bun from path containing /.bun/", () => {
    process.argv[1] =
      "/Users/test/.bun/install/global/node_modules/@letta-ai/letta-code/dist/index.js";
    expect(detectPackageManager()).toBe("bun");
  });

  test("detects pnpm from path containing /.pnpm/", () => {
    process.argv[1] =
      "/Users/test/.local/share/pnpm/global/5/.pnpm/@letta-ai+letta-code@0.14.11/node_modules/@letta-ai/letta-code/dist/index.js";
    expect(detectPackageManager()).toBe("pnpm");
  });

  test("detects pnpm from path containing /pnpm/", () => {
    process.argv[1] =
      "/Users/test/.local/share/pnpm/global/node_modules/@letta-ai/letta-code/dist/index.js";
    expect(detectPackageManager()).toBe("pnpm");
  });

  test("defaults to npm for standard nvm path", () => {
    process.argv[1] =
      "/Users/test/.nvm/versions/node/v20.10.0/lib/node_modules/@letta-ai/letta-code/dist/index.js";
    expect(detectPackageManager()).toBe("npm");
  });

  test("defaults to npm for standard npm global path", () => {
    process.argv[1] =
      "/usr/local/lib/node_modules/@letta-ai/letta-code/dist/index.js";
    expect(detectPackageManager()).toBe("npm");
  });

  test("detects bun from Windows-style path", () => {
    process.argv[1] =
      "C:\\Users\\test\\.bun\\install\\global\\node_modules\\@letta-ai\\letta-code\\dist\\index.js";
    expect(detectPackageManager()).toBe("bun");
  });

  test("LETTA_PACKAGE_MANAGER override returns specified PM", () => {
    process.env.LETTA_PACKAGE_MANAGER = "bun";
    // Even with an npm-style path, env var wins
    process.argv[1] =
      "/usr/local/lib/node_modules/@letta-ai/letta-code/dist/index.js";
    expect(detectPackageManager()).toBe("bun");
  });

  test("invalid LETTA_PACKAGE_MANAGER falls back to path detection", () => {
    process.env.LETTA_PACKAGE_MANAGER = "invalid";
    process.argv[1] =
      "/Users/test/.bun/install/global/node_modules/@letta-ai/letta-code/dist/index.js";
    expect(detectPackageManager()).toBe("bun");
  });

  test("invalid LETTA_PACKAGE_MANAGER with npm path falls back to npm", () => {
    process.env.LETTA_PACKAGE_MANAGER = "yarn";
    process.argv[1] =
      "/usr/local/lib/node_modules/@letta-ai/letta-code/dist/index.js";
    expect(detectPackageManager()).toBe("npm");
  });
});
