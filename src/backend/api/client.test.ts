import { afterEach, describe, expect, test } from "bun:test";
import { getClientDefaultHeaders } from "./client";
import { getHaruyukiHeaders } from "./http-headers";

const RUNTIME_ENVIRONMENT_DEVICE_ID_ENV =
  "HARUYUKI_RUNTIME_ENVIRONMENT_DEVICE_ID";
const originalRuntimeEnvironmentDeviceId =
  process.env[RUNTIME_ENVIRONMENT_DEVICE_ID_ENV];

afterEach(() => {
  if (originalRuntimeEnvironmentDeviceId === undefined) {
    delete process.env[RUNTIME_ENVIRONMENT_DEVICE_ID_ENV];
  } else {
    process.env[RUNTIME_ENVIRONMENT_DEVICE_ID_ENV] =
      originalRuntimeEnvironmentDeviceId;
  }
});

describe("getClientDefaultHeaders", () => {
  test("uses the managed runtime device identity for environment attribution", () => {
    process.env[RUNTIME_ENVIRONMENT_DEVICE_ID_ENV] = "  sandbox-agent-test  ";

    expect(getClientDefaultHeaders()["X-Letta-Environment-Device-Id"]).toBe(
      "sandbox-agent-test",
    );
  });
});

describe("getHaruyukiHeaders", () => {
  test("sends only the API key and source identity", () => {
    expect(getHaruyukiHeaders("test-key")).toMatchObject({
      Authorization: "Bearer test-key",
      "X-Letta-Source": "letta-code",
    });
  });
});
