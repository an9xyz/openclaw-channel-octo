import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetCardSessionsForTests,
  claimCardSession,
  completeCardSession,
  lookupCardSession,
  nextCardSessionSeq,
  registerCardSession,
  releaseCardSessionClaim,
} from "./card-session.js";
import { requestCardEventPolling } from "./events-poll.js";

vi.mock("./events-poll.js", () => ({ requestCardEventPolling: vi.fn() }));

const session = (suffix = "") => ({
  sessionKey: `s${suffix}`,
  accountId: "a1",
  channelId: "g1",
  channelType: 2,
  title: "确认",
  actionLabels: { approve: "批准" },
  maxInputTextBytes: 4096,
  maxInputsBytes: 16384,
} as const);

describe("card session registry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    _resetCardSessionsForTests();
  });
  afterEach(() => vi.useRealTimers());

  it("登记时启动所属账号 poller，并在 TTL 后失效", () => {
    registerCardSession("m1", session());
    expect(requestCardEventPolling).toHaveBeenCalledWith("a1");
    expect(lookupCardSession("m1")?.sessionKey).toBe("s");

    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);
    expect(lookupCardSession("m1")).toBeNull();
  });

  it("同一张卡只允许一个 event claim，失败释放后原事件可重试", () => {
    registerCardSession("m1", session());
    expect(claimCardSession("m1", 10).status).toBe("claimed");
    expect(claimCardSession("m1", 11).status).toBe("duplicate");

    releaseCardSessionClaim("m1", 10);
    expect(claimCardSession("m1", 10).status).toBe("claimed");
    completeCardSession("m1", 10);
    expect(claimCardSession("m1", 12).status).toBe("duplicate");
  });

  it("为同一张卡生成单调递增 card_seq", () => {
    registerCardSession("m1", session());
    expect(nextCardSessionSeq("m1")).toBe(1);
    expect(nextCardSessionSeq("m1")).toBe(2);
  });

  it("registry 有容量上限，超限淘汰最旧未使用记录", () => {
    for (let index = 0; index < 1001; index++) {
      registerCardSession(`m${index}`, session(String(index)));
    }
    expect(lookupCardSession("m0")).toBeNull();
    expect(lookupCardSession("m1000")).not.toBeNull();
  });
});
