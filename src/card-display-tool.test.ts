import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("./accounts.js", () => ({
  listOctoAccountIds: vi.fn(),
  resolveOctoAccount: vi.fn(),
  resolveDefaultOctoAccountId: vi.fn(),
}));

vi.mock("./api-fetch.js", () => ({
  sendCardMessage: vi.fn(),
  getCardProfile: vi.fn(),
  generateClientMsgNo: vi.fn(),
}));

import { createDisplayCardTool } from "./card-display-tool.js";
import {
  listOctoAccountIds,
  resolveOctoAccount,
} from "./accounts.js";
import { sendCardMessage, getCardProfile } from "./api-fetch.js";
import { generateClientMsgNo } from "./api-fetch.js";

const mockCfg = { channels: { octo: { botToken: "t" } } } as never;

function setupOk(): void {
  vi.mocked(generateClientMsgNo).mockReturnValue("client-msg-no-1");
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
    profiles: ["octo/v1"],
    card_version: "1.5",
    elements: ["TextBlock", "RichTextBlock", "Container", "FactSet"],
  } as never);
  vi.mocked(sendCardMessage).mockResolvedValue({ message_id: "m1" } as never);
}

function getTool(): {
  name: string;
  description: string;
  parameters: unknown;
  execute: (id: string, args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; details?: unknown }>;
} {
  const tools = createDisplayCardTool({ cfg: mockCfg, agentAccountId: "default" });
  expect(tools).toHaveLength(1);
  return tools[0];
}

describe("createDisplayCardTool 骨架", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OCTO_CARD_REQUEST_LOG_DIR;
    setupOk();
  });

  it("无 configured account → 空数组(tool discovery 阶段安全)", () => {
    vi.mocked(listOctoAccountIds).mockReturnValue([]);
    expect(createDisplayCardTool({ cfg: mockCfg })).toEqual([]);
  });

  it("cfg 缺失 → 空数组", () => {
    expect(createDisplayCardTool({ cfg: undefined as never })).toEqual([]);
  });

  it("tool 元数据:name=octo_send_display_card,description 涵盖『展示型』『不回流』", () => {
    const t = getTool();
    expect(t.name).toBe("octo_send_display_card");
    expect(t.description.length).toBeGreaterThan(20);
    expect(t.description).toMatch(/display|展示|non[- ]?interactive|not interactive/i);
  });

  it("P1-i: description 明确指引富样式(group.style + rich color),引用 SKILL 文档", () => {
    const t = getTool();
    // 显式提到 group.style 三色和 rich color 才算引导到位
    expect(t.description).toMatch(/group.*style/i);
    expect(t.description).toMatch(/good.*warning.*attention|attention.*warning.*good/);
    expect(t.description).toMatch(/rich.*color|color.*rich/i);
    // 指向 SKILL 详细节
    expect(t.description).toMatch(/SKILL(\.md)?/);
  });

  it("卡片过程指引:description 要求 reasoning_sections,避免 raw tool_events 日志卡", () => {
    const t = getTool();
    expect(t.description).toMatch(/reasoning_sections/);
    expect(t.description).toMatch(/tool_events/);
    expect(t.description).toMatch(/human-readable reasoning sentence/i);
    expect(t.description).toMatch(/2-3 .*reasoning_sections/);
    expect(t.description).toMatch(/查看过程/);
  });

  it("收尾约束:description 提醒发卡是 side-effect,turn 必须补文本收尾(否则被判 incomplete)", () => {
    const t = getTool();
    // 强调发卡不是对话回复
    expect(t.description).toMatch(/side[- ]?effect/i);
    // 要求调用后仍要输出文本 / 不要以工具调用结束 turn
    expect(t.description).toMatch(/final text|text message|end your turn/i);
    // 点明零文本收尾会被判 incomplete
    expect(t.description).toMatch(/incomplete/i);
  });
});

