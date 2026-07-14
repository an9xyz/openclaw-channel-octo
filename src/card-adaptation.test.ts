import { describe, it, expect, vi, afterEach } from "vitest";
import { ChannelType, MessageType, CARD_PLACEHOLDER } from "./types.js";
import { resolveCardPlain, resolveInnerMessageText, resolveApiMessagePlaceholder } from "./inbound.js";
import { sendCardMessage, getCardProfile, editCardMessage } from "./api-fetch.js";

/**
 * InteractiveCard(=17) 适配 — 波 0 入站派生 + 波 A 出站原语。
 * 契约来源:octo-server PR #525 P1(card-message-protocol)。
 */

describe("InteractiveCard(17) 入站派生 plain", () => {
  it("resolveCardPlain: 有 plain 取原文(trim)", () => {
    expect(resolveCardPlain({ plain: "任务完成 ✅" })).toBe("任务完成 ✅");
    expect(resolveCardPlain({ plain: "  spaced  " })).toBe("spaced");
  });

  it("resolveCardPlain: 空/空白/非字符串/缺失 → [卡片](never empty)", () => {
    expect(resolveCardPlain({ plain: "" })).toBe(CARD_PLACEHOLDER);
    expect(resolveCardPlain({ plain: "   " })).toBe(CARD_PLACEHOLDER);
    expect(resolveCardPlain({ plain: 123 as unknown })).toBe(CARD_PLACEHOLDER);
    expect(resolveCardPlain({})).toBe(CARD_PLACEHOLDER);
    expect(resolveCardPlain(undefined)).toBe(CARD_PLACEHOLDER);
  });

  it("resolveInnerMessageText: type=17 取服务端 plain / 回退 [卡片]", () => {
    expect(
      resolveInnerMessageText({ type: MessageType.InteractiveCard, plain: "卡片正文" } as never),
    ).toBe("卡片正文");
    expect(
      resolveInnerMessageText({ type: MessageType.InteractiveCard } as never),
    ).toBe(CARD_PLACEHOLDER);
  });

  it("resolveApiMessagePlaceholder: type=17 → [卡片]", () => {
    expect(resolveApiMessagePlaceholder(MessageType.InteractiveCard)).toBe(CARD_PLACEHOLDER);
  });
});

describe("sendCardMessage 出站组包", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("payload.type=17 + card + profile/card_version + on_behalf_of 透传(C3)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue('{"message_id":"m1"}'),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await sendCardMessage({
      apiUrl: "https://api.test",
      botToken: "bf_x",
      channelId: "g1",
      channelType: ChannelType.Group,
      card: { type: "AdaptiveCard", body: [] },
      plain: "seed",
      onBehalfOf: "u_grantor",
    });
    expect(res).toEqual({ message_id: "m1" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain("/v1/bot/sendMessage");
    const body = JSON.parse(init.body as string);
    expect(body.payload.type).toBe(MessageType.InteractiveCard);
    expect(body.payload.card).toEqual({ type: "AdaptiveCard", body: [] });
    expect(body.payload.profile).toBe("octo/v1");
    expect(body.payload.card_version).toBe("1.5");
    expect(body.payload.plain).toBe("seed");
    expect(body.on_behalf_of).toBe("u_grantor");
    expect(typeof body.client_msg_no).toBe("string");
  });

  it("空 channelId 抛错", async () => {
    await expect(
      sendCardMessage({
        apiUrl: "https://api.test",
        botToken: "bf_x",
        channelId: "  ",
        channelType: ChannelType.Group,
        card: {},
      }),
    ).rejects.toThrow(/channelId is required/);
  });
});

