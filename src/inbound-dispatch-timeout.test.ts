import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChannelType, MessageType } from "./types.js";
import {
  handleInboundMessage,
  _setDispatchTimeoutForTests,
  _setDispatchApologyTimeoutForTests,
} from "./inbound.js";
import { setOctoRuntime } from "./runtime.js";
import { _clearKnownBots } from "./bot-registry.js";
import type { ResolvedOctoAccount } from "./accounts.js";

/**
 * Regression tests for issue #75 — upstream
 * `core.channel.reply.dispatchReplyWithBufferedBlockDispatcher` can hang
 * indefinitely (no resolve, no reject, no onError). Combined with the
 * per-group serial inbound queue (`enqueueInbound` in channel.ts), a single
 * hang locks the entire group: no further messages get processed until the
 * gateway restarts.
 *
 * Scope of this fix (intentionally minimal):
 *   1. Promise.race + setTimeout makes a hang reject as a timeout error
 *      → enqueueInbound's outer .catch() advances the queue.
 *   2. The "处理超时" apology sendMessage carries its own short AbortSignal
 *      → a sick Octo API does NOT re-hang the timeout path.
 *   3. The happy-path final flush of buffered text also carries a short
 *      AbortSignal → even on the success path, a slow API can't strand the
 *      queue.
 *   4. Timeout handle is cleared in finally on every path.
 *
 * Out of scope (tracked separately): cancellation of an already-in-flight
 * upstream dispatch / suppression of late deliver/onError callbacks from a
 * dispatch that "wakes up" after our timeout. If the upstream resumes, the
 * worst outcome is a delayed real reply on top of the apology — annoying,
 * not broken.
 */

const API = "http://octo.test";
const BOT_UID = "bot_self_0000000000000000000000000000";
const HUMAN_UID = "human_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const GROUP_ID = "g_room_1";

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;

// Two intentionally DIFFERENT delays so the timer-cleanup test can tell our
// dispatch timer apart from the apology / final-flush AbortSignal.timeout
// timers (both fixed at APOLOGY_TIMEOUT_MS) when filtering setTimeout calls
// by delay.
const TIMEOUT_MS_FOR_TESTS = 100;
const APOLOGY_TIMEOUT_MS_FOR_TESTS = 150;

function makeAccount(): ResolvedOctoAccount {
  return {
    accountId: "acct1",
    enabled: true,
    configured: true,
    config: {
      botToken: "tok",
      apiUrl: API,
      pollIntervalMs: 1000,
      heartbeatIntervalMs: 1000,
      requireMention: false,
    },
  };
}

function makeAtBotMessage() {
  return {
    message_id: "m1",
    message_seq: 100,
    from_uid: HUMAN_UID,
    channel_id: GROUP_ID,
    channel_type: ChannelType.Group,
    timestamp: Math.floor(Date.now() / 1000),
    payload: {
      type: MessageType.Text,
      content: "hello bot",
      mention: { uids: [BOT_UID] },
    },
  };
}

function installFetchStub() {
  const sends: any[] = [];
  globalThis.fetch = vi.fn(async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

    if (url.includes("/members")) {
      return json({
        members: [
          { uid: HUMAN_UID, name: "Alice", robot: false },
          { uid: BOT_UID, name: "SelfBot", robot: true },
        ],
      });
    }
    if (url.includes("/mention_pref")) return json({ no_mention: false });
    if (url.includes("/md")) return json({ content: "", version: 0, updated_at: null, updated_by: "" });
    if (url.includes("/messages/sync")) return json({ messages: [] });
    if (url.includes("/readReceipt")) return json({});
    if (url.includes("/typing")) return json({});
    if (url.includes("/sendMessage")) {
      sends.push(init?.body ? JSON.parse(init.body) : {});
      return json({ message_id: "reply1", message_seq: 0 });
    }
    return json({});
  }) as unknown as typeof fetch;
  return { sends };
}

/**
 * Network stub variant where /sendMessage HANGS until the request's signal
 * aborts. Used to verify that AbortSignal.timeout on the apology + final
 * flush actually interrupts in-flight sends, instead of merely being passed
 * for show.
 */
