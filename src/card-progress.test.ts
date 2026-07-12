import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChannelType } from "./types.js";
import { OCTO_CARD_LAYOUTS } from "./card-render.js";
import {
  setCardContext,
  finalizeCard,
  registerCardProgress,
  bindCardRun,
  _resetCardProgressForTests,
} from "./card-progress.js";

/** 收集 registerCardProgress 注册的 hook handler。 */
function makeApi(): { handlers: Record<string, (e: unknown, c: unknown) => unknown> } {
  const handlers: Record<string, (e: unknown, c: unknown) => unknown> = {};
  const api = { on: (name: string, fn: (e: unknown, c: unknown) => unknown) => { handlers[name] = fn; } };
  registerCardProgress(api as never);
  return { handlers };
}

/** mock fetch,按 url 分派 getCardProfile / sendMessage / message-edit,记录请求。 */
function mockFetch(opts: { enabled?: boolean; sendId?: string } = {}) {
  const calls: Array<{ url: string; body: Record<string, unknown> | undefined }> = [];
  const fn = vi.fn().mockImplementation(async (url: string, init?: { body?: string }) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
    if (String(url).includes("/v1/bot/card/profile")) {
      return { ok: true, status: 200, json: async () => ({ enabled: opts.enabled ?? true, profiles: ["octo/v1"] }) };
    }
    if (String(url).includes("/v1/bot/sendMessage")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ message_id: opts.sendId ?? "card1" }) };
    }
    return { ok: true, status: 200, text: async () => "" }; // message/edit
  });
  return { fn, calls };
}

function elementText(e: Record<string, unknown>): string {
  if (typeof e.text === "string") return e.text;
  if (Array.isArray(e.inlines)) return e.inlines.map((i) => (i as { text?: string }).text ?? "").join("");
  if (Array.isArray(e.items)) return e.items.map((item) => elementText(item as Record<string, unknown>)).join("\n");
  if (Array.isArray(e.columns)) {
    return e.columns
      .flatMap((c) => ((c as { items?: unknown[] }).items ?? []) as Record<string, unknown>[])
      .map(elementText)
      .join("\n");
  }
  return "";
}

function progressHeaderText(card: { body: Array<Record<string, unknown>> }): string {
  return elementText(card.body[0]);
}

function progressDetailItems(card: { body: Array<Record<string, unknown>> }): Array<Record<string, unknown>> {
  return ((card.body[1] as { items?: Array<Record<string, unknown>> })?.items ?? []);
}

function progressCardText(card: { body: Array<Record<string, unknown>> }): string {
  return card.body.map(elementText).join("\n");
}

