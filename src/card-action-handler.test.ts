import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api-fetch.js", () => ({ editCardMessage: vi.fn() }));

import { editCardMessage } from "./api-fetch.js";
import { handleCardAction } from "./card-action-handler.js";
import { _resetCardSessionsForTests, registerCardSession } from "./card-session.js";
import type { CardAction } from "./card-action.js";

const action = (overrides: Partial<CardAction> = {}): CardAction => ({
  eventId: 10,
  messageId: "m1",
  channelId: "g1",
  channelType: 2,
  actionId: "approve",
  inputs: { note: "ok" },
  operatorUid: "u1",
  ...overrides,
});

function register(): void {
  registerCardSession("m1", {
    sessionKey: "s1",
    accountId: "a1",
    channelId: "g1",
    channelType: 2,
    title: "发布确认",
    actionLabels: { approve: "批准" },
    maxInputTextBytes: 16,
    maxInputsBytes: 64,
  });
}

describe("handleCardAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetCardSessionsForTests();
    register();
    vi.mocked(editCardMessage).mockResolvedValue();
  });

  it("先显示处理中，dispatch 成功后显示完成并使用递增 card_seq", async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);
    expect(await handleCardAction({
      action: action(),
      accountId: "a1",
      apiUrl: "https://api.test",
      botToken: "tok",
      operatorName: "Alice",
      dispatch,
    })).toBe("completed");

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(editCardMessage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(editCardMessage).mock.calls[0][0]).toEqual(expect.objectContaining({
      profile: "octo/v2",
      cardSeq: 1,
    }));
    expect(vi.mocked(editCardMessage).mock.calls[1][0]).toEqual(expect.objectContaining({
      profile: "octo/v2",
      cardSeq: 2,
    }));
  });

  it("重复 event 或第二次点击不再 dispatch", async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);
    await handleCardAction({
      action: action(), accountId: "a1", apiUrl: "https://api.test", botToken: "tok", dispatch,
    });
    expect(await handleCardAction({
      action: action({ eventId: 11 }), accountId: "a1", apiUrl: "https://api.test", botToken: "tok", dispatch,
    })).toBe("duplicate");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("未知卡、账号/频道不匹配、未知 action 均 fail-safe 忽略", async () => {
    const dispatch = vi.fn();
    expect(await handleCardAction({
      action: action({ messageId: "missing" }), accountId: "a1", apiUrl: "x", botToken: "t", dispatch,
    })).toBe("ignored");
    expect(await handleCardAction({
      action: action(), accountId: "other", apiUrl: "x", botToken: "t", dispatch,
    })).toBe("ignored");
    expect(await handleCardAction({
      action: action({ channelId: "g2" }), accountId: "a1", apiUrl: "x", botToken: "t", dispatch,
    })).toBe("ignored");
    expect(await handleCardAction({
      action: action({ actionId: "forged" }), accountId: "a1", apiUrl: "x", botToken: "t", dispatch,
    })).toBe("ignored");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("inputs 超限时不 dispatch，并把原卡更新为失败", async () => {
    const dispatch = vi.fn();
    expect(await handleCardAction({
      action: action({ inputs: { note: "汉".repeat(20) } }),
      accountId: "a1", apiUrl: "x", botToken: "t", dispatch,
    })).toBe("rejected");
    expect(dispatch).not.toHaveBeenCalled();
    expect(editCardMessage).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(editCardMessage).mock.calls[0][0].card)).toContain("提交内容过大");
  });

  it("dispatch 失败时显示失败、释放 claim 并向 poller 抛错以便重试", async () => {
    const failure = new Error("agent unavailable");
    const dispatch = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
    await expect(handleCardAction({
      action: action(), accountId: "a1", apiUrl: "x", botToken: "t", dispatch,
    })).rejects.toThrow("agent unavailable");
    expect(JSON.stringify(vi.mocked(editCardMessage).mock.calls.at(-1)?.[0].card)).toContain("处理失败");

    await expect(handleCardAction({
      action: action(), accountId: "a1", apiUrl: "x", botToken: "t", dispatch,
    })).resolves.toBe("completed");
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});
