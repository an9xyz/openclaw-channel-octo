import { describe, expect, it } from "vitest";
import { enqueueInbound, getInboundQueueKey } from "./inbound-queue.js";
import { ChannelType, MessageType, type BotMessage } from "./types.js";

function message(channelId: string, channelType: ChannelType): BotMessage {
  return {
    message_id: "m1",
    message_seq: 1,
    from_uid: "u1",
    channel_id: channelId,
    channel_type: channelType,
    timestamp: 1,
    payload: { type: MessageType.Text, content: "hello" },
  };
}

describe("shared inbound queue", () => {
  it("账号和频道共同隔离队列 key，Thread 保留完整 channel_id", () => {
    expect(getInboundQueueKey("Bot-A", message("g1", ChannelType.Group)))
      .toBe("bot-a:group:g1");
    expect(getInboundQueueKey("Bot-A", message("g1____t1", ChannelType.CommunityTopic)))
      .toBe("bot-a:group:g1____t1");
    expect(getInboundQueueKey("Bot-B", message("g1", ChannelType.Group)))
      .toBe("bot-b:group:g1");
    expect(getInboundQueueKey("Bot-A", message("s123_u1@bot", ChannelType.DM)))
      .toBe("bot-a:dm:123:u1");
    expect(getInboundQueueKey("Bot-A", { ...message("u1", ChannelType.DM), channel_id: undefined }))
      .toBe("bot-a:dm:u1");
  });

  it("同一 key 串行执行，并返回当前任务完成的 Promise", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = enqueueInbound("a:group:g1", async () => {
      order.push("first:start");
      await firstGate;
      order.push("first:end");
    });
    const second = enqueueInbound("a:group:g1", async () => {
      order.push("second");
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("前一个任务失败后仍执行后续任务", async () => {
    const order: string[] = [];
    const first = enqueueInbound("a:dm:u1", async () => {
      order.push("failed");
      throw new Error("boom");
    });
    const second = enqueueInbound("a:dm:u1", async () => {
      order.push("next");
    });

    await expect(first).rejects.toThrow("boom");
    await second;
    expect(order).toEqual(["failed", "next"]);
  });

  it("向调用方返回当前任务的实际结果", async () => {
    await expect(enqueueInbound("a:dm:u1", async () => "completed" as const))
      .resolves.toBe("completed");
  });
});
