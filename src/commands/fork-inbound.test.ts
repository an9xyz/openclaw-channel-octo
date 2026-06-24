import { describe, it, expect, vi, beforeEach } from "vitest";

// DM hint path calls the real `sendMessage` (api-fetch); group paths go through
// the injected mock orchestrator and never touch it. Mock so the DM test can
// assert the hint without a live API.
const { mockSendMessage } = vi.hoisted(() => ({ mockSendMessage: vi.fn(async () => ({})) }));
vi.mock("../api-fetch.js", () => ({
  sendMessage: mockSendMessage,
  createThread: vi.fn(),
}));

import { handleForkCommandIfMatched, type BuildForkOrchestratorFn } from "./fork-inbound.js";
import type { ForkOrchestrator } from "./fork.js";
import { ChannelType } from "../types.js";

const fixedNow = () => new Date("2026-06-22T10:20:30.123Z");

function makeOrchestrator(overrides: Partial<ForkOrchestrator> = {}) {
  const spawnChildBoundSession = vi.fn(async () => ({ childChannelId: "group123____new" }));
  const sendParentReceipt = vi.fn(async () => {});
  const orch: ForkOrchestrator = {
    spawnChildBoundSession,
    sendParentReceipt,
    log: vi.fn(),
    ...overrides,
  };
  const build: BuildForkOrchestratorFn = vi.fn(() => orch);
  return { orch, build, spawnChildBoundSession, sendParentReceipt };
}

const base = {
  commandAuthorized: true,
  isGroup: true,
  parentChannelId: "group123",
  parentChannelType: ChannelType.Group,
  parentSessionKey: "octo:acct1:group123",
  accountId: "acct1",
  apiUrl: "https://api.test",
  botToken: "bf_tok",
  requesterUid: "user_hash",
  requesterName: "刘建辉",
  config: {} as never,
  now: fixedNow,
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
};

describe("handleForkCommandIfMatched", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("non-fork message → false (falls through, nothing built)", async () => {
    const { build, spawnChildBoundSession } = makeOrchestrator();
    const handled = await handleForkCommandIfMatched({
      ...base,
      commandBody: "hello there",
      buildOrchestrator: build,
    });
    expect(handled).toBe(false);
    expect(build).not.toHaveBeenCalled();
    expect(spawnChildBoundSession).not.toHaveBeenCalled();
  });

  it("/fork in a DM → true (hint sent, swallowed — never reaches the LLM)", async () => {
    const { build } = makeOrchestrator();
    const handled = await handleForkCommandIfMatched({
      ...base,
      isGroup: false,
      commandBody: "/fork explain this",
      buildOrchestrator: build,
    });
    expect(handled).toBe(true); // swallowed, not sent to LLM as ordinary text
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: "/fork 仅在群聊中可用" }),
    );
    expect(build).not.toHaveBeenCalled(); // no thread spawned in a DM
  });

  it("/fork in a DM, sendMessage throws → still true (swallowed), error logged, never bubbles", async () => {
    const { build } = makeOrchestrator();
    mockSendMessage.mockRejectedValueOnce(new Error("network down"));
    // If the throw bubbled, this await would reject and the test would fail —
    // so resolving to `true` is itself the no-bubble assertion (I1).
    const handled = await handleForkCommandIfMatched({
      ...base,
      isGroup: false,
      commandBody: "/fork explain this",
      buildOrchestrator: build,
    });
    expect(handled).toBe(true); // hint-send failure must not change swallow semantics
    expect(
      (base.log as unknown as { error: ReturnType<typeof vi.fn> }).error,
    ).toHaveBeenCalledWith(expect.stringContaining("DM hint send failed"));
    expect(build).not.toHaveBeenCalled();
  });

  it("non-fork text in a DM → false (normal DM conversation unaffected)", async () => {
    const { build } = makeOrchestrator();
    const handled = await handleForkCommandIfMatched({
      ...base,
      isGroup: false,
      commandBody: "hello there",
      buildOrchestrator: build,
    });
    expect(handled).toBe(false);
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });

  it("unauthorized /fork in group → true (swallowed), nothing built", async () => {
    const { build, spawnChildBoundSession } = makeOrchestrator();
    const handled = await handleForkCommandIfMatched({
      ...base,
      commandAuthorized: false,
      commandBody: "/fork explain this",
      buildOrchestrator: build,
    });
    expect(handled).toBe(true); // swallowed — never reaches the LLM
    expect(build).not.toHaveBeenCalled();
    expect(spawnChildBoundSession).not.toHaveBeenCalled();
  });

  it("authorized /fork → true, spawns child + sends receipt", async () => {
    const { build, spawnChildBoundSession, sendParentReceipt } = makeOrchestrator();
    const handled = await handleForkCommandIfMatched({
      ...base,
      commandBody: "/fork explain the bug",
      buildOrchestrator: build,
    });
    expect(handled).toBe(true);
    expect(spawnChildBoundSession).toHaveBeenCalledWith({
      parentChannelId: "group123",
      parentSessionKey: "octo:acct1:group123",
      prompt: "explain the bug",
      threadName: "explain the bug",
    });
    expect(sendParentReceipt).toHaveBeenCalledWith({ text: "已开 fork 子区：explain the bug" });
  });

  it("passes requester identity + clock into the orchestrator builder", async () => {
    const { build } = makeOrchestrator();
    await handleForkCommandIfMatched({
      ...base,
      commandBody: "/fork x",
      buildOrchestrator: build,
    });
    expect(build).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acct1",
        requesterUid: "user_hash",
        requesterName: "刘建辉",
        apiUrl: "https://api.test",
        botToken: "bf_tok",
      }),
    );
  });

  it("empty `/fork` (authorized) → true, usage hint, no spawn", async () => {
    const { build, spawnChildBoundSession, sendParentReceipt } = makeOrchestrator();
    const handled = await handleForkCommandIfMatched({
      ...base,
      commandBody: "/fork",
      buildOrchestrator: build,
    });
    expect(handled).toBe(true);
    expect(spawnChildBoundSession).not.toHaveBeenCalled();
    expect(sendParentReceipt).toHaveBeenCalledWith({ text: "用法：/fork <你的问题>" });
  });

  it("nested fork (parent is a thread) → handled; thread parentChannelId threaded through", async () => {
    const { build, spawnChildBoundSession } = makeOrchestrator();
    const handled = await handleForkCommandIfMatched({
      ...base,
      parentChannelId: "group123____parent",
      parentChannelType: ChannelType.CommunityTopic,
      parentSessionKey: "octo:acct1:group123____parent",
      commandBody: "/fork dig deeper",
      buildOrchestrator: build,
    });
    expect(handled).toBe(true);
    // sibling-thread derivation (extractParentGroupNo) is covered in
    // fork-runtime.test.ts; here we assert the thread channelId is passed through.
    expect(spawnChildBoundSession).toHaveBeenCalledWith(
      expect.objectContaining({ parentChannelId: "group123____parent" }),
    );
  });
});
