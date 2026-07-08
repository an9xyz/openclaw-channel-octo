import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChannelType } from "./types.js";
import {
  setCardContext,
  finalizeCard,
  registerCardProgress,
  _resetCardProgressForTests,
} from "./card-progress.js";

/** 收集 registerCardProgress 注册的 hook handler。 */
function makeApi(): { handlers: Record<string, (e: unknown, c: unknown) => void> } {
  const handlers: Record<string, (e: unknown, c: unknown) => void> = {};
  const api = { on: (name: string, fn: (e: unknown, c: unknown) => void) => { handlers[name] = fn; } };
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
    expect((env.card.body as Array<{ text: string }>)[0].text).toContain("✅ 已完成");
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
    expect((env.card.body as Array<{ text: string }>)[0].text).toContain("✅ 已完成");
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
    expect((env.card.body as Array<{ text: string }>)[0].text).toContain("✅ 已完成");
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
    const texts = (env.card.body as Array<{ text: string }>).map((b) => b.text);
    expect(texts[1]).toBe("⌨️ 执行命令：sleep · 50ms"); // A 已完成
    expect(texts[2]).toBe("⏳ 执行命令：sleep");          // B 仍 running
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
    const texts = (env.card.body as Array<{ text: string }>).map((b) => b.text);
    expect(texts[1]).toBe("⌨️ 执行命令：sleep · 50ms"); // A done(只被标一次)
    expect(texts[2]).toBe("⏳ 执行命令：sleep");          // B 仍 running,未被重复事件误标
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
});
