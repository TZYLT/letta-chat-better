import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testSetBackend, getBackend } from "@/backend";
import { type BackendMode, resolveBackendMode } from "@/backend/backend-mode";
import { LOCAL_BACKEND_DIR_ENV } from "@/backend/local/paths";
import {
  createStartupAgentPickerHandler,
  getStartupBackendLookupOrder,
  inferBackendModeFromAgentId,
  resolveSubcommandBackendMode,
  switchBackendForSelectedStartupAgent,
} from "@/cli/startup-backend-mode";

describe("startup backend mode inference", () => {
  test("local agent IDs name the local backend", () => {
    expect(inferBackendModeFromAgentId("agent-local-abc")).toBe("local");
  });

  test("cloud-shaped agent IDs name no backend", () => {
    // These used to resolve to "api" and select the API backend. That backend
    // is gone, so the id must not pin the lookup to a namespace nobody serves.
    expect(inferBackendModeFromAgentId("agent-abc")).toBeUndefined();
  });

  test("missing agent IDs do not infer a backend", () => {
    expect(inferBackendModeFromAgentId(null)).toBeUndefined();
    expect(inferBackendModeFromAgentId(undefined)).toBeUndefined();
  });

  test("lookup order always walks both pin namespaces, local first", () => {
    // `--backend local` used to collapse this to ["local"] and silently drop
    // Cloud-shaped pins the user had already stored.
    expect(getStartupBackendLookupOrder()).toEqual(["local", "api"]);
  });

  test("subcommands configure local for a saved local preference", () => {
    expect(
      resolveSubcommandBackendMode({
        savedBackendMode: "local",
        baseURL: "https://api.letta.com",
        cloudBaseURL: "https://api.letta.com",
      }),
    ).toBe("local");
  });

  test("subcommands configure nothing when there is no usable preference", () => {
    expect(
      resolveSubcommandBackendMode({
        baseURL: "https://api.letta.com",
        cloudBaseURL: "https://api.letta.com",
      }),
    ).toBeUndefined();

    // A saved API preference no longer names a backend to configure.
    expect(
      resolveSubcommandBackendMode({
        savedBackendMode: "api",
        baseURL: "https://api.letta.com",
        cloudBaseURL: "https://api.letta.com",
      }),
    ).toBeUndefined();
  });

  test("a local env selection wins over every saved preference", () => {
    expect(
      resolveSubcommandBackendMode({
        envBackendMode: "local",
        savedBackendMode: "api",
        baseURL: "https://api.letta.com",
        cloudBaseURL: "https://api.letta.com",
      }),
    ).toBe("local");
    expect(
      resolveSubcommandBackendMode({
        envBackendMode: "local",
        baseURL: "http://localhost:8283",
        cloudBaseURL: "https://api.letta.com",
      }),
    ).toBe("local");
  });

  test("a custom API base URL makes a saved local preference inapplicable", () => {
    expect(
      resolveSubcommandBackendMode({
        savedBackendMode: "local",
        baseURL: "http://localhost:8283",
        cloudBaseURL: "https://api.letta.com",
      }),
    ).toBeUndefined();
  });
});

describe("startup picker backend selection", () => {
  let storageDir: string;
  let originalStorageDir: string | undefined;
  let originalBackend: ReturnType<typeof getBackend>;

  beforeEach(async () => {
    originalStorageDir = process.env[LOCAL_BACKEND_DIR_ENV];
    originalBackend = getBackend();
    storageDir = await mkdtemp(join(tmpdir(), "letta-startup-pin-"));
    process.env[LOCAL_BACKEND_DIR_ENV] = storageDir;
  });

  afterEach(async () => {
    if (originalStorageDir === undefined) {
      delete process.env[LOCAL_BACKEND_DIR_ENV];
    } else {
      process.env[LOCAL_BACKEND_DIR_ENV] = originalStorageDir;
    }
    __testSetBackend(originalBackend);
    await rm(storageDir, { recursive: true, force: true });
  });

  test("a local pin opens and stays on the local backend", async () => {
    const agentId = "agent-local-startup-pin";
    const agentsDir = join(storageDir, "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, `${Buffer.from(agentId).toString("base64url")}.json`),
      JSON.stringify({
        id: agentId,
        name: "Pinned Local Agent",
        system: "",
        tags: [],
        model: "local/default",
        model_settings: {},
      }),
    );

    const selectedAgentIds: string[] = [];
    let ready = false;
    const onSelect = createStartupAgentPickerHandler(
      (selected) => {
        expect(resolveBackendMode()).toBe("local");
        selectedAgentIds.push(selected);
      },
      () => {
        ready = true;
      },
      (message) => {
        throw new Error(message);
      },
    );
    await onSelect(agentId);

    expect(ready).toBe(true);
    expect(selectedAgentIds).toEqual([agentId]);
    expect(resolveBackendMode()).toBe("local");
    expect((await getBackend().retrieveAgent(agentId)).name).toBe(
      "Pinned Local Agent",
    );
  });

  test("selecting a pin is always ready, whatever the pin has migrated to", () => {
    // The handler used to consult a `tryConfigureLocal` hook that could report
    // "needs migration"; that path fell back to the API backend and is gone, so
    // the picker has nothing left to fail on.
    expect(
      switchBackendForSelectedStartupAgent("agent-local-unavailable"),
    ).toBe(true);
  });

  test("both pin namespaces stay reachable through the lookup order", () => {
    const order: BackendMode[] = getStartupBackendLookupOrder();
    expect(order).toContain("local");
    expect(order).toContain("api");
    expect(order[0]).toBe("local");
  });
});
