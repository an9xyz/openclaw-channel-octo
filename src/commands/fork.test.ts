import { describe, it, expect, vi } from "vitest";
import {
  parseForkCommand,
  deriveThreadName,
  isInsideThread,
  resolveForkScope,
  executeFork,
  type ForkOrchestrator,
} from "./fork.js";

describe("parseForkCommand", () => {
  it("parses `/fork hello` → ok with prompt", () => {
    expect(parseForkCommand("/fork hello")).toEqual({ ok: true, prompt: "hello" });
  });

  it("trims surrounding whitespace from the prompt", () => {
    expect(parseForkCommand("/fork   hello world  ")).toEqual({ ok: true, prompt: "hello world" });
  });

  it("captures multi-line prompts whole", () => {
    expect(parseForkCommand("/fork line1\nline2")).toEqual({ ok: true, prompt: "line1\nline2" });
  });

  it("bare `/fork` → empty", () => {
    expect(parseForkCommand("/fork")).toEqual({ ok: false, reason: "empty" });
  });

  it("`/fork   ` (whitespace only) → empty", () => {
    expect(parseForkCommand("/fork   ")).toEqual({ ok: false, reason: "empty" });
  });

  it("`/forks foo` → not_fork_command", () => {
    expect(parseForkCommand("/forks foo")).toEqual({ ok: false, reason: "not_fork_command" });
  });

  it("non-command text → not_fork_command", () => {
    expect(parseForkCommand("hello /fork")).toEqual({ ok: false, reason: "not_fork_command" });
  });

  it("is case-sensitive: `/Fork x` → not_fork_command", () => {
    expect(parseForkCommand("/Fork x")).toEqual({ ok: false, reason: "not_fork_command" });
  });

  it("trims the whole command body before matching: `  /fork x  ` → ok", () => {
    expect(parseForkCommand("  /fork x  ")).toEqual({ ok: true, prompt: "x" });
  });

  it("`  /fork  ` (padded, no prompt) → empty", () => {
    expect(parseForkCommand("  /fork  ")).toEqual({ ok: false, reason: "empty" });
  });
});

describe("deriveThreadName", () => {
  const fixedNow = () => new Date("2026-06-22T10:20:30.123Z");

  it("keeps a short English prompt verbatim", () => {
    expect(deriveThreadName("hello world", fixedNow)).toBe("hello world");
  });

  it("truncates a long Chinese prompt to 30 code points", () => {
    const prompt = "中".repeat(40);
    expect(deriveThreadName(prompt, fixedNow)).toBe("中".repeat(30));
  });

  it("counts astral emoji by code point without splitting surrogate pairs", () => {
    const prompt = "😀".repeat(31);
    const result = deriveThreadName(prompt, fixedNow);
    expect([...result]).toHaveLength(30);
    expect(result).toBe("😀".repeat(30));
  });

  it("empty string → ISO timestamp fallback without millis", () => {
    expect(deriveThreadName("", fixedNow)).toBe("Forked: 2026-06-22T10:20:30Z");
  });

  it("whitespace-only string → fallback", () => {
    expect(deriveThreadName("   \n\t ", fixedNow)).toBe("Forked: 2026-06-22T10:20:30Z");
  });

  it("trims leading/trailing whitespace before truncating", () => {
    expect(deriveThreadName("  hello  ", fixedNow)).toBe("hello");
  });

  it("two spaces → fallback timestamp", () => {
    expect(deriveThreadName("  ", fixedNow)).toBe("Forked: 2026-06-22T10:20:30Z");
  });

  it("boundary: exactly 30 chars kept verbatim", () => {
    const prompt = "a".repeat(30);
    expect(deriveThreadName(prompt, fixedNow)).toBe(prompt);
  });

  it("boundary: 31 chars truncated to 30", () => {
    const prompt = "a".repeat(31);
    expect(deriveThreadName(prompt, fixedNow)).toBe("a".repeat(30));
  });
});

describe("isInsideThread", () => {
  it("plain group channelId (no ____) → false", () => {
    expect(isInsideThread("group123")).toBe(false);
  });

  it("thread channelId (groupNo____shortId) → true", () => {
    expect(isInsideThread("group123____abc")).toBe(true);
  });

  it("multiple ____ separators → true", () => {
    expect(isInsideThread("group123____abc____def")).toBe(true);
  });
});

