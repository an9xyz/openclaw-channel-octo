import { describe, it, expect, vi } from "vitest";
import {
  assembleForkSeedContext,
  buildForkOrchestrator,
  type CreateThreadFn,
  type ForkRuntimeDeps,
} from "./fork-runtime.js";

const fixedNow = () => new Date("2026-06-22T10:20:30.123Z");

function makeRuntimeDeps(overrides: Partial<ForkRuntimeDeps> = {}): ForkRuntimeDeps {
  return {
    apiUrl: "https://api.example.test",
    botToken: "bf_token",
    accountId: "acct1",
    commandAuthorized: true,
    requesterUid: "user_hash_32",
    requesterName: "刘建辉",
    now: fixedNow,
    log: vi.fn(),
    sendParentReceipt: vi.fn(async () => {}),
    createThread: vi.fn(async () => ({ short_id: "abc", name: "n", creator_uid: "bot" })),
    dispatchSeed: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("assembleForkSeedContext", () => {
  const deps = makeRuntimeDeps();

  const ctx = assembleForkSeedContext({
    deps,
    childChannelId: "group123____abc",
    parentSessionKey: "octo:acct1:group123",
    prompt: "explain the bug",
  });

  it("sets the prompt across all body fields", () => {
    expect(ctx.Body).toBe("explain the bug");
    expect(ctx.BodyForAgent).toBe("explain the bug");
    expect(ctx.RawBody).toBe("explain the bug");
    expect(ctx.CommandBody).toBe("explain the bug");
    expect(ctx.BodyForCommands).toBe("explain the bug");
  });

  it("sets ParentSessionKey === ModelParentSessionKey === parent key (drives auto-fork)", () => {
    expect(ctx.ParentSessionKey).toBe("octo:acct1:group123");
    expect(ctx.ModelParentSessionKey).toBe("octo:acct1:group123");
  });

  it("omits SessionKey (resolved at the stage-2 dispatch seam)", () => {
    expect("SessionKey" in ctx).toBe(false);
  });

  it("attributes the seed to the fork requester", () => {
    expect(ctx.SenderId).toBe("user_hash_32");
    expect(ctx.SenderName).toBe("刘建辉");
    expect(ctx.SenderUsername).toBe("user_hash_32");
    expect(ctx.From).toBe("octo:user_hash_32");
  });

  it("routes To / OriginatingTo / GroupSubject / ConversationLabel at the child channel", () => {
    expect(ctx.To).toBe("octo:group123____abc");
    expect(ctx.OriginatingTo).toBe("octo:group123____abc");
    expect(ctx.GroupSubject).toBe("group123____abc");
    expect(ctx.ConversationLabel).toBe("group:group123____abc");
  });

  it("marks the seed non-mention, group, octo surface", () => {
    expect(ctx.WasMentioned).toBe(false);
    expect(ctx.ChatType).toBe("group");
    expect(ctx.Provider).toBe("octo");
    expect(ctx.Surface).toBe("octo");
    expect(ctx.OriginatingChannel).toBe("octo");
    expect(ctx.AccountId).toBe("acct1");
  });

  it("threads CommandAuthorized from deps (not hardcoded) — true and false propagate", () => {
    // v1 path: requester is owner-mentioned-authorized.
    expect(ctx.CommandAuthorized).toBe(true);
    // v1.1 guard: a non-owner requester (commandAuthorized=false) must NOT get an
    // authorized seed, even if a widened fork scope let them reach here.
    const unauth = assembleForkSeedContext({
      deps: makeRuntimeDeps({ commandAuthorized: false }),
      childChannelId: "group123____abc",
      parentSessionKey: "octo:acct1:group123",
      prompt: "x",
    });
    expect(unauth.CommandAuthorized).toBe(false);
  });

  it("stamps a synthetic MessageSid and the injected clock", () => {
    expect(ctx.MessageSid).toBe("fork-seed:group123____abc");
    expect(ctx.Timestamp).toBe(new Date("2026-06-22T10:20:30.123Z").getTime());
  });

  it("includes GroupSystemPrompt only when provided", () => {
    expect("GroupSystemPrompt" in ctx).toBe(false);
    const withPrompt = assembleForkSeedContext({
      deps: makeRuntimeDeps({ groupSystemPrompt: "be terse" }),
      childChannelId: "g____a",
      parentSessionKey: "k",
      prompt: "p",
    });
    expect(withPrompt.GroupSystemPrompt).toBe("be terse");
  });
});

describe("buildForkOrchestrator.spawnChildBoundSession", () => {
  it("creates the thread under the parent group and returns the child channelId", async () => {
    const deps = makeRuntimeDeps();
    const orch = buildForkOrchestrator(deps);

    const result = await orch.spawnChildBoundSession({
      parentChannelId: "group123",
      parentSessionKey: "octo:acct1:group123",
      prompt: "explain the bug",
      threadName: "explain the bug",
    });

    expect(result).toEqual({ childChannelId: "group123____abc" });
    expect(deps.createThread).toHaveBeenCalledWith({
      apiUrl: "https://api.example.test",
      botToken: "bf_token",
      groupNo: "group123",
      name: "explain the bug",
    });
  });

  it("dispatches the assembled seed context through the seam", async () => {
    const dispatchSeed = vi.fn(async () => {});
    const deps = makeRuntimeDeps({ dispatchSeed });
    const orch = buildForkOrchestrator(deps);

    await orch.spawnChildBoundSession({
      parentChannelId: "group123",
      parentSessionKey: "octo:acct1:group123",
      prompt: "explain the bug",
      threadName: "explain the bug",
    });

    expect(dispatchSeed).toHaveBeenCalledTimes(1);
    const seedCtx = dispatchSeed.mock.calls[0][0];
    expect(seedCtx.ParentSessionKey).toBe("octo:acct1:group123");
    expect(seedCtx.To).toBe("octo:group123____abc");
    expect(seedCtx.Body).toBe("explain the bug");
  });

  it("derives the parent group from a nested-thread parent channelId", async () => {
    const deps = makeRuntimeDeps();
    const orch = buildForkOrchestrator(deps);

    const result = await orch.spawnChildBoundSession({
      parentChannelId: "group123____parent",
      parentSessionKey: "octo:acct1:group123____parent",
      prompt: "p",
      threadName: "p",
    });

    expect(deps.createThread).toHaveBeenCalledWith(expect.objectContaining({ groupNo: "group123" }));
    expect(result.childChannelId).toBe("group123____abc");
  });

  it("propagates createThread failures", async () => {
    const deps = makeRuntimeDeps({
      createThread: vi.fn(async () => {
        throw new Error("thread quota exceeded");
      }) as unknown as CreateThreadFn,
    });
    const orch = buildForkOrchestrator(deps);

    await expect(
      orch.spawnChildBoundSession({
        parentChannelId: "group123",
        parentSessionKey: "k",
        prompt: "p",
        threadName: "p",
      }),
    ).rejects.toThrow("thread quota exceeded");
  });

  it("without a dispatch seam: still creates thread + warns (1b payload-only)", async () => {
    const deps = makeRuntimeDeps({ dispatchSeed: undefined });
    const orch = buildForkOrchestrator(deps);

    const result = await orch.spawnChildBoundSession({
      parentChannelId: "group123",
      parentSessionKey: "k",
      prompt: "p",
      threadName: "p",
    });

    expect(result.childChannelId).toBe("group123____abc");
    expect(deps.log).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("dispatch seam not wired"),
      expect.objectContaining({ childChannelId: "group123____abc" }),
    );
  });

  it("dispatchSeed failure does NOT mask the created thread → returns seedFailed (I-1)", async () => {
    const createThread = vi.fn(async () => ({ short_id: "abc", name: "n", creator_uid: "bot" }));
    const dispatchSeed = vi.fn(async () => {
      throw new Error("dispatch boom");
    });
    const deps = makeRuntimeDeps({ createThread, dispatchSeed });
    const orch = buildForkOrchestrator(deps);

    const result = await orch.spawnChildBoundSession({
      parentChannelId: "group123",
      parentSessionKey: "octo:acct1:group123",
      prompt: "explain the bug",
      threadName: "explain the bug",
    });

    // Thread was created and the dispatch error is swallowed into a flag, not thrown.
    expect(createThread).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ childChannelId: "group123____abc", seedFailed: true });
  });

  it("dispatchSeed failure is logged as error with the child channelId (I-1)", async () => {
    const dispatchSeed = vi.fn(async () => {
      throw new Error("dispatch boom");
    });
    const deps = makeRuntimeDeps({ dispatchSeed });
    const orch = buildForkOrchestrator(deps);

    await orch.spawnChildBoundSession({
      parentChannelId: "group123",
      parentSessionKey: "k",
      prompt: "p",
      threadName: "p",
    });

    expect(deps.log).toHaveBeenCalledWith(
      "error",
      "[fork] seed dispatch failed; child thread already exists",
      expect.objectContaining({ childChannelId: "group123____abc", error: "dispatch boom" }),
    );
  });

  it("fires inheritParentMd with the child group/shortId and parent channelId", async () => {
    const inheritParentMd = vi.fn(async () => "ok" as const);
    const deps = makeRuntimeDeps({ inheritParentMd });
    const orch = buildForkOrchestrator(deps);

    await orch.spawnChildBoundSession({
      parentChannelId: "group123____parent",
      parentSessionKey: "k",
      prompt: "p",
      threadName: "p",
    });

    expect(inheritParentMd).toHaveBeenCalledWith(
      expect.objectContaining({
        apiUrl: "https://api.example.test",
        botToken: "bf_token",
        parentChannelId: "group123____parent",
        childGroupNo: "group123",
        childShortId: "abc",
      }),
    );
  });

  it("does NOT await inheritParentMd: a hanging copy never blocks the fork", async () => {
    // inherit never resolves; spawnChildBoundSession must still complete.
    const inheritParentMd = vi.fn(() => new Promise<"ok">(() => {}));
    const deps = makeRuntimeDeps({ inheritParentMd });
    const orch = buildForkOrchestrator(deps);

    const result = await orch.spawnChildBoundSession({
      parentChannelId: "group123",
      parentSessionKey: "k",
      prompt: "p",
      threadName: "p",
    });

    expect(result.childChannelId).toBe("group123____abc");
    expect(inheritParentMd).toHaveBeenCalledTimes(1);
  });
});
