import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleCardAction } from "./card-action-handler.js";
import { synthesizeCardActionMessage } from "./card-action.js";
import { _resetCardSessionsForTests, registerCardSession } from "./card-session.js";
import { startEventPoller, type EventCursorStore } from "./events-poll.js";
import type { BotMessage } from "./types.js";

describe("interactive card local integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetCardSessionsForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("events poll → claim → status edit → synthesized inbound → complete → ack", async () => {
    const requests: string[] = [];
    let eventsReturned = false;
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      requests.push(String(url));
      if (String(url).endsWith("/v1/bot/events")) {
        if (eventsReturned) return Response.json({ results: [] });
        eventsReturned = true;
        return Response.json({
          results: [{
            event_id: 101,
            event_type: "card_action",
            event_data: {
              message_id: "m1",
              channel_id: "g1",
              channel_type: 2,
              action_id: "approve",
              inputs: { reason: "looks good" },
              data: { workflow: "release" },
              operator_uid: "u1",
            },
          }],
        });
      }
      return new Response("");
    }) as typeof fetch;

    registerCardSession("m1", {
      sessionKey: "session-1",
      accountId: "account-1",
      channelId: "g1",
      channelType: 2,
      title: "发布确认",
      actionLabels: { approve: "批准" },
    });
    const cursorState = { value: 100 };
    const cursorStore: EventCursorStore = {
      load: async () => cursorState.value,
      save: async (value) => { cursorState.value = value; },
    };
    const inbound: BotMessage[] = [];
    const poller = startEventPoller({
      apiUrl: "https://api.test",
      botToken: "tok",
      intervalMs: 500,
      cursorStore,
      onCardAction: async (action) => {
        await handleCardAction({
          action,
          accountId: "account-1",
          apiUrl: "https://api.test",
          botToken: "tok",
          dispatch: async () => { inbound.push(synthesizeCardActionMessage(action, "bot-1")); },
        });
      },
    });

    await poller.ready;
    await vi.advanceTimersByTimeAsync(500);

    expect(cursorState.value).toBe(101);
    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toEqual(expect.objectContaining({
      from_uid: "u1",
      channel_id: "g1",
      message_id: "card_action:101",
    }));
    expect(inbound[0].payload.content).toContain('data={"workflow":"release"}');
    expect(requests.filter((url) => url.endsWith("/v1/bot/message/edit"))).toHaveLength(2);
    expect(requests).toContain("https://api.test/v1/bot/events/101/ack");
    poller.stop();
  });
});
