import { describe, it, expect, vi } from "vitest";
import { isSessionInitConflict, runWithSessionInitRetry } from "./session-retry.js";

describe("isSessionInitConflict", () => {
  it("命中 core 的会话初始化冲突错误", () => {
    expect(isSessionInitConflict(new Error("reply session initialization conflicted for agent:main:octo:group:x"))).toBe(true);
    expect(isSessionInitConflict("reply session initialization conflicted for x")).toBe(true);
  });
  it("其它错误不命中", () => {
    expect(isSessionInitConflict(new Error("dispatch timed out after 60000ms"))).toBe(false);
    expect(isSessionInitConflict(new Error("boom"))).toBe(false);
    expect(isSessionInitConflict(undefined)).toBe(false);
    expect(isSessionInitConflict(null)).toBe(false);
  });
});

describe("runWithSessionInitRetry", () => {
  const noSleep = vi.fn(async () => {});

  it("首次成功 → 只跑一次,不 sleep", async () => {
    const task = vi.fn(async () => {});
    const sleep = vi.fn(async () => {});
    await runWithSessionInitRetry(task, { retries: 2, backoffMs: 750, sleep });
    expect(task).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("冲突后成功 → 重试,sleep 一次(线性退避)", async () => {
    let n = 0;
    const task = vi.fn(async () => {
      n++;
      if (n === 1) throw new Error("reply session initialization conflicted for x");
    });
    const sleep = vi.fn(async () => {});
    await runWithSessionInitRetry(task, { retries: 2, backoffMs: 750, sleep });
    expect(task).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(750); // 第 1 次退避 = backoffMs*1
  });

  it("持续冲突超重试上限 → 最终抛,跑 retries+1 次", async () => {
    const task = vi.fn(async () => {
      throw new Error("reply session initialization conflicted for x");
    });
    const sleeps: number[] = [];
    const sleep = vi.fn(async (ms: number) => { sleeps.push(ms); });
    await expect(
      runWithSessionInitRetry(task, { retries: 2, backoffMs: 750, sleep }),
    ).rejects.toThrow(/conflicted/);
    expect(task).toHaveBeenCalledTimes(3); // 1 + 2 retries
    expect(sleeps).toEqual([750, 1500]); // 线性退避
  });

  it("非冲突错误 → 立即抛,不重试不 sleep", async () => {
    const task = vi.fn(async () => {
      throw new Error("dispatch timed out after 60000ms");
    });
    const sleep = vi.fn(async () => {});
    await expect(
      runWithSessionInitRetry(task, { retries: 2, backoffMs: 750, sleep }),
    ).rejects.toThrow(/timed out/);
    expect(task).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries=0 → 冲突即抛,不重试", async () => {
    const task = vi.fn(async () => {
      throw new Error("reply session initialization conflicted for x");
    });
    await expect(
      runWithSessionInitRetry(task, { retries: 0, backoffMs: 750, sleep: noSleep }),
    ).rejects.toThrow(/conflicted/);
    expect(task).toHaveBeenCalledTimes(1);
  });
});