describe("getCardProfile (D12 feature-detect)", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("200 → 解析 manifest(完整能力清单:elements/inputs/actions/limits;真实服务端形状)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        enabled: true,
        card_version: "1.5",
        profiles: ["octo/v1", "octo/v2"],
        elements: [
          "TextBlock", "RichTextBlock", "Image", "ImageSet",
          "Container", "ColumnSet", "FactSet",
          "Table", "ActionSet",
        ],
        inputs: [
          "Input.Text", "Input.Toggle", "Input.ChoiceSet",
          "Input.Number", "Input.Date", "Input.Time",
        ],
        actions: ["Action.OpenUrl", "Action.ToggleVisibility", "Action.CopyToClipboard"],
        limits: {
          max_payload_bytes: 524288,
          max_nodes: 200,
          max_depth: 16,
          max_input_text_bytes: 4096,
          max_inputs_bytes: 16384,
        },
      }),
    }) as unknown as typeof fetch;

    const m = await getCardProfile({ apiUrl: "https://api.test", botToken: "bf_x" });
    expect(m.available).toBe(true);
    expect(m.enabled).toBe(true);
    expect(m.card_version).toBe("1.5");
    expect(m.profiles).toEqual(["octo/v1", "octo/v2"]);
    expect(m.elements).toEqual([
      "TextBlock", "RichTextBlock", "Image", "ImageSet",
      "Container", "ColumnSet", "FactSet",
      "Table", "ActionSet",
    ]);
    expect(m.inputs).toEqual([
      "Input.Text", "Input.Toggle", "Input.ChoiceSet",
      "Input.Number", "Input.Date", "Input.Time",
    ]);
    expect(m.actions).toEqual(["Action.OpenUrl", "Action.ToggleVisibility", "Action.CopyToClipboard"]);
    expect(m.limits).toEqual({
      max_payload_bytes: 524288,
      max_nodes: 200,
      max_depth: 16,
      max_input_text_bytes: 4096,
      max_inputs_bytes: 16384,
    });
  });

  it("404(端点未部署)→ available:false(调用方回退 config)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: vi.fn().mockResolvedValue(""),
    }) as unknown as typeof fetch;

    const m = await getCardProfile({ apiUrl: "https://api.test", botToken: "bf_x" });
    expect(m).toEqual({ available: false, enabled: false });
  });

  it("200 enabled:false → available:true(服务端明确关,区别于 404 未部署)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ enabled: false }),
    }) as unknown as typeof fetch;

    const m = await getCardProfile({ apiUrl: "https://api.test", botToken: "bf_x" });
    expect(m.available).toBe(true);
    expect(m.enabled).toBe(false);
  });

  it("F5: enabled 序列化为 1/0 也兼容(与仓库 flag 惯例一致)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ enabled: 1, profiles: ["octo/v1"] }),
    }) as unknown as typeof fetch;
    const m = await getCardProfile({ apiUrl: "https://api.test", botToken: "bf_x" });
    expect(m.enabled).toBe(true);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ enabled: 0 }),
    }) as unknown as typeof fetch;
    const m0 = await getCardProfile({ apiUrl: "https://api.test", botToken: "bf_x" });
    expect(m0.enabled).toBe(false);
  });

  it("5xx → 抛错(交给调用方重试节奏)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "err",
      text: vi.fn().mockResolvedValue("boom"),
    }) as unknown as typeof fetch;

    await expect(
      getCardProfile({ apiUrl: "https://api.test", botToken: "bf_x" }),
    ).rejects.toThrow(/card\/profile failed \(500\)/);
  });
});

describe("editCardMessage 出站组包", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("POST /v1/bot/message/edit,content_edit=stringify 的 type-17 信封 + onBehalfOf(C3)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue(""),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await editCardMessage({
      apiUrl: "https://api.test",
      botToken: "bf_x",
      messageId: "m1",
      channelId: "g1",
      channelType: ChannelType.Group,
      card: { type: "AdaptiveCard" },
      plain: "进度",
      onBehalfOf: "u_grantor",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toContain("/v1/bot/message/edit");
    const body = JSON.parse(init.body as string);
    expect(body.message_id).toBe("m1");
    expect(body.channel_id).toBe("g1");
    expect(body.on_behalf_of).toBe("u_grantor");
    expect(body.message_seq).toBeUndefined();
    const env = JSON.parse(body.content_edit);
    expect(env.type).toBe(MessageType.InteractiveCard);
    expect(env.profile).toBe("octo/v1");
    expect(env.card_version).toBe("1.5");
    expect(env.card).toEqual({ type: "AdaptiveCard" });
    expect(env.plain).toBe("进度");
    expect(env.card_seq).toBeUndefined();
    expect(env.transient).toBeUndefined(); // 不传 transient → 默认进修订历史
  });

  it("空 messageId 抛错", async () => {
    await expect(
      editCardMessage({
        apiUrl: "https://api.test",
        botToken: "bf_x",
        messageId: "",
        channelId: "g1",
        channelType: ChannelType.Group,
        card: {},
      }),
    ).rejects.toThrow(/messageId is required/);
  });
});
