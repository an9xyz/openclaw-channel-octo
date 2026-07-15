import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFileEventCursorStore,
  startEventPoller,
  type EventCursorStore,
} from "./events-poll.js";
import type { CardAction } from "./card-action.js";

const actionEvent = (eventId: number) => ({
  event_id: eventId,
  event_type: "card_action",
  event_data: {
    message_id: `m${eventId}`,
    channel_id: "g1",
    channel_type: 2,
    action_id: "approve",
    operator_uid: "u1",
    inputs: {},
  },
});

function memoryCursor(initial = 0): EventCursorStore & { saved: number[] } {
  const state = { value: initial, saved: [] as number[] };
  return {
    saved: state.saved,
    load: async () => state.value,
    save: async (value) => {
      state.value = value;
      state.saved.push(value);
    },
  };
}

describe("event poller", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("从持久化 cursor 拉取，升序处理、保存后 ack", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      requests.push({ url: String(url), body });
      if (String(url).endsWith("/ack")) return new Response("");
      return Response.json({ results: [actionEvent(12), actionEvent(11)] });
    }) as typeof fetch;
    const cursor = memoryCursor(10);
    const seen: number[] = [];
    const poller = startEventPoller({
      apiUrl: "https://api.test",
      botToken: "bf_x",
      intervalMs: 1000,
      cursorStore: cursor,
      onCardAction: async (action: CardAction) => { seen.push(action.eventId); },
    });

    await poller.ready;
    await vi.advanceTimersByTimeAsync(1000);

    expect(requests[0].body).toEqual({ event_id: 10, limit: 50 });
    expect(seen).toEqual([11, 12]);
    expect(cursor.saved).toEqual([11, 12]);
    expect(requests.filter((request) => request.url.endsWith("/ack")).map((request) => request.url))
      .toEqual([
        "https://api.test/v1/bot/events/11/ack",
        "https://api.test/v1/bot/events/12/ack",
      ]);
    expect(poller.cursor()).toBe(12);
    poller.stop();
  });

  it("handler 失败时不保存、不 ack，下一轮可重试同一事件", async () => {
    const acked: string[] = [];
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).endsWith("/ack")) {
        acked.push(String(url));
        return new Response("");
      }
      return Response.json({ results: [actionEvent(21)] });
    }) as typeof fetch;
    const cursor = memoryCursor(20);
    const poller = startEventPoller({
      apiUrl: "https://api.test",
      botToken: "bf_x",
      intervalMs: 1000,
      cursorStore: cursor,
      onCardAction: async () => { throw new Error("dispatch failed"); },
    });

    await poller.ready;
    await vi.advanceTimersByTimeAsync(1000);

    expect(cursor.saved).toEqual([]);
    expect(acked).toEqual([]);
    expect(poller.cursor()).toBe(20);
    poller.stop();
  });

  it("非 card_action 不派发，但仍前移 cursor", async () => {
    global.fetch = vi.fn().mockResolvedValue(Response.json({
      results: [{ event_id: 31, event_type: "bot_joined_group", event_data: {} }],
    })) as typeof fetch;
    const cursor = memoryCursor(30);
    const onCardAction = vi.fn();
    const poller = startEventPoller({
      apiUrl: "https://api.test",
      botToken: "bf_x",
      intervalMs: 1000,
      cursorStore: cursor,
      onCardAction,
    });

    await poller.ready;
    await vi.advanceTimersByTimeAsync(1000);

    expect(onCardAction).not.toHaveBeenCalled();
    expect(cursor.saved).toEqual([31]);
    poller.stop();
  });

  it("stop 后不再发起后续轮询", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ results: [] }));
    global.fetch = fetchMock as typeof fetch;
    const poller = startEventPoller({
      apiUrl: "https://api.test",
      botToken: "bf_x",
      intervalMs: 1000,
      cursorStore: memoryCursor(),
      onCardAction: async () => {},
    });
    await poller.ready;
    poller.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("file event cursor store", () => {
  it("按账号持久化 event_id 并可在新实例恢复", async () => {
    const root = await mkdtemp(join(tmpdir(), "octo-events-"));
    try {
      const store = createFileEventCursorStore({ accountId: "Bot-A", baseDir: root });
      expect(await store.load()).toBe(0);
      await store.save(123);
      expect(await createFileEventCursorStore({ accountId: "bot-a", baseDir: root }).load()).toBe(123);
      expect(JSON.parse(await readFile(join(root, "bot-a", "events.cursor.json"), "utf8")))
        .toEqual({ event_id: 123 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
