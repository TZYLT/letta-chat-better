import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveTelemetryAgentOrigin } from "@/telemetry/agent-origin";
import { telemetry } from "@/telemetry/index";

type TelemetryTestState = {
  currentAgentId: string | null;
  currentAgentOrigin: string | null;
};

const telemetryState = telemetry as unknown as TelemetryTestState;
const originalTelemetrySetting = process.env.LETTA_CODE_TELEM;

describe("telemetry agent origin", () => {
  beforeEach(() => {
    telemetryState.currentAgentId = null;
    telemetryState.currentAgentOrigin = null;
    process.env.LETTA_CODE_TELEM = "1";
  });

  afterEach(() => {
    if (originalTelemetrySetting === undefined) {
      delete process.env.LETTA_CODE_TELEM;
    } else {
      process.env.LETTA_CODE_TELEM = originalTelemetrySetting;
    }
  });

  test("maps only allowlisted agent tags to analytics values", () => {
    expect(
      resolveTelemetryAgentOrigin([
        "customer:private",
        "origin:claude-subconcious",
      ]),
    ).toBe("claude-subconscious");
    expect(
      resolveTelemetryAgentOrigin([
        "customer:private",
        "origin:unrecognized-product",
      ]),
    ).toBeUndefined();
  });

  test("keeps only the allowlisted origin after headless agent resolution", () => {
    telemetry.setCurrentAgent("agent-subconscious", [
      "customer:private",
      "origin:claude-subconcious",
    ]);

    expect(telemetryState.currentAgentId).toBe("agent-subconscious");
    expect(telemetryState.currentAgentOrigin).toBe("claude-subconscious");
    // Raw tags must not survive anywhere the boundary-error log could pick up.
    expect(JSON.stringify(telemetryState.currentAgentOrigin)).not.toContain(
      "customer:private",
    );
  });

  test("clears the origin when the agent is cleared", () => {
    telemetry.setCurrentAgent("agent-subconscious", [
      "origin:claude-subconcious",
    ]);
    telemetry.setCurrentAgent(null, null);

    expect(telemetryState.currentAgentId).toBeNull();
    expect(telemetryState.currentAgentOrigin).toBeNull();
  });
});