function installHangingSendFetchStub(): {
  sends: Array<{ content: string | null; abortedBeforeResolve: boolean }>;
} {
  const sends: Array<{ content: string | null; abortedBeforeResolve: boolean }> = [];
  globalThis.fetch = vi.fn(async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

    if (url.includes("/members")) {
      return json({
        members: [
          { uid: HUMAN_UID, name: "Alice", robot: false },
          { uid: BOT_UID, name: "SelfBot", robot: true },
        ],
      });
    }
    if (url.includes("/mention_pref")) return json({ no_mention: false });
    if (url.includes("/md")) return json({ content: "", version: 0, updated_at: null, updated_by: "" });
    if (url.includes("/messages/sync")) return json({ messages: [] });
    if (url.includes("/readReceipt")) return json({});
    if (url.includes("/typing")) return json({});
    if (url.includes("/sendMessage")) {
      const body = init?.body ? JSON.parse(init.body) : null;
      const content: string | null = body?.payload?.content ?? null;
      const signal: AbortSignal | undefined = init?.signal;
      const record = { content, abortedBeforeResolve: false };
      sends.push(record);
      // If no signal was passed, the stub deliberately hangs forever and the
      // test will time out — that surfaces missing wiring loudly.
      if (!signal) {
        await new Promise<void>(() => {});
      }
      // Pre-aborted signal: don't wait for an event that already fired.
      if (signal.aborted) {
        record.abortedBeforeResolve = true;
        throw new Error("aborted");
      }
      await new Promise<void>((_, reject) => {
        signal.addEventListener("abort", () => {
          record.abortedBeforeResolve = true;
          reject(new Error("aborted"));
        }, { once: true });
      });
      return json({}); // unreachable
    }
    return json({});
  }) as unknown as typeof fetch;
  return { sends };
}

function installHangingRuntime(): { dispatch: ReturnType<typeof vi.fn> } {
  const dispatch = vi.fn(async () => {
    await new Promise<void>(() => {}); // never resolves, never rejects
  });
  setOctoRuntime({
    config: { loadConfig: () => ({}) },
    channel: {
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: dispatch,
        resolveEnvelopeFormatOptions: () => ({}),
        formatAgentEnvelope: ({ body }: any) => body,
        finalizeInboundContext: (ctx: any) => ctx,
      },
      routing: {
        resolveAgentRoute: () => ({ agentId: "agent1", sessionKey: "sk1", accountId: "acct1" }),
      },
      session: {
        resolveStorePath: () => "/tmp/store",
        readSessionUpdatedAt: () => undefined,
        recordInboundSession: async () => {},
      },
    },
  } as any);
  return { dispatch };
}

function installImmediateRuntime(deliverArgs?: { text?: string; kind?: string }) {
  const dispatch = vi.fn(async (args: any) => {
    if (deliverArgs) {
      await args.dispatcherOptions.deliver({ text: deliverArgs.text ?? "hi" }, { kind: deliverArgs.kind ?? "final" });
    }
  });
  setOctoRuntime({
    config: { loadConfig: () => ({}) },
    channel: {
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: dispatch,
        resolveEnvelopeFormatOptions: () => ({}),
        formatAgentEnvelope: ({ body }: any) => body,
        finalizeInboundContext: (ctx: any) => ctx,
      },
      routing: {
        resolveAgentRoute: () => ({ agentId: "agent1", sessionKey: "sk1", accountId: "acct1" }),
      },
      session: {
        resolveStorePath: () => "/tmp/store",
        readSessionUpdatedAt: () => undefined,
        recordInboundSession: async () => {},
      },
    },
  } as any);
  return { dispatch };
}

function pickTimeoutSends(sends: any[]) {
  return sends.filter(
    (body) => typeof body?.payload?.content === "string" && body.payload.content.includes("处理超时"),
  );
}

function runInbound(opts: { log?: any } = {}) {
  return handleInboundMessage({
    account: makeAccount(),
    message: makeAtBotMessage() as any,
    botUid: BOT_UID,
    groupHistories: new Map(),
    lastBotReplySeqMap: new Map(),
    memberMap: new Map(),
    uidToNameMap: new Map(),
    groupCacheTimestamps: new Map(),
    log: opts.log,
  });
}

beforeEach(() => {
  _clearKnownBots();
  _setDispatchTimeoutForTests(TIMEOUT_MS_FOR_TESTS);
  _setDispatchApologyTimeoutForTests(APOLOGY_TIMEOUT_MS_FOR_TESTS);
});

afterEach(() => {
  _setDispatchTimeoutForTests(null);
  _setDispatchApologyTimeoutForTests(null);
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  vi.restoreAllMocks();
});

