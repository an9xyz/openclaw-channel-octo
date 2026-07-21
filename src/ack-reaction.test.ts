import { describe, it, expect, vi, afterEach } from "vitest";
import { maybeCreateAckReaction } from "./inbound.js";
import { ChannelType } from "./types.js";

// maybeCreateAckReaction is the pure, opt-in gate for the Discord-style 👀
// ack-before-reply. It resolves the emoji + scope from config, applies the
// shared SDK gate, and (when it fires) creates a handle whose send() calls the
// bot reaction endpoint via sendReaction → fetch. We mock global.fetch and
// assert the reaction POST (or its absence).

const originalFetch = globalThis.fetch;

function reactionFetch() {
  const calls: { url: string; body: any }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/v1/bot/message/reaction")) {
      calls.push({ url, body: JSON.parse(init?.body as string) });
      return new Response(JSON.stringify({ is_deleted: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const base = {
  agentId: "agent1",
  accountId: "default",
  apiUrl: "http://localhost:8090",
  botToken: "tok",
  channelId: "grp1",
  channelType: ChannelType.Group,
  messageId: "555",
  requireMention: true,
};

describe("maybeCreateAckReaction", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("is opt-in: returns null when ackReactionScope is unset (default OFF)", () => {
    const { fn, calls } = reactionFetch();
    globalThis.fetch = fn;
    const handle = maybeCreateAckReaction({
      ...base,
      config: { channels: { octo: {} } } as any,
      accountConfig: {},
      isGroup: true,
      isMentioned: true,
    });
    expect(handle).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null when scope is explicitly off", () => {
    const { fn } = reactionFetch();
    globalThis.fetch = fn;
    const handle = maybeCreateAckReaction({
      ...base,
      config: { channels: { octo: { ackReactionScope: "off" } } } as any,
      accountConfig: {},
      isGroup: true,
      isMentioned: true,
    });
    expect(handle).toBeNull();
  });

  it("fires the default 👀 when scope=all", async () => {
    const { fn, calls } = reactionFetch();
    globalThis.fetch = fn;
    const handle = maybeCreateAckReaction({
      ...base,
      config: { channels: { octo: { ackReactionScope: "all" } } } as any,
      accountConfig: {},
      isGroup: true,
      isMentioned: false,
    });
    expect(handle).not.toBeNull();
    await handle?.ackReactionPromise;
    expect(calls).toHaveLength(1);
    expect(calls[0].body.message_id).toBe("555");
    expect(calls[0].body.channel_id).toBe("grp1");
    expect(calls[0].body.emoji).toBe("👀");
    expect(calls[0].body.action).toBe("add");
  });

  it("uses a configured ackReaction emoji", async () => {
    const { fn, calls } = reactionFetch();
    globalThis.fetch = fn;
    const handle = maybeCreateAckReaction({
      ...base,
      config: { channels: { octo: { ackReactionScope: "all", ackReaction: "✅" } } } as any,
      accountConfig: { ackReactionScope: "all" },
      isGroup: true,
      isMentioned: false,
    });
    await handle?.ackReactionPromise;
    expect(calls[0].body.emoji).toBe("✅");
  });

  it("group-mentions scope skips when not mentioned and fires when mentioned", async () => {
    const a = reactionFetch();
    globalThis.fetch = a.fn;
    const notMentioned = maybeCreateAckReaction({
      ...base,
      config: {} as any,
      accountConfig: { ackReactionScope: "group-mentions" },
      isGroup: true,
      isMentioned: false,
    });
    expect(notMentioned).toBeNull();
    expect(a.calls).toHaveLength(0);

    const b = reactionFetch();
    globalThis.fetch = b.fn;
    const mentioned = maybeCreateAckReaction({
      ...base,
      config: {} as any,
      accountConfig: { ackReactionScope: "group-mentions" },
      isGroup: true,
      isMentioned: true,
    });
    expect(mentioned).not.toBeNull();
    await mentioned?.ackReactionPromise;
    expect(b.calls).toHaveLength(1);
  });

  it("account-level ackReactionScope overrides channel-level", () => {
    const { fn, calls } = reactionFetch();
    globalThis.fetch = fn;
    // channel says "all", account overrides to "off" → no reaction.
    const handle = maybeCreateAckReaction({
      ...base,
      config: { channels: { octo: { ackReactionScope: "all" } } } as any,
      accountConfig: { ackReactionScope: "off" },
      isGroup: true,
      isMentioned: true,
    });
    expect(handle).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null without a messageId", () => {
    const handle = maybeCreateAckReaction({
      ...base,
      messageId: undefined,
      config: { channels: { octo: { ackReactionScope: "all" } } } as any,
      accountConfig: {},
      isGroup: true,
      isMentioned: true,
    });
    expect(handle).toBeNull();
  });
});