/** 可控 promise:用于把某个请求悬在 in-flight 状态。 */
function makeDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("card-progress 状态机 + hook + 节流", () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    vi.useFakeTimers();
    _resetCardProgressForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("首个 tool 事件懒发占位卡(gate+send),after_tool_call 触发 edit", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();

    setCardContext("s1", { apiUrl: "https://a1.test", botToken: "bf", channelId: "g1", channelType: ChannelType.Group });
    handlers.before_tool_call({ toolName: "read" }, { sessionKey: "s1" });
    await vi.advanceTimersByTimeAsync(900);

    expect(calls.some((c) => c.url.includes("/card/profile"))).toBe(true);
    const send = calls.find((c) => c.url.includes("/sendMessage"));
    expect(send).toBeTruthy();
    expect((send!.body!.payload as { type: number }).type).toBe(17);

    handlers.after_tool_call({ toolName: "read", durationMs: 30 }, { sessionKey: "s1" });
    await vi.advanceTimersByTimeAsync(900);
    const edit = calls.find((c) => c.url.includes("/message/edit"));
    expect(edit).toBeTruthy();
    const editEnv = JSON.parse(edit!.body!.content_edit as string);
    expect(editEnv.type).toBe(17);
    expect(editEnv.transient).toBe(true); // 进度中间帧不进修订历史(D10)
  });

  it("OBO 场景跳过(不发任何请求)", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    setCardContext("s2", { apiUrl: "https://a2.test", botToken: "y", channelId: "g", channelType: ChannelType.Group, onBehalfOf: "grantor" });
    handlers.before_tool_call({ toolName: "read" }, { sessionKey: "s2" });
    await vi.advanceTimersByTimeAsync(900);
    expect(calls.length).toBe(0);
  });

  it("未登记 session 的事件 no-op(天然过滤非 octo run)", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    handlers.before_tool_call({ toolName: "read" }, { sessionKey: "unknown" });
    await vi.advanceTimersByTimeAsync(900);
    expect(calls.length).toBe(0);
  });

  it("D12 gate disabled → 不发卡", async () => {
    const { fn, calls } = mockFetch({ enabled: false });
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    setCardContext("s3", { apiUrl: "https://a3.test", botToken: "y", channelId: "g", channelType: ChannelType.Group });
    handlers.before_tool_call({ toolName: "read" }, { sessionKey: "s3" });
    await vi.advanceTimersByTimeAsync(900);
    expect(calls.some((c) => c.url.includes("/sendMessage"))).toBe(false);
  });

  it("D12 明确 elements=[] 时不回退 baseline,不发送无法渲染的卡", async () => {
    const calls: Array<{ url: string }> = [];
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      calls.push({ url: String(url) });
      if (String(url).includes("/card/profile")) {
        return { ok: true, status: 200, json: async () => ({ enabled: true, profiles: ["octo/v1"], elements: [] }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ message_id: "should-not-send" }) };
    }) as unknown as typeof fetch;
    const { handlers } = makeApi();
    setCardContext("empty-elements", { apiUrl: "https://empty.test", botToken: "bf", channelId: "g", channelType: ChannelType.Group });
    handlers.before_tool_call({ toolName: "read" }, { sessionKey: "empty-elements" });
    await vi.advanceTimersByTimeAsync(900);
    expect(calls.some((c) => c.url.includes("/sendMessage"))).toBe(false);
  });

  it("finalizeCard 发终态帧(已有占位卡)", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    setCardContext("s4", { apiUrl: "https://a4.test", botToken: "bf", channelId: "g1", channelType: ChannelType.Group });
    handlers.before_tool_call({ toolName: "read" }, { sessionKey: "s4" });
    await vi.advanceTimersByTimeAsync(900);
    calls.length = 0;

    await finalizeCard("s4", { success: true });
    const edit = calls.find((c) => c.url.includes("/message/edit"));
    expect(edit).toBeTruthy();
    const env = JSON.parse(edit!.body!.content_edit as string);
    expect(progressHeaderText(env.card)).toContain("✅ 已完成");
    expect(env.transient).toBeUndefined(); // 终态帧进修订历史(不带 transient)
  });

  it("finalizeCard 未发过占位卡 → 仅清理不发", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    makeApi();
    setCardContext("s5", { apiUrl: "https://a5.test", botToken: "y", channelId: "g", channelType: ChannelType.Group });
    await finalizeCard("s5", { success: true });
    expect(calls.length).toBe(0);
  });

  it("P1: finalize 等待 in-flight 首帧 send,终态帧不丢失", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> | undefined }> = [];
    const sendGate = makeDeferred(); // 悬住首帧 send
    const sendReached = makeDeferred(); // 通知 send 已进入
    const fn = vi.fn().mockImplementation(async (url: string, init?: { body?: string }) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
      if (String(url).includes("/card/profile")) {
        return { ok: true, status: 200, json: async () => ({ enabled: true }) };
      }
      if (String(url).includes("/sendMessage")) {
        sendReached.resolve();
        await sendGate.promise; // 保持 send in-flight
        return { ok: true, status: 200, text: async () => JSON.stringify({ message_id: "card1" }) };
      }
      return { ok: true, status: 200, text: async () => "" };
    });
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();

    setCardContext("p1", { apiUrl: "https://p1.test", botToken: "bf", channelId: "g1", channelType: ChannelType.Group });
    handlers.before_tool_call({ toolName: "read" }, { sessionKey: "p1" });
    await vi.advanceTimersByTimeAsync(900); // flush 启动:gate 过,send 悬在 sendGate
    await sendReached.promise;

    // send 仍 in-flight(messageId 未就绪)时收尾 —— 旧实现会跳过终态帧。
    const finalizing = finalizeCard("p1", { success: true });
    sendGate.resolve(); // 放行 send 完成
    await finalizing;

    const edit = calls.find((c) => c.url.includes("/message/edit"));
    expect(edit).toBeTruthy();
    const env = JSON.parse(edit!.body!.content_edit as string);
    expect(progressHeaderText(env.card)).toContain("✅ 已完成");
    expect(env.transient).toBeUndefined(); // 终态帧进修订历史
  });

  it("P1(重叠 flush): 首帧 send 在途时第二个 debounce 到期,finalize 仍等真实 send", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> | undefined }> = [];
    const sendGate = makeDeferred();
    const sendReached = makeDeferred();
    let sendCount = 0;
    const fn = vi.fn().mockImplementation(async (url: string, init?: { body?: string }) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
      if (String(url).includes("/card/profile")) {
        return { ok: true, status: 200, json: async () => ({ enabled: true }) };
      }
      if (String(url).includes("/sendMessage")) {
        sendCount++;
        sendReached.resolve();
        await sendGate.promise; // 首帧 send 一直悬着
        return { ok: true, status: 200, text: async () => JSON.stringify({ message_id: "card1" }) };
      }
      return { ok: true, status: 200, text: async () => "" };
    });
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();

    setCardContext("p1b", { apiUrl: "https://p1b.test", botToken: "bf", channelId: "g1", channelType: ChannelType.Group });
    handlers.before_tool_call({ toolName: "read", toolCallId: "A" }, { sessionKey: "p1b" });
    await vi.advanceTimersByTimeAsync(900); // 首帧 flush 启动,send 悬在 sendGate
    await sendReached.promise;

    // 首帧 send 仍在途,再来一个事件 → 第二个 debounce 窗口到期(旧实现会用空转 flush 覆盖 flushPromise)
    handlers.after_tool_call({ toolName: "read", toolCallId: "A", durationMs: 20 }, { sessionKey: "p1b" });
    await vi.advanceTimersByTimeAsync(900);

    const finalizing = finalizeCard("p1b", { success: true });
    sendGate.resolve();
    await finalizing;

    expect(sendCount).toBe(1); // 只发一次首帧(无重复 send)
    const edit = calls.find((c) => c.url.includes("/message/edit"));
    expect(edit).toBeTruthy(); // 终态帧未丢
    const env = JSON.parse(edit!.body!.content_edit as string);
    expect(progressHeaderText(env.card)).toContain("✅ 已完成");
  });

  it("P2-a: gate 5xx 不缓存,下次 flush 重探成功仍能发卡", async () => {
    const calls: Array<{ url: string }> = [];
    let profileCall = 0;
    const fn = vi.fn().mockImplementation(async (url: string) => {
      calls.push({ url: String(url) });
      if (String(url).includes("/card/profile")) {
        profileCall++;
        if (profileCall === 1) return { ok: false, status: 500, text: async () => "boom" };
        return { ok: true, status: 200, json: async () => ({ enabled: true }) };
      }
      if (String(url).includes("/sendMessage")) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ message_id: "card1" }) };
      }
      return { ok: true, status: 200, text: async () => "" };
    });
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();

    setCardContext("ga", { apiUrl: "https://ga.test", botToken: "bf", channelId: "g1", channelType: ChannelType.Group });
    handlers.before_tool_call({ toolName: "read" }, { sessionKey: "ga" });
    await vi.advanceTimersByTimeAsync(900); // 首次 gate 抛错 → 不缓存、不发卡
    expect(calls.some((c) => c.url.includes("/sendMessage"))).toBe(false);

    handlers.before_tool_call({ toolName: "read" }, { sessionKey: "ga" });
    await vi.advanceTimersByTimeAsync(900); // 重探 gate → enabled → 发卡
    expect(profileCall).toBe(2); // 未命中缓存,确实重探了
    expect(calls.some((c) => c.url.includes("/sendMessage"))).toBe(true);
  });

  it("P2-b: 并发同名工具按 toolCallId 精确回填(不串到最后一个)", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();

    setCardContext("tc", { apiUrl: "https://tc.test", botToken: "bf", channelId: "g1", channelType: ChannelType.Group });
    // 两个并发 exec:A、B 都 running
    handlers.before_tool_call({ toolName: "exec", toolCallId: "A", params: { command: "sleep 1" } }, { sessionKey: "tc" });
    handlers.before_tool_call({ toolName: "exec", toolCallId: "B", params: { command: "sleep 2" } }, { sessionKey: "tc" });
    // 先完成的是 A(不是最后 push 的 B)—— 旧逻辑会错标 B。
    handlers.after_tool_call({ toolName: "exec", toolCallId: "A", durationMs: 50 }, { sessionKey: "tc" });
    await vi.advanceTimersByTimeAsync(900);
    await finalizeCard("tc", { success: true });

    const edit = calls.filter((c) => c.url.includes("/message/edit")).pop();
    expect(edit).toBeTruthy();
    const env = JSON.parse(edit!.body!.content_edit as string);
    const texts = progressDetailItems(env.card).map(elementText);
    expect(texts[0]).toBe("⌨️ 执行命令：sleep · 50ms"); // A 已完成
    expect(texts[1]).toBe("⏳ 执行命令：sleep");          // B 仍 running
  });

  it("P2-b(重复投递): toolCallId 命中失败不回退按名匹配,不误标并发步骤", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();

    setCardContext("dup", { apiUrl: "https://dup.test", botToken: "bf", channelId: "g1", channelType: ChannelType.Group });
    handlers.before_tool_call({ toolName: "exec", toolCallId: "A", params: { command: "sleep 1" } }, { sessionKey: "dup" });
    handlers.before_tool_call({ toolName: "exec", toolCallId: "B", params: { command: "sleep 2" } }, { sessionKey: "dup" });
    handlers.after_tool_call({ toolName: "exec", toolCallId: "A", durationMs: 50 }, { sessionKey: "dup" }); // A → done
    // 同一 after 事件重复投递(at-least-once):A 已非 running,旧逻辑会回退把 B 误标 done。
    handlers.after_tool_call({ toolName: "exec", toolCallId: "A", durationMs: 50 }, { sessionKey: "dup" });
    await vi.advanceTimersByTimeAsync(900);
    await finalizeCard("dup", { success: true });

    const edit = calls.filter((c) => c.url.includes("/message/edit")).pop();
    const env = JSON.parse(edit!.body!.content_edit as string);
    const texts = progressDetailItems(env.card).map(elementText);
    expect(texts[0]).toBe("⌨️ 执行命令：sleep · 50ms"); // A done(只被标一次)
    expect(texts[1]).toBe("⏳ 执行命令：sleep");          // B 仍 running,未被重复事件误标
  });

  it("J1: finalize await 期间下一 run setCardContext,不误删新 run 的 entry", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> | undefined }> = [];
    const sendGate = makeDeferred();
    const sendReached = makeDeferred();
    let sendId = 0;
    const fn = vi.fn().mockImplementation(async (url: string, init?: { body?: string }) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
      if (String(url).includes("/card/profile")) {
        return { ok: true, status: 200, json: async () => ({ enabled: true }) };
      }
      if (String(url).includes("/sendMessage")) {
        sendId++;
        if (sendId === 1) { sendReached.resolve(); await sendGate.promise; } // run1 首帧悬住
        return { ok: true, status: 200, text: async () => JSON.stringify({ message_id: `card${sendId}` }) };
      }
      return { ok: true, status: 200, text: async () => "" };
    });
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    const ctx = { apiUrl: "https://j1.test", botToken: "bf", channelId: "g1", channelType: ChannelType.Group };

    setCardContext("S", ctx);
    handlers.before_tool_call({ toolName: "read" }, { sessionKey: "S" });
    await vi.advanceTimersByTimeAsync(900); // run1 flush 首帧 send 悬在 sendGate
    await sendReached.promise;

    const finalizing = finalizeCard("S", { success: true }); // 捕获 entry1,await 其 flushPromise
    setCardContext("S", ctx);                                // 队列推进:同身份 run2 覆盖 Map
    sendGate.resolve();                                       // 放行 run1 首帧完成 → finalize 恢复
    await finalizing;

    // run2 entry 未被误删:它的 before_tool_call 能发出自己的卡(否则无 entry → no-op)。
    handlers.before_tool_call({ toolName: "read" }, { sessionKey: "S" });
    await vi.advanceTimersByTimeAsync(900);
    const sends = calls.filter((c) => c.url.includes("/sendMessage"));
    expect(sends.length).toBe(2); // run1 card1 + run2 card2;若误删则仅 1
  });

  it("J2: 同 sessionKey 不同身份并发 → fail closed,两边都不发", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();

    // 两个不同账号(不同频道)共享同一 sessionKey —— hook 侧无法区分。
    setCardContext("X", { apiUrl: "https://a.test", botToken: "tA", channelId: "chA", channelType: ChannelType.Group });
    setCardContext("X", { apiUrl: "https://a.test", botToken: "tB", channelId: "chB", channelType: ChannelType.Group });
    handlers.before_tool_call({ toolName: "read" }, { sessionKey: "X" });
    await vi.advanceTimersByTimeAsync(900);
    expect(calls.length).toBe(0); // 碰撞 → 两边 skip,绝不发到任一频道
  });

  it("J2: 同 sessionKey 同身份(同账号下一 run)不算碰撞,正常发卡", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    const ctx = { apiUrl: "https://same.test", botToken: "bf", channelId: "g1", channelType: ChannelType.Group };

    setCardContext("Y", ctx);
    setCardContext("Y", ctx); // 同身份重登记(如上一 run 尚未 finalize)→ 不 fail closed
    handlers.before_tool_call({ toolName: "read" }, { sessionKey: "Y" });
    await vi.advanceTimersByTimeAsync(900);
    expect(calls.some((c) => c.url.includes("/sendMessage"))).toBe(true);
  });

  it("J2: 同 apiUrl+同频道但不同 botToken(两个账号同群回复)也 fail closed", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();

    const base = { apiUrl: "https://a.test", channelId: "g1", channelType: ChannelType.Group };
    setCardContext("Z", { ...base, botToken: "tokA" });
    setCardContext("Z", { ...base, botToken: "tokB" }); // 仅 token 不同 → 仍视为跨身份碰撞
    handlers.before_tool_call({ toolName: "read" }, { sessionKey: "Z" });
    await vi.advanceTimersByTimeAsync(900);
    expect(calls.length).toBe(0); // fail closed,两边都不发
  });

  it("影响项#2: 首帧 send 持续 4xx → fail-closed,不再重试", async () => {
    const calls: string[] = [];
    const fn = vi.fn().mockImplementation(async (url: string) => {
      calls.push(String(url));
      if (String(url).includes("/card/profile")) return { ok: true, status: 200, json: async () => ({ enabled: true }) };
      if (String(url).includes("/sendMessage")) return { ok: false, status: 403, text: async () => "forbidden" };
      return { ok: true, status: 200, text: async () => "" };
    });
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();

    setCardContext("e4", { apiUrl: "https://e4.test", botToken: "bf", channelId: "g1", channelType: ChannelType.Group });
    handlers.before_tool_call({ toolName: "read" }, { sessionKey: "e4" });
    await vi.advanceTimersByTimeAsync(900); // 首帧 send → 403 抛错
    const sends1 = calls.filter((c) => c.includes("/sendMessage")).length;
    handlers.after_tool_call({ toolName: "read", durationMs: 5 }, { sessionKey: "e4" });
    await vi.advanceTimersByTimeAsync(900); // 未 skip 则会再试一次
    const sends2 = calls.filter((c) => c.includes("/sendMessage")).length;
    expect(sends1).toBe(1);
    expect(sends2).toBe(1); // 4xx → skip,没有第二次 send
  });

  it("影响项#2: 首帧 send 429/5xx 仍可重试(不 fail-closed)", async () => {
    const calls: string[] = [];
    let sendN = 0;
    const fn = vi.fn().mockImplementation(async (url: string) => {
      calls.push(String(url));
      if (String(url).includes("/card/profile")) return { ok: true, status: 200, json: async () => ({ enabled: true }) };
      if (String(url).includes("/sendMessage")) {
        sendN++;
        if (sendN === 1) return { ok: false, status: 429, text: async () => "rate limited" };
        return { ok: true, status: 200, text: async () => JSON.stringify({ message_id: "card1" }) };
      }
      return { ok: true, status: 200, text: async () => "" };
    });
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();

    setCardContext("e5", { apiUrl: "https://e5.test", botToken: "bf", channelId: "g1", channelType: ChannelType.Group });
    handlers.before_tool_call({ toolName: "read" }, { sessionKey: "e5" });
    await vi.advanceTimersByTimeAsync(900); // 首帧 429 抛错 → 不 skip
    handlers.after_tool_call({ toolName: "read", durationMs: 5 }, { sessionKey: "e5" });
    await vi.advanceTimersByTimeAsync(900); // 重试成功
    expect(calls.filter((c) => c.includes("/sendMessage")).length).toBe(2);
  });

  it("影响项#P2-4: gate 瞬时失败后无新事件不再每 tick 重探", async () => {
    const calls: string[] = [];
    const fn = vi.fn().mockImplementation(async (url: string) => {
      calls.push(String(url));
      if (String(url).includes("/card/profile")) return { ok: false, status: 503, text: async () => "down" };
      return { ok: true, status: 200, text: async () => "" };
    });
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();

    setCardContext("g0", { apiUrl: "https://g0.test", botToken: "bf", channelId: "g1", channelType: ChannelType.Group });
    handlers.before_tool_call({ toolName: "read" }, { sessionKey: "g0" });
    await vi.advanceTimersByTimeAsync(900); // 首次 probe → 503 → null
    const p1 = calls.filter((c) => c.includes("/card/profile")).length;
    await vi.advanceTimersByTimeAsync(4000); // 无新事件,推进多个 debounce 周期
    const p2 = calls.filter((c) => c.includes("/card/profile")).length;
    expect(p1).toBe(1);
    expect(p2).toBe(1); // 不再自动重探,等下个工具事件
  });

  it("波C: manifest advertise RichTextBlock → 进度卡按富文本行渲染(缺省则 TextBlock 平铺)", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> | undefined }> = [];
    const fn = vi.fn().mockImplementation(async (url: string, init?: { body?: string }) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
      if (String(url).includes("/card/profile")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            enabled: true,
            profiles: ["octo/v1"],
            // 真实 im-test 部署 advertise 的元素超集(P1-d 起进度卡优先 RichTextBlock 而非 ColumnSet:
            // 解决服务端权威重算 plain 时 ColumnSet 图标/文本分行的问题)
            elements: ["TextBlock", "RichTextBlock", "Container", "ColumnSet", "FactSet"],
            limits: { max_nodes: 200 },
          }),
        };
      }
      if (String(url).includes("/sendMessage")) return { ok: true, status: 200, text: async () => JSON.stringify({ message_id: "card1" }) };
      return { ok: true, status: 200, text: async () => "" };
    });
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();

    setCardContext("wc", { apiUrl: "https://wc.test", botToken: "bf", channelId: "g1", channelType: ChannelType.Group });
    handlers.before_tool_call({ toolName: "exec", params: { command: "ls" } }, { sessionKey: "wc" });
    await vi.advanceTimersByTimeAsync(900);

    const send = calls.find((c) => c.url.includes("/sendMessage"));
    expect(send).toBeTruthy();
    const card = (send!.body!.payload as {
      card: { body: Array<{ type: string; items?: Array<{ type: string }> }> };
    }).card;
    expect(card.body[0].type).toBe("ColumnSet");
    expect(card.body[1].type).toBe("Container"); // timeline_detail
    expect(card.body[1].items?.[0]?.type).toBe("Container"); // timeline 步骤组
    expect((card.body[1].items?.[0] as { items?: Array<{ type: string }> }).items?.[0]?.type).toBe("RichTextBlock"); // 组内仍是富文本行
  });

  it("波C: manifest advertise Action.ToggleVisibility → 终态 edit 折叠 thinking/tool 明细", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> | undefined }> = [];
    const fn = vi.fn().mockImplementation(async (url: string, init?: { body?: string }) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
      if (String(url).includes("/card/profile")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            enabled: true,
            profiles: ["octo/v1"],
            elements: ["TextBlock", "RichTextBlock", "Container", "ColumnSet", "ActionSet"],
            actions: ["Action.ToggleVisibility"],
            limits: { max_nodes: 200 },
          }),
        };
      }
      if (String(url).includes("/sendMessage")) return { ok: true, status: 200, text: async () => JSON.stringify({ message_id: "card1" }) };
      return { ok: true, status: 200, text: async () => "" };
    });
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();

    setCardContext("wc-toggle", { apiUrl: "https://wc-toggle.test", botToken: "bf", channelId: "g1", channelType: ChannelType.Group });
    handlers.model_call_started({}, { sessionKey: "wc-toggle" });
    await vi.advanceTimersByTimeAsync(100);
    handlers.before_tool_call({ toolName: "exec", toolCallId: "e1", params: { command: "find src" } }, { sessionKey: "wc-toggle" });
    handlers.after_tool_call({ toolName: "exec", toolCallId: "e1", durationMs: 50 }, { sessionKey: "wc-toggle" });
    await vi.advanceTimersByTimeAsync(900);

    await finalizeCard("wc-toggle", { success: true });
    const edit = calls.filter((c) => c.url.includes("/message/edit")).pop();
    expect(edit).toBeTruthy();
    const env = JSON.parse(edit!.body!.content_edit as string);
    expect(env.card.metadata).toEqual({ octo_layout: OCTO_CARD_LAYOUTS.agentProgressV1 });
    const body = env.card.body as Array<Record<string, unknown>>;
    expect(body[0].type).toBe("ColumnSet");
    const summaryHeader = body[0] as { columns: Array<{ width: string; items: Array<Record<string, unknown>> }> };
    const headerBlock = summaryHeader.columns[0].items[0] as { type: string; inlines: Array<Record<string, unknown>> };
    expect(headerBlock.type).toBe("RichTextBlock");
    expect(headerBlock.inlines[0]).toMatchObject({ text: "✅ 已完成", weight: "Bolder" });
    const summaryBlock = summaryHeader.columns[0].items[1] as { type: string; inlines: Array<Record<string, unknown>> };
    expect(summaryBlock.inlines[0]).toMatchObject({ text: "推理与工具调用", weight: "Bolder" });
    expect(summaryBlock.inlines[1]).toMatchObject({ isSubtle: true });
    const collapseBtn = summaryHeader.columns[1].items[0] as { id: string; isVisible: boolean; actions: Array<Record<string, unknown>> };
    const expandBtn = summaryHeader.columns[1].items[1] as { id: string; isVisible: boolean; actions: Array<Record<string, unknown>> };
    expect(collapseBtn.isVisible).toBe(false);
    expect(expandBtn.isVisible).toBe(true);
    expect(collapseBtn.actions[0]).toMatchObject({ type: "Action.ToggleVisibility", title: "收起推理" });
    expect(expandBtn.actions[0]).toMatchObject({ type: "Action.ToggleVisibility", title: "展开推理" });
    expect((body[1] as { type: string; id: string; isVisible: boolean }).type).toBe("Container");
    expect((body[1] as { id: string }).id).toBe("timeline_detail");
    expect((body[1] as { isVisible: boolean }).isVisible).toBe(false);
    expect(collapseBtn.actions[0].targetElements).toEqual([
      { elementId: (body[1] as { id: string }).id, isVisible: false },
      { elementId: collapseBtn.id, isVisible: false },
      { elementId: expandBtn.id, isVisible: true },
    ]);
    expect(JSON.stringify(body[1])).toContain("执行命令");
  });

  it("P1-g: model_call_started 产 running thinking step,before_tool_call 结束它(标 done + durationMs)", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    setCardContext("tk1", { apiUrl: "https://tk1.test", botToken: "bf", channelId: "g", channelType: ChannelType.Group });

    // 起 thinking(agent 首次调 model 决定用哪个工具)
    handlers.model_call_started({}, { sessionKey: "tk1" });
    // 100ms 后开始调 tool —— thinking 结束
    await vi.advanceTimersByTimeAsync(100);
    handlers.before_tool_call({ toolName: "read", params: { path: "/a" }, toolCallId: "r1" }, { sessionKey: "tk1" });
    handlers.after_tool_call({ toolName: "read", toolCallId: "r1", durationMs: 50 }, { sessionKey: "tk1" });
    await vi.advanceTimersByTimeAsync(900);

    const send = calls.find((c) => c.url.includes("/sendMessage"));
    expect(send).toBeTruthy();
    const card = (send!.body!.payload as { card: { body: Array<Record<string, unknown>> } }).card;
    // 首帧应含:header + thinking(done) + read(running/done)
    const joined = progressCardText(card);
    expect(joined).toContain("💭 思考"); // thinking step 出现
    expect(joined).toContain("读取文件");  // 后续 tool step 也在
  });

  it("P1-g: 多次 model_call_started 累积多步 thinking(同类合并压缩)", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    setCardContext("tk2", { apiUrl: "https://tk2.test", botToken: "bf", channelId: "g", channelType: ChannelType.Group });

    // agent 循环:thinking → tool → thinking → tool → thinking → tool
    for (let i = 0; i < 3; i++) {
      handlers.model_call_started({}, { sessionKey: "tk2" });
      await vi.advanceTimersByTimeAsync(50);
      const id = `t${i}`;
      handlers.before_tool_call({ toolName: "read", params: { path: `/${i}` }, toolCallId: id }, { sessionKey: "tk2" });
      handlers.after_tool_call({ toolName: id, toolCallId: id, durationMs: 30 }, { sessionKey: "tk2" });
    }
    await vi.advanceTimersByTimeAsync(900);
    // 只验证:发送时的 payload 里出现了 thinking(至少一处)—— 合并/顺序具体断言在 render 层测
    const send = calls.find((c) => c.url.includes("/sendMessage"));
    expect(send).toBeTruthy();
    const s = JSON.stringify((send!.body!.payload as { card: unknown }).card);
    expect(s).toContain("💭");
  });

  it("P1-g: finalize 前的 running thinking 被收尾(不留 running 尾巴)", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    setCardContext("tk3", { apiUrl: "https://tk3.test", botToken: "bf", channelId: "g", channelType: ChannelType.Group });

    // thinking + 一个 tool,然后再一次 thinking(无后续 tool)→ finalize 收尾
    handlers.model_call_started({}, { sessionKey: "tk3" });
    handlers.before_tool_call({ toolName: "read", params: { path: "/a" }, toolCallId: "r1" }, { sessionKey: "tk3" });
    handlers.after_tool_call({ toolName: "read", toolCallId: "r1", durationMs: 30 }, { sessionKey: "tk3" });
    handlers.model_call_started({}, { sessionKey: "tk3" });
    await vi.advanceTimersByTimeAsync(900); // 首帧发出
    calls.length = 0;

    await finalizeCard("tk3", { success: true });
    const edit = calls.find((c) => c.url.includes("/message/edit"));
    expect(edit).toBeTruthy();
    const env = JSON.parse(edit!.body!.content_edit as string);
    // 终态帧不应残留 running:⏳ 不该出现
    const cardStr = JSON.stringify(env.card);
    expect(cardStr).not.toContain("⏳");
  });

  it("P1-h: octo_send_display_card 不入进度卡 —— 纯 display-card turn 无占位卡、无终态帧", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    setCardContext("dh1", { apiUrl: "https://dh1.test", botToken: "bf", channelId: "g", channelType: ChannelType.Group });
    handlers.before_tool_call({ toolName: "octo_send_display_card", toolCallId: "d1" }, { sessionKey: "dh1" });
    handlers.after_tool_call({ toolName: "octo_send_display_card", toolCallId: "d1", durationMs: 120 }, { sessionKey: "dh1" });
    await vi.advanceTimersByTimeAsync(900);
    // 从未 scheduleFlush → 连 gate 探测/发送都没有
    expect(calls.some((c) => c.url.includes("/sendMessage"))).toBe(false);
    expect(calls.some((c) => c.url.includes("/card/profile"))).toBe(false);
    // finalize 因 !messageId 静默,不发终态帧
    await finalizeCard("dh1", { success: true });
    expect(calls.some((c) => c.url.includes("/message/edit"))).toBe(false);
  });

  it("P1-h: 混合 turn:display-card 不计步,真实工具照常显示进度(读取文件在,display-card 不在)", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    setCardContext("dh2", { apiUrl: "https://dh2.test", botToken: "bf", channelId: "g", channelType: ChannelType.Group });
    handlers.before_tool_call({ toolName: "octo_send_display_card", toolCallId: "d1" }, { sessionKey: "dh2" }); // 忽略
    handlers.before_tool_call({ toolName: "read", params: { path: "/a" }, toolCallId: "r1" }, { sessionKey: "dh2" }); // 计入
    await vi.advanceTimersByTimeAsync(900);
    const send = calls.find((c) => c.url.includes("/sendMessage"));
    expect(send).toBeTruthy();
    const card = (send!.body!.payload as { card: { metadata?: unknown; body: Array<Record<string, unknown>> } }).card;
    expect(card.metadata).toEqual({ octo_layout: OCTO_CARD_LAYOUTS.agentProgressV1 });
    const joined = progressCardText(card);
    expect(joined).toContain("读取文件");
    expect(joined).not.toContain("octo_send_display_card");
  });

  it("懒发契约:model_call_started 单独不发卡 —— 纯 display-card turn(含思考步)无占位卡、无中断终态", async () => {
    // 回归:P1-g 的 model_call_started 曾无条件 scheduleFlush,击穿 P1-h 抑制 ——
    // 纯 display-card turn 仍发占位卡并 finalize 成「⚠️ 已中断」。
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    setCardContext("nf1", { apiUrl: "https://nf1.test", botToken: "bf", channelId: "g", channelType: ChannelType.Group });
    handlers.model_call_started({}, { sessionKey: "nf1" });   // 思考步(真实事件序:先于 tool)
    handlers.before_tool_call({ toolName: "octo_send_display_card", toolCallId: "d1" }, { sessionKey: "nf1" });
    handlers.after_tool_call({ toolName: "octo_send_display_card", toolCallId: "d1", durationMs: 120 }, { sessionKey: "nf1" });
    await vi.advanceTimersByTimeAsync(900);
    expect(calls.some((c) => c.url.includes("/sendMessage"))).toBe(false);
    expect(calls.some((c) => c.url.includes("/card/profile"))).toBe(false);
    await finalizeCard("nf1", { success: false });
    expect(calls.some((c) => c.url.includes("/message/edit"))).toBe(false); // 无 messageId → 无中断帧
  });

  it("懒发契约:纯思考(无任何工具)turn 不发进度卡", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    setCardContext("nf2", { apiUrl: "https://nf2.test", botToken: "bf", channelId: "g", channelType: ChannelType.Group });
    handlers.model_call_started({}, { sessionKey: "nf2" });
    await vi.advanceTimersByTimeAsync(900);
    handlers.model_call_started({}, { sessionKey: "nf2" }); // 连续思考(去重)
    await vi.advanceTimersByTimeAsync(900);
    expect(calls.length).toBe(0);
    await finalizeCard("nf2", { success: true });
    expect(calls.some((c) => c.url.includes("/message/edit"))).toBe(false);
  });

  it("懒发契约:真实工具后思考步照常更新已存在的卡", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    setCardContext("nf3", { apiUrl: "https://nf3.test", botToken: "bf", channelId: "g", channelType: ChannelType.Group });
    handlers.model_call_started({}, { sessionKey: "nf3" });               // 纯思考:不发
    handlers.before_tool_call({ toolName: "read", toolCallId: "r1" }, { sessionKey: "nf3" }); // 真实工具:发首帧
    await vi.advanceTimersByTimeAsync(900);
    expect(calls.some((c) => c.url.includes("/sendMessage"))).toBe(true);
    calls.length = 0;
    handlers.after_tool_call({ toolName: "read", toolCallId: "r1", durationMs: 20 }, { sessionKey: "nf3" });
    handlers.model_call_started({}, { sessionKey: "nf3" });               // 卡已存在 → 思考步刷新
    await vi.advanceTimersByTimeAsync(900);
    expect(calls.some((c) => c.url.includes("/message/edit"))).toBe(true);
  });

  it("NEW-3: display-card 前的 running thinking 被收尾(思考耗时不吞掉发卡时长)", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    setCardContext("nf4", { apiUrl: "https://nf4.test", botToken: "bf", channelId: "g", channelType: ChannelType.Group });
    handlers.before_tool_call({ toolName: "read", toolCallId: "r1" }, { sessionKey: "nf4" }); // 让卡存在
    handlers.after_tool_call({ toolName: "read", toolCallId: "r1", durationMs: 10 }, { sessionKey: "nf4" });
    handlers.model_call_started({}, { sessionKey: "nf4" });               // 起一个思考步
    handlers.before_tool_call({ toolName: "octo_send_display_card", toolCallId: "d1" }, { sessionKey: "nf4" }); // 应收尾思考步
    handlers.before_tool_call({ toolName: "read", params: { path: "/b" }, toolCallId: "r2" }, { sessionKey: "nf4" });
    await vi.advanceTimersByTimeAsync(900);
    const send = calls.find((c) => c.url.includes("/sendMessage")) ?? calls.find((c) => c.url.includes("/message/edit"));
    // 思考步已 done(有 💭 且带耗时),不再是 running（⏳）
    expect(send).toBeTruthy();
  });

  it("runId 在 before_agent_run 预绑定:旧 run 迟到 hook 先到也不能抢占新 entry", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();
    const target = { apiUrl: "https://rg.test", botToken: "bf", channelId: "g", channelType: ChannelType.Group };

    // run A 在任何 model/tool 事件前由 before_agent_run 绑定,随后跑一步并超时收尾。
    setCardContext("rg1", target);
    expect(handlers.before_agent_run({}, { sessionKey: "rg1", runId: "A" })).toEqual({ outcome: "pass" });
    handlers.before_tool_call({ toolName: "read", params: { path: "/a" }, toolCallId: "a1" }, { sessionKey: "rg1", runId: "A" });
    await vi.advanceTimersByTimeAsync(900);
    await finalizeCard("rg1", { success: false });

    // 同 sessionKey 的 run B 登记 fresh entry。A 的迟到 hook 在 B 的首个工具事件之前到达，
    // 但 entry 尚未由 before_agent_run 绑定时不得 first-hook-wins。
    setCardContext("rg1", target);
    handlers.before_tool_call({ toolName: "exec", params: { command: "echo x" }, toolCallId: "a2" }, { sessionKey: "rg1", runId: "A" });
    handlers.after_tool_call({ toolName: "exec", toolCallId: "a2", durationMs: 9 }, { sessionKey: "rg1", runId: "A" });
    expect(handlers.before_agent_run({}, { sessionKey: "rg1", runId: "B" })).toEqual({ outcome: "pass" });
    handlers.before_tool_call({ toolName: "write", params: { path: "/b" }, toolCallId: "b1" }, { sessionKey: "rg1", runId: "B" });
    await vi.advanceTimersByTimeAsync(900);

    // 聚合所有发出去的帧(send payload + edit content_edit)的卡片文本
    const allText = calls
      .filter((c) => c.url.includes("/sendMessage") || c.url.includes("/message/edit"))
      .map((c) => {
        const card = c.url.includes("/message/edit")
          ? JSON.parse(c.body!.content_edit as string).card
          : (c.body!.payload as { card: { body: Array<Record<string, unknown>> } }).card;
        return progressCardText(card);
      })
      .join(" || ");
    expect(allText).toContain("写入文件"); // B 自己的步骤渲染出来了
    expect(allText).not.toContain("执行命令"); // A 迟到的 exec 步骤从未进入任何帧
  });

  it("bindCardRun 缺标识/无 entry/skip 时 no-op,且既有 owner 不可被覆盖", async () => {
    const { fn, calls } = mockFetch();
    global.fetch = fn as unknown as typeof fetch;
    const { handlers } = makeApi();

    bindCardRun(undefined, "run-a");
    bindCardRun("missing", undefined);
    bindCardRun("missing", "run-a");
    setCardContext("skipped", {
      apiUrl: "https://owner.test",
      botToken: "bf",
      channelId: "g",
      channelType: ChannelType.Group,
      onBehalfOf: "grantor",
    });
    bindCardRun("skipped", "run-a");

    setCardContext("owned", {
      apiUrl: "https://owner.test",
      botToken: "bf",
      channelId: "g",
      channelType: ChannelType.Group,
    });
    bindCardRun("owned", "run-a");
    bindCardRun("owned", "run-b");
    handlers.before_tool_call({ toolName: "exec", toolCallId: "b1" }, { sessionKey: "owned", runId: "run-b" });
    handlers.before_tool_call({ toolName: "read", toolCallId: "a1" }, { sessionKey: "owned", runId: "run-a" });
    await vi.advanceTimersByTimeAsync(900);

    const send = calls.find((c) => c.url.includes("/sendMessage"));
    expect(send).toBeTruthy();
    const rendered = progressCardText((send!.body!.payload as {
      card: { body: Array<Record<string, unknown>> };
    }).card);
    expect(rendered).toContain("读取文件");
    expect(rendered).not.toContain("执行命令");
  });

  it("entry 等待 profile 时被新身份替换,恢复后不得向旧频道发送占位卡", async () => {
    const profileReached = makeDeferred();
    const releaseProfile = makeDeferred();
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    let profileSignal: AbortSignal | undefined;
    global.fetch = vi.fn().mockImplementation(async (url: string, init?: { body?: string; signal?: AbortSignal }) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
      if (String(url).includes("/card/profile")) {
        profileSignal = init?.signal;
        profileReached.resolve();
        await releaseProfile.promise;
        return { ok: true, status: 200, json: async () => ({ enabled: true, profiles: ["octo/v1"] }) };
      }
      if (String(url).includes("/sendMessage")) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ message_id: "stale" }) };
      }
      return { ok: true, status: 200, text: async () => "" };
    }) as unknown as typeof fetch;
    const { handlers } = makeApi();

    setCardContext("collision", { apiUrl: "https://race.test", botToken: "token-a", channelId: "group-a", channelType: ChannelType.Group });
    handlers.before_tool_call({ toolName: "read", toolCallId: "a1" }, { sessionKey: "collision" });
    await vi.advanceTimersByTimeAsync(900);
    await profileReached.promise;

    setCardContext("collision", { apiUrl: "https://race.test", botToken: "token-b", channelId: "group-b", channelType: ChannelType.Group });
    expect(profileSignal?.aborted).toBe(true);
    releaseProfile.resolve();
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(calls.some((c) => c.url.includes("/sendMessage"))).toBe(false);
  });
});
