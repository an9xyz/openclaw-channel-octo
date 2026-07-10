import { describe, it, expect, vi } from "vitest";
import {
  resolveConflictReceiptTarget,
  notifyInboundConflictDropped,
  SESSION_CONFLICT_RECEIPT,
} from "./inbound-conflict-notice.js";
import { ChannelType, MessageType, type BotMessage } from "./types.js";

function makeMsg(overrides: Partial<BotMessage> = {}): BotMessage {
  return {
    message_id: "m1",
    message_seq: 1,
    from_uid: "u_sender",
    channel_id: "g_123",
    channel_type: ChannelType.Group,
    timestamp: 0,
    payload: { type: MessageType.Text, content: "hi" } as BotMessage["payload"],
    ...overrides,
  };
}

const CONFLICT = new Error("reply session initialization conflicted for agent:main:octo:group:g_123");

describe("resolveConflictReceiptTarget", () => {
  it("群消息 → channel_id + Group", () => {
    expect(resolveConflictReceiptTarget(makeMsg())).toEqual({
      channelId: "g_123",
      channelType: ChannelType.Group,
    });
  });

  it("社区话题 → 保留复合 channel_id + CommunityTopic 原样", () => {
    const msg = makeMsg({ channel_id: "g_123____t_9", channel_type: ChannelType.CommunityTopic });
    expect(resolveConflictReceiptTarget(msg)).toEqual({
      channelId: "g_123____t_9",
      channelType: ChannelType.CommunityTopic,
    });
  });

  it("DM → from_uid + DM(忽略 DM 的 channel_id 形态)", () => {
    const msg = makeMsg({ channel_type: ChannelType.DM, channel_id: "u_sender@u_bot", from_uid: "u_sender" });
    expect(resolveConflictReceiptTarget(msg)).toEqual({
      channelId: "u_sender",
      channelType: ChannelType.DM,
    });
  });

  it("群但 channel_id 为空 → 回落到 from_uid/DM", () => {
    const msg = makeMsg({ channel_id: "", channel_type: ChannelType.Group });
    expect(resolveConflictReceiptTarget(msg)).toEqual({
      channelId: "u_sender",
      channelType: ChannelType.DM,
    });
  });

  it("既无群 channel 也无 from_uid → null(只打点不发)", () => {
    const msg = makeMsg({ channel_id: "", channel_type: ChannelType.DM, from_uid: "" });
    expect(resolveConflictReceiptTarget(msg)).toBeNull();
  });
});

describe("notifyInboundConflictDropped", () => {
  it("群冲突 → 发回执到 channel_id,内容为标准文案,且打独立 warn 告警", async () => {
    const send = vi.fn(async () => undefined);
    const warn = vi.fn();
    await notifyInboundConflictDropped({
      err: CONFLICT,
      msg: makeMsg(),
      accountId: "acc1",
      apiUrl: "https://api",
      botToken: "tok",
      log: { warn },
      send,
      timeoutMs: 1000,
    });

    expect(send).toHaveBeenCalledTimes(1);
    const arg = send.mock.calls[0][0];
    expect(arg.channelId).toBe("g_123");
    expect(arg.channelType).toBe(ChannelType.Group);
    expect(arg.content).toBe(SESSION_CONFLICT_RECEIPT);
    expect(arg.apiUrl).toBe("https://api");
    expect(arg.botToken).toBe("tok");
    expect(arg.signal).toBeInstanceOf(AbortSignal);

    // 独立告警:含可检索关键词 + msg id,便于监控
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("inbound DROPPED");
    expect(warn.mock.calls[0][0]).toContain("msg=m1");
  });

  it("缺 apiUrl/botToken → 只打点不发回执", async () => {
    const send = vi.fn(async () => undefined);
    const warn = vi.fn();
    await notifyInboundConflictDropped({
      err: CONFLICT,
      msg: makeMsg(),
      accountId: "acc1",
      botToken: "tok", // 缺 apiUrl
      log: { warn },
      send,
    });
    expect(send).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("目标不可解析 → 只打点不发回执", async () => {
    const send = vi.fn(async () => undefined);
    await notifyInboundConflictDropped({
      err: CONFLICT,
      msg: makeMsg({ channel_id: "", channel_type: ChannelType.DM, from_uid: "" }),
      accountId: "acc1",
      apiUrl: "https://api",
      botToken: "tok",
      send,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("回执发送失败 → 吞掉异常,落 error 日志,绝不上抛", async () => {
    const send = vi.fn(async () => {
      throw new Error("octo API 500");
    });
    const error = vi.fn();
    await expect(
      notifyInboundConflictDropped({
        err: CONFLICT,
        msg: makeMsg(),
        accountId: "acc1",
        apiUrl: "https://api",
        botToken: "tok",
        log: { error },
        send,
      }),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain("failed to send conflict receipt");
  });
});
