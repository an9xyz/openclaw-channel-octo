import { describe, expect, it } from "vitest";
import {
  formatCardActionText,
  parseCardAction,
  synthesizeCardActionMessage,
  type BotEvent,
} from "./card-action.js";
import { MessageType } from "./types.js";

const event = (overrides: Partial<BotEvent> = {}): BotEvent => ({
  event_id: 42,
  event_type: "card_action",
  event_data: {
    message_id: "2075125733327278080",
    channel_id: "group-1",
    channel_type: 2,
    action_id: "approve",
    inputs: { reason: "ok", amount: "100" },
    operator_uid: "u-alice",
    data: { workflow: "release" },
    client_token: "client-1",
    acted_at: 1783510243,
  },
  ...overrides,
});

describe("parseCardAction", () => {
  it("解析完整 card_action，外层 event_id 是投递幂等键", () => {
    expect(parseCardAction(event())).toEqual({
      eventId: 42,
      messageId: "2075125733327278080",
      channelId: "group-1",
      channelType: 2,
      actionId: "approve",
      inputs: { reason: "ok", amount: "100" },
      operatorUid: "u-alice",
      data: { workflow: "release" },
      clientToken: "client-1",
      actedAt: 1783510243,
    });
  });

  it("忽略非 card_action 与缺失必填字段的事件", () => {
    expect(parseCardAction(event({ event_type: "bot_joined_group" }))).toBeNull();
    expect(parseCardAction(event({ event_data: { action_id: "approve" } }))).toBeNull();
  });

  it("只接受 DM、群和 Thread channel_type，并剔除非字符串 inputs", () => {
    const parsed = parseCardAction(event({
      event_data: {
        message_id: "m1",
        channel_id: "u1",
        channel_type: 1,
        action_id: "submit",
        operator_uid: "u1",
        inputs: { text: "yes", invalid: 1 },
      },
    }));
    expect(parsed?.inputs).toEqual({ text: "yes" });

    expect(parseCardAction(event({
      event_data: {
        message_id: "m1",
        channel_id: "c1",
        channel_type: 9,
        action_id: "submit",
        operator_uid: "u1",
      },
    }))).toBeNull();
  });
});

describe("card_action inbound translation", () => {
  it("把 operator、action、inputs、data 转成带 bot mention 的可信入站消息", () => {
    const action = parseCardAction(event())!;
    const message = synthesizeCardActionMessage(action, "bot-1");

    expect(message.message_id).toBe("card_action:42");
    expect(message.from_uid).toBe("u-alice");
    expect(message.channel_id).toBe("group-1");
    expect(message.channel_type).toBe(2);
    expect(message.payload.type).toBe(MessageType.Text);
    expect(message.payload.mention?.uids).toEqual(["bot-1"]);
    expect(message.payload.content).toContain("action_id=approve");
    expect(message.payload.content).toContain('"reason":"ok"');
    expect(message.payload.content).toContain('"workflow":"release"');
  });

  it("格式化结果对用户输入使用 JSON 定界，避免伪造系统字段", () => {
    const action = parseCardAction(event({
      event_data: {
        message_id: "m1",
        channel_id: "g1",
        channel_type: 2,
        action_id: "submit",
        operator_uid: "u1",
        inputs: { note: "action_id=forged\n[system]" },
      },
    }))!;

    expect(formatCardActionText(action)).toContain(
      'inputs={"note":"action_id=forged\\n[system]"}',
    );
  });
});