describe("resolveForkScope", () => {
  // Truth table across all four scopes × (isGroup, isOwnerUser, isExplicitBotMention).
  type Case = [boolean, boolean, boolean, boolean]; // isGroup, isOwner, mention, expected

  const tables: Record<string, Case[]> = {
    // DM → anyone; group → owner + mention.
    "owner-mentioned": [
      [false, false, false, true],
      [false, false, true, true],
      [false, true, false, true],
      [false, true, true, true],
      [true, false, false, false],
      [true, false, true, false],
      [true, true, false, false],
      [true, true, true, true],
    ],
    // DM → anyone; group → any member + mention.
    "any-mentioned": [
      [false, false, false, true],
      [false, false, true, true],
      [false, true, false, true],
      [false, true, true, true],
      [true, false, false, false],
      [true, false, true, true],
      [true, true, false, false],
      [true, true, true, true],
    ],
    // Must be owner everywhere; group still needs mention.
    "owner-only": [
      [false, false, false, false],
      [false, false, true, false],
      [false, true, false, true],
      [false, true, true, true],
      [true, false, false, false],
      [true, false, true, false],
      [true, true, false, false],
      [true, true, true, true],
    ],
    // Anyone, anywhere.
    "any": [
      [false, false, false, true],
      [false, false, true, true],
      [false, true, false, true],
      [false, true, true, true],
      [true, false, false, true],
      [true, false, true, true],
      [true, true, false, true],
      [true, true, true, true],
    ],
  };

  for (const [scope, cases] of Object.entries(tables)) {
    describe(`scope=${scope}`, () => {
      for (const [isGroup, isOwner, mention, expected] of cases) {
        it(`isGroup=${isGroup} owner=${isOwner} mention=${mention} → ${expected}`, () => {
          expect(resolveForkScope(scope, isGroup, isOwner, mention)).toBe(expected);
        });
      }
    });
  }

  it("undefined scope falls back to owner-mentioned", () => {
    // group + non-owner + mention → false under owner-mentioned
    expect(resolveForkScope(undefined, true, false, true)).toBe(false);
    // group + owner + mention → true
    expect(resolveForkScope(undefined, true, true, true)).toBe(true);
  });

  it("unknown scope value falls back to owner-mentioned", () => {
    expect(resolveForkScope("bogus", true, false, true)).toBe(false);
    expect(resolveForkScope("bogus", true, true, true)).toBe(true);
  });
});

