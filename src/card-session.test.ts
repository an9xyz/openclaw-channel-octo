import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetCardSessionsForTests,
  claimCardSession,
  completeCardSession,
  forgetCardSession,
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
  card: { type: "AdaptiveCard", body: [{ type: "TextBlock", text: "确认" }] },
  plain: "确认",
  actionLabels: { approve: "批准" },
  inputIds: ["note"],
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
    expect(lookupCardSession("m1")?.card).toEqual(expect.objectContaining({ type: "AdaptiveCard" }));
    expect(lookupCardSession("m1")?.plain).toBe("确认");

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

  it("空 message_id 不登记；同 id 重登会替换旧 session", () => {
    registerCardSession("   ", session());
    expect(requestCardEventPolling).not.toHaveBeenCalled();

    registerCardSession("m1", session("-old"));
    registerCardSession("m1", session("-new"));
    expect(lookupCardSession("m1")?.sessionKey).toBe("s-new");
  });

  it("登记新卡时清理过期项，且支持显式忘记", () => {
    registerCardSession("expired", session("-expired"));
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);
    registerCardSession("current", session("-current"));
    expect(lookupCardSession("expired")).toBeNull();

    forgetCardSession("current");
    expect(lookupCardSession("current")).toBeNull();
  });

  it("缺失或 claim 不匹配时状态操作是安全空操作", () => {
    expect(claimCardSession("missing", 1)).toEqual({ status: "missing" });
    expect(nextCardSessionSeq("missing")).toBeUndefined();

    registerCardSession("m1", session());
    releaseCardSessionClaim("m1", 1);
    completeCardSession("m1", 1);
    expect(claimCardSession("m1", 2).status).toBe("claimed");
    releaseCardSessionClaim("m1", 999);
    completeCardSession("m1", 999);
    expect(claimCardSession("m1", 3).status).toBe("duplicate");
  });
});
