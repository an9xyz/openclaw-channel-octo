import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./accounts.js", () => ({
  listOctoAccountIds: vi.fn(),
  resolveOctoAccount: vi.fn(),
}));
vi.mock("./api-fetch.js", () => ({
  getCardProfile: vi.fn(),
  sendCardMessage: vi.fn(),
  sendMessage: vi.fn(),
}));
vi.mock("./card-session.js", () => ({ registerCardSession: vi.fn() }));

import { createInteractiveCardTool } from "./card-tool.js";
import { listOctoAccountIds, resolveOctoAccount } from "./accounts.js";
import { getCardProfile, sendCardMessage, sendMessage } from "./api-fetch.js";
import { registerCardSession } from "./card-session.js";

const cfg = { channels: { octo: { botToken: "tok" } } } as never;
const deliveryContext = { channel: "octo", to: "group:g1", accountId: "default" };

function setup(): void {
  vi.mocked(listOctoAccountIds).mockReturnValue(["default"]);
  vi.mocked(resolveOctoAccount).mockReturnValue({
    accountId: "default",
    enabled: true,
    configured: true,
    config: {
      botToken: "tok",
      apiUrl: "https://api.test",
      pollIntervalMs: 2000,
      heartbeatIntervalMs: 30000,
    },
  } as never);
  vi.mocked(getCardProfile).mockResolvedValue({
    available: true,
    enabled: true,
    profiles: ["octo/v1", "octo/v2"],
    card_version: "1.5",
    elements: ["TextBlock"],
    inputs: ["Input.Text"],
    actions: ["Action.Submit"],
    limits: { max_nodes: 20, max_depth: 8, max_payload_bytes: 16384 },
  });
  vi.mocked(sendCardMessage).mockResolvedValue({ message_id: "m1" } as never);
  vi.mocked(sendMessage).mockResolvedValue({ message_id: "fallback" } as never);
}

function tool(context: typeof deliveryContext | null = deliveryContext) {
  const tools = createInteractiveCardTool({
    cfg,
    agentAccountId: "default",
    sessionKey: "session-1",
    deliveryContext: context ?? undefined,
    messageChannel: context?.channel,
  } as never);
  expect(tools).toHaveLength(1);
  return tools[0];
}

describe("octo_send_card", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setup();
  });

  it("cardInteraction:false 时 discovery 不暴露工具", () => {
    vi.mocked(resolveOctoAccount).mockReturnValue({
      accountId: "default",
      enabled: true,
      configured: true,
      config: {
        botToken: "tok",
        apiUrl: "https://api.test",
        pollIntervalMs: 2000,
        heartbeatIntervalMs: 30000,
        cardInteraction: false,
      },
    } as never);
    expect(createInteractiveCardTool({ cfg, agentAccountId: "default", deliveryContext } as never)).toEqual([]);
  });

  it("schema 不暴露 channelId/accountId，成功发送 v2 后登记 session", async () => {
    const current = tool();
    const schema = current.parameters as { properties: Record<string, unknown> };
    expect(schema.properties.channelId).toBeUndefined();
    expect(schema.properties.accountId).toBeUndefined();

    const result = await current.execute("call-1", {
      title: "确认发布",
      buttons: [{ id: "approve", label: "批准" }],
      channelId: "group:attacker",
    });

    expect(sendCardMessage).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "g1",
      profile: "octo/v2",
    }));
    expect(registerCardSession).toHaveBeenCalledWith("m1", expect.objectContaining({
      sessionKey: "session-1",
      accountId: "default",
      channelId: "g1",
    }));
    expect(result.details).toEqual(expect.objectContaining({ sent: true, message_id: "m1" }));
  });

  it("服务端不支持 octo/v2 时降级为当前会话纯文本，不登记 session", async () => {
    vi.mocked(getCardProfile).mockResolvedValue({
      available: true,
      enabled: true,
      profiles: ["octo/v1"],
      card_version: "1.5",
    });
    const result = await tool().execute("call-2", {
      title: "选择环境",
      buttons: [{ id: "prod", label: "生产" }, { id: "test", label: "测试" }],
    });

    expect(sendCardMessage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ channelId: "g1" }));
    expect(registerCardSession).not.toHaveBeenCalled();
    expect(result.details).toEqual(expect.objectContaining({ degraded: true }));
  });

  it("缺少可信当前会话时拒绝发送", async () => {
    const result = await tool(null).execute("call-3", {
      title: "确认",
      buttons: [{ id: "ok", label: "确定" }],
    });
    expect(sendCardMessage).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(result.content[0].text).toMatch(/trusted|current/i);
  });
});