describe("executeFork", () => {
  const fixedNow = () => new Date("2026-06-22T10:20:30.123Z");

  function makeDeps(overrides: Partial<ForkOrchestrator> = {}): ForkOrchestrator {
    return {
      spawnChildBoundSession: vi.fn(async () => ({ childChannelId: "group123____abc" })),
      sendParentReceipt: vi.fn(async () => {}),
      log: vi.fn(),
      ...overrides,
    };
  }

  const baseInput = {
    prompt: "explain the bug",
    parentChannelId: "group123",
    parentSessionKey: "octo:acct1:group123",
    now: fixedNow,
  };

  it("full success: spawns child session, sends plain receipt", async () => {
    const deps = makeDeps();
    const result = await executeFork(deps, baseInput);

    expect(result.status).toBe("ok");
    expect(result.threadName).toBe("explain the bug");
    expect(result.channelId).toBe("group123____abc");
    expect(result.nested).toBe(false);
    expect(result.replyText).toBe("已开 fork 子区：explain the bug");

    expect(deps.spawnChildBoundSession).toHaveBeenCalledWith({
      parentChannelId: "group123",
      parentSessionKey: "octo:acct1:group123",
      prompt: "explain the bug",
      threadName: "explain the bug",
    });
    expect(deps.sendParentReceipt).toHaveBeenCalledWith({ text: "已开 fork 子区：explain the bug" });
  });

  it("empty prompt: early-returns with usage hint, nothing spawned", async () => {
    const deps = makeDeps();
    const result = await executeFork(deps, { ...baseInput, prompt: "   " });

    expect(result.status).toBe("empty_prompt");
    expect(result.replyText).toBe("用法：/fork <你的问题>");
    expect(deps.spawnChildBoundSession).not.toHaveBeenCalled();
    expect(deps.sendParentReceipt).toHaveBeenCalledWith({ text: "用法：/fork <你的问题>" });
  });

  it("spawn failure: aborts with failure receipt", async () => {
    const deps = makeDeps({
      spawnChildBoundSession: vi.fn(async () => {
        throw new Error("thread quota exceeded");
      }),
    });
    const result = await executeFork(deps, baseInput);

    expect(result.status).toBe("spawn_failed");
    expect(result.channelId).toBeUndefined();
    expect(result.replyText).toBe("开 fork 子区失败：thread quota exceeded");
    expect(deps.sendParentReceipt).toHaveBeenCalledWith({ text: "开 fork 子区失败：thread quota exceeded" });
    expect(deps.log).toHaveBeenCalledWith(
      "error",
      "[fork] spawnChildBoundSession failed",
      expect.objectContaining({ error: "thread quota exceeded" }),
    );
  });

  it("nested fork: parent is already a thread → nested=true, logs info, flow proceeds", async () => {
    const deps = makeDeps();
    const result = await executeFork(deps, { ...baseInput, parentChannelId: "group123____parent" });

    expect(result.status).toBe("ok");
    expect(result.nested).toBe(true);
    expect(deps.spawnChildBoundSession).toHaveBeenCalledWith({
      parentChannelId: "group123____parent",
      parentSessionKey: "octo:acct1:group123",
      prompt: "explain the bug",
      threadName: "explain the bug",
    });
    expect(deps.log).toHaveBeenCalledWith(
      "info",
      "[fork] nested fork: parent is a thread",
      expect.objectContaining({ parentChannelId: "group123____parent" }),
    );
  });

  it("seed-failed: thread exists but dispatch failed → ok_seed_failed + retry receipt (I-1)", async () => {
    const deps = makeDeps({
      spawnChildBoundSession: vi.fn(async () => ({ childChannelId: "group123____abc", seedFailed: true })),
    });
    const result = await executeFork(deps, baseInput);

    expect(result.status).toBe("ok_seed_failed");
    expect(result.channelId).toBe("group123____abc");
    expect(result.threadName).toBe("explain the bug");
    expect(result.replyText).toBe("已开 fork 子区：explain the bug（首条问题处理失败，请到子区重发）");
    expect(deps.sendParentReceipt).toHaveBeenCalledWith({
      text: "已开 fork 子区：explain the bug（首条问题处理失败，请到子区重发）",
    });
  });

  it("receipt failure on the ok path: logged, swallowed, status stays ok (S-1)", async () => {
    const deps = makeDeps({
      sendParentReceipt: vi.fn(async () => {
        throw new Error("send timeout");
      }),
    });
    const result = await executeFork(deps, baseInput);

    expect(result.status).toBe("ok");
    expect(result.channelId).toBe("group123____abc");
    expect(deps.log).toHaveBeenCalledWith(
      "error",
      "[fork] sendParentReceipt failed",
      expect.objectContaining({ error: "send timeout" }),
    );
  });

  it("receipt failure on the empty-prompt path: logged, swallowed, status stays empty_prompt (S-1)", async () => {
    const deps = makeDeps({
      sendParentReceipt: vi.fn(async () => {
        throw new Error("send timeout");
      }),
    });
    const result = await executeFork(deps, { ...baseInput, prompt: "   " });

    expect(result.status).toBe("empty_prompt");
    expect(deps.log).toHaveBeenCalledWith(
      "error",
      "[fork] sendParentReceipt failed",
      expect.objectContaining({ error: "send timeout" }),
    );
  });

  it("receipt failure on the spawn-failed path: logged, swallowed, status stays spawn_failed (S-1)", async () => {
    const deps = makeDeps({
      spawnChildBoundSession: vi.fn(async () => {
        throw new Error("thread quota exceeded");
      }),
      sendParentReceipt: vi.fn(async () => {
        throw new Error("send timeout");
      }),
    });
    const result = await executeFork(deps, baseInput);

    expect(result.status).toBe("spawn_failed");
    // Both the spawn error and the receipt error are logged.
    expect(deps.log).toHaveBeenCalledWith(
      "error",
      "[fork] spawnChildBoundSession failed",
      expect.objectContaining({ error: "thread quota exceeded" }),
    );
    expect(deps.log).toHaveBeenCalledWith(
      "error",
      "[fork] sendParentReceipt failed",
      expect.objectContaining({ error: "send timeout" }),
    );
  });
});