describe("execute:发展示卡", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OCTO_CARD_REQUEST_LOG_DIR;
    setupOk();
  });

  it("blocks + channelId → 调 sendCardMessage,payload.card 是 buildDisplayCard 产物,payload 无 actions(展示型)", async () => {
    const t = getTool();
    const res = await t.execute("call-1", {
      channelId: "group:g1",
      title: "报告",
      blocks: [
        { type: "text", text: "任务完成" },
        { type: "facts", items: [{ label: "耗时", value: "30ms" }] },
      ],
    });
    expect(sendCardMessage).toHaveBeenCalledTimes(1);
    const call = vi.mocked(sendCardMessage).mock.calls[0][0];
    expect(call.channelId).toBe("g1");
    expect((call.card as { type: string }).type).toBe("AdaptiveCard");
    expect((call.card as { version: string }).version).toBe("1.5");
    // 展示型 → 顶层无 actions
    expect(call.card).not.toHaveProperty("actions");
    expect(res.content[0].text).toContain("m1"); // 返回 message_id
  });

  it("blocks 空 + title 空 → 拒绝(不发)", async () => {
    const t = getTool();
    const res = await t.execute("call-2", { channelId: "group:g1", blocks: [] });
    expect(sendCardMessage).not.toHaveBeenCalled();
    expect(res.content[0].text.toLowerCase()).toMatch(/error|empty|blocks/);
  });

  it("gate available:false + env 未开 → 拒绝(agent 由错误退回文本)", async () => {
    vi.mocked(getCardProfile).mockResolvedValue({ available: false, enabled: false } as never);
    delete process.env.OCTO_CARD_MESSAGE_ENABLED;
    const t = getTool();
    const res = await t.execute("c3", { channelId: "group:g1", title: "T", blocks: [{ type: "text", text: "a" }] });
    expect(sendCardMessage).not.toHaveBeenCalled();
    expect(res.content[0].text.toLowerCase()).toMatch(/error|not (available|enabled)|unavailable/);
  });

  it("gate enabled:false → 拒绝", async () => {
    vi.mocked(getCardProfile).mockResolvedValue({ available: true, enabled: false } as never);
    const t = getTool();
    const res = await t.execute("c4", { channelId: "group:g1", title: "T", blocks: [{ type: "text", text: "a" }] });
    expect(sendCardMessage).not.toHaveBeenCalled();
    expect(res.content[0].text.toLowerCase()).toMatch(/error|disabled|not enabled/);
  });

  it("profile 不含 octo/v1 → 拒绝(避免 400)", async () => {
    vi.mocked(getCardProfile).mockResolvedValue({
      available: true,
      enabled: true,
      profiles: ["octo/v2"],
      card_version: "1.5",
    } as never);
    const t = getTool();
    const res = await t.execute("c5", { channelId: "group:g1", title: "T", blocks: [{ type: "text", text: "a" }] });
    expect(sendCardMessage).not.toHaveBeenCalled();
    expect(res.content[0].text.toLowerCase()).toMatch(/profile|不兼容/);
  });

  it("能力协商生效:advertise 不含 FactSet → 卡里 FactSet 被降级(不 400,不拒绝)", async () => {
    vi.mocked(getCardProfile).mockResolvedValue({
      available: true,
      enabled: true,
      profiles: ["octo/v1"],
      card_version: "1.5",
      elements: ["TextBlock"], // 无 FactSet
    } as never);
    const t = getTool();
    await t.execute("c6", { channelId: "group:g1", blocks: [
      { type: "facts", items: [{ label: "k", value: "v" }] },
    ]});
    const call = vi.mocked(sendCardMessage).mock.calls[0]?.[0];
    expect(call).toBeTruthy();
    const body = (call!.card as { body: Array<Record<string, unknown>> }).body;
    // FactSet 降级为 TextBlock 罗列 —— 不会有 FactSet 元素
    expect(body.some((e) => e.type === "FactSet")).toBe(false);
    expect(body.some((e) => e.type === "TextBlock")).toBe(true);
  });

  it("安全:agent 传入的 onBehalfOf 被忽略(不接受不可信身份,防 persona 冒充)", async () => {
    const t = getTool();
    await t.execute("c7", {
      channelId: "group:g1",
      title: "T",
      blocks: [{ type: "text", text: "a" }],
      onBehalfOf: "u_grantor", // 不可信入参 —— 不应透传
    });
    // 展示卡始终以 bot 自身身份发出;OBO 绝不由模型输入指定(与进度卡路径一致)。
    expect(vi.mocked(sendCardMessage).mock.calls[0][0].onBehalfOf).toBeUndefined();
  });

  it("非法 block 静默丢弃(不 fail;不合法字段类型的整块跳过)", async () => {
    const t = getTool();
    await t.execute("c8", {
      channelId: "group:g1",
      blocks: [
        { type: "invalid_kind", stuff: "x" }, // 未知 type
        { type: "text" }, // 缺 text
        { type: "text", text: 42 }, // text 非 string
        { type: "text", text: "存活" },
      ],
    });
    const call = vi.mocked(sendCardMessage).mock.calls[0]?.[0];
    expect(call).toBeTruthy();
    const body = (call!.card as { body: Array<{ text?: string }> }).body;
    // 只剩存活的
    expect(body.some((e) => e.text === "存活")).toBe(true);
    expect(body).toHaveLength(1);
  });

  it("blocks 全被验证/脱敏过滤空 + title 空 → 拒绝", async () => {
    const t = getTool();
    const res = await t.execute("c9", {
      channelId: "group:g1",
      blocks: [
        { type: "invalid" },
        { type: "text", text: "AKIAIOSFODNN7EXAMPLE" }, // 全被脱敏
      ],
    });
    expect(sendCardMessage).not.toHaveBeenCalled();
    expect(res.content[0].text.toLowerCase()).toMatch(/error|empty|blocks/);
  });

  it("OCTO_CARD_REQUEST_LOG_DIR:记录脱敏后的请求参数,用 client_msg_no 关联实际消息", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "octo-card-req-"));
    process.env.OCTO_CARD_REQUEST_LOG_DIR = dir;
    try {
      const t = getTool();
      const res = await t.execute("trace-call-1", {
        channelId: "group:g1",
        title: "调试卡",
        blocks: [
          { type: "text", text: "safe text" },
          { type: "text", text: "Authorization: Bearer sk-abcdefghijklmnop" },
        ],
      });
      const sent = vi.mocked(sendCardMessage).mock.calls[0][0];
      expect(typeof sent.clientMsgNo).toBe("string");
      expect(sent.clientMsgNo).toBeTruthy();
      expect(res.details).toMatchObject({ client_msg_no: sent.clientMsgNo });

      const logText = await readFile(path.join(dir, "display-card-requests.jsonl"), "utf8");
      const entry = JSON.parse(logText.trim());
      expect(entry.tool_call_id).toBe("trace-call-1");
      expect(entry.message_id).toBe("m1");
      expect(entry.client_msg_no).toBe(sent.clientMsgNo);
      expect(entry.args.title).toBe("调试卡");
      expect(JSON.stringify(entry)).toContain("safe text");
      expect(JSON.stringify(entry)).not.toContain("sk-abcdefghijklmnop");
      expect(JSON.stringify(entry)).toContain("[redacted]");
    } finally {
      delete process.env.OCTO_CARD_REQUEST_LOG_DIR;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
