import { afterEach, describe, expect, test } from "bun:test";
import { extractInputChannel, messageChannelTelemetry } from "./channel";
import { telemetry } from "./index";

const state = telemetry as unknown as { messageCount: number };
const originalMessageCount = state.messageCount;
const originalSetting = process.env.HARUYUKI_CODE_TELEM;
afterEach(() => {
  state.messageCount = originalMessageCount;
  if (originalSetting === undefined) delete process.env.HARUYUKI_CODE_TELEM;
  else process.env.HARUYUKI_CODE_TELEM = originalSetting;
});

const notification = (channel: string) =>
  `<channel-notification source="${channel}" sender_name="Private Name">\nprivate message\n</channel-notification>`;

describe("channel telemetry", () => {
  test("recognizes incoming channel labels without copying content", () => {
    for (const channel of ["slack", "microsoftTeams", "telegram"]) {
      expect(extractInputChannel(notification(channel))).toBe(channel);
    }
    expect(
      extractInputChannel(
        `<system-reminder>context</system-reminder>\n${notification("slack")}`,
      ),
    ).toBe("slack");
    expect(extractInputChannel(notification("private-custom-id"))).toBe(
      "other",
    );
    expect(extractInputChannel("normal user input")).toBeUndefined();
    expect(
      extractInputChannel(`Example: \`${notification("slack")}\``),
    ).toBeUndefined();
    expect(
      extractInputChannel(`\`\`\`xml\n${notification("slack")}\n\`\`\``),
    ).toBeUndefined();
  });

  test("counts a batched message once and never retains its content", () => {
    expect(
      extractInputChannel(`${notification("slack")}\n${notification("slack")}`),
    ).toBe("slack");
    expect(
      extractInputChannel(
        `${notification("slack")}\n${notification("telegram")}`,
      ),
    ).toBe("mixed");

    const before = state.messageCount;
    process.env.HARUYUKI_CODE_TELEM = "1";
    telemetry.trackUserInput(
      `${notification("slack")}\n${notification("slack")}`,
      "user",
      "model-1",
    );
    telemetry.trackUserInput("ordinary input", "user", "model-1");

    expect(state.messageCount).toBe(before + 2);
    // The event payload that used to carry the channel label is gone. The only
    // channel surface left is the pure extractor plus the local error log, and
    // neither one receives message content.
    expect(JSON.stringify(telemetry)).not.toContain("private message");
    expect(JSON.stringify(telemetry)).not.toContain("Private Name");
  });

  test("only retains channel and action from outgoing arguments", () => {
    expect(
      messageChannelTelemetry({
        channel: "slack",
        action: "send",
        message: "secret",
        chat_id: "private-id",
      }),
    ).toEqual({ channel: "slack", channel_action: "send" });
    expect(
      messageChannelTelemetry({ channel: "microsoftTeams", action: "react" }),
    ).toEqual({
      channel: "microsoftTeams",
      channel_action: "react",
    });
    expect(
      messageChannelTelemetry({
        channel: "private-name",
        action: "private-action",
      }),
    ).toEqual({
      channel: "other",
      channel_action: "other",
    });
    expect(messageChannelTelemetry({})).toEqual({
      channel: undefined,
      channel_action: undefined,
    });
  });
});