describe("dispatch timeout guard (issue #75)", () => {
  it("hang: rejects after timeout, sends 处理超时 apology, would unblock per-group queue", async () => {
    const { dispatch } = installHangingRuntime();
    const { sends } = installFetchStub();
    const warnSpy = vi.fn();

    await expect(runInbound({ log: { debug: () => {}, info: () => {}, warn: warnSpy, error: () => {} } }))
      .rejects.toThrow();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(pickTimeoutSends(sends)).toHaveLength(1);
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("dispatch hung"))).toBe(true);
  });

  it("happy path: dispatchTimeoutHandle is cleared (no leaked timer)", async () => {
    // Spy on setTimeout/clearTimeout to find the specific dispatch-timeout
    // handle and verify it gets cleared. Filter by delay === TIMEOUT_MS_FOR_TESTS
    // which is unique (APOLOGY_TIMEOUT_MS_FOR_TESTS is intentionally different).
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout") as any;
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout") as any;

    installImmediateRuntime({ text: "hi", kind: "final" });
    installFetchStub();

    await runInbound({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } });

    const dispatchTimerCalls = setTimeoutSpy.mock.calls
      .map((call: any[], idx: number) => ({ delay: call[1], idx }))
      .filter((x: any) => x.delay === TIMEOUT_MS_FOR_TESTS);
    expect(dispatchTimerCalls.length).toBeGreaterThan(0);

    for (const c of dispatchTimerCalls) {
      const handle = setTimeoutSpy.mock.results[c.idx]?.value;
      expect(handle).toBeDefined();
      const cleared = clearTimeoutSpy.mock.calls.some((call: any[]) => call[0] === handle);
      expect(cleared, `dispatch-timeout handle from setTimeout call ${c.idx} was not cleared`).toBe(true);
    }
  });

  it("apology AbortSignal actually fires: sick API doesn't re-hang the queue", async () => {
    // Simulates the worst meta-case: the same Octo API that caused the
    // upstream dispatch to hang ALSO hangs when we try to POST the apology.
    // The apology's AbortSignal.timeout(APOLOGY_TIMEOUT_MS) must fire and
    // runInbound must still reject within bounded time — otherwise the fix
    // is self-defeating.
    installHangingRuntime();
    const { sends } = installHangingSendFetchStub();

    const start = Date.now();
    await expect(runInbound({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))
      .rejects.toThrow();
    const elapsed = Date.now() - start;
    expect(elapsed, "must settle within bound, not hang forever").toBeLessThan(2000);

    const apology = sends.find((s) => s.content?.includes("处理超时"));
    expect(apology, "apology sendMessage must reach fetch").toBeDefined();
    expect(apology!.abortedBeforeResolve, "apology must be aborted by its own AbortSignal.timeout").toBe(true);
  });

  it("happy-path final flush hang: bounded so per-group queue is not stranded", async () => {
    // Dispatch returns normally with a "block" kind (populates lastText, does
    // NOT set textSent), so the finally branch hits the final flush. The
    // Octo API hangs on that POST. Without bounding the final flush, the
    // function would hang forever even though dispatch succeeded.
    const dispatch = vi.fn(async (args: any) => {
      await args.dispatcherOptions.deliver({ text: "buffered-final" }, { kind: "block" });
    });
    setOctoRuntime({
      config: { loadConfig: () => ({}) },
      channel: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: dispatch,
          resolveEnvelopeFormatOptions: () => ({}),
          formatAgentEnvelope: ({ body }: any) => body,
          finalizeInboundContext: (ctx: any) => ctx,
        },
        routing: {
          resolveAgentRoute: () => ({ agentId: "agent1", sessionKey: "sk1", accountId: "acct1" }),
        },
        session: {
          resolveStorePath: () => "/tmp/store",
          readSessionUpdatedAt: () => undefined,
          recordInboundSession: async () => {},
        },
      },
    } as any);
    const { sends } = installHangingSendFetchStub();

    const start = Date.now();
    // Dispatch succeeded → handleInboundMessage does NOT reject; the final
    // flush error is caught + logged. Just verify it RESOLVES within bound.
    await runInbound({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);

    const finalFlush = sends.find((s) => s.content === "buffered-final");
    expect(finalFlush, "final flush sendMessage must reach fetch").toBeDefined();
    expect(finalFlush!.abortedBeforeResolve, "final flush must be aborted by its own AbortSignal.timeout").toBe(true);
  });
});
