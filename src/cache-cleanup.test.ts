import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock api-fetch before importing channel (channel imports api-fetch indirectly)
vi.mock("./api-fetch.js", () => ({
  sendMessage: vi.fn(),
  sendMediaMessage: vi.fn(),
  getUploadPresign: vi.fn(),
  uploadFileToPresignedUrl: vi.fn(),
  inferContentType: () => "text/plain",
  ensureTextCharset: (s: string) => s,
  parseImageDimensions: () => null,
  parseImageDimensionsFromFile: async () => null,
  registerBot: vi.fn(),
  sendHeartbeat: vi.fn(),
  fetchBotGroups: vi.fn().mockResolvedValue([]),
  getGroupMembers: vi.fn().mockResolvedValue([]),
  getGroupMd: vi.fn(),
}));

import {
  touchCache,
  cleanupStaleCaches,
  _testGetCacheActivity,
  _testGetGroupCacheTimestamps,
  _testGetCurrentGroupMembersMaps,
  _testGetMemberMaps,
  _testResetCaches,
} from "./channel.js";

// CACHE_MAX_AGE_MS = 4h in channel.ts
const CACHE_MAX_AGE_MS = 4 * 60 * 60 * 1000;

describe("Issue #128: cleanupStaleCaches parent-key cache reclamation", () => {
  const ACCOUNT = "test-account-1";

  beforeEach(() => {
    _testResetCaches();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-27T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reclaims parent-keyed _groupCacheTimestamps when thread goes stale", () => {
    // Simulate: thread channel_id = "GROUP1____thread1"
    // refreshGroupMemberCache writes _groupCacheTimestamps under parent groupNo "GROUP1"
    const threadChannelId = "GROUP1____thread1";
    const parentGroupNo = "GROUP1";

    // touchCache records raw channel_id (as inbound.ts does at line 1409)
    touchCache(ACCOUNT, threadChannelId);

    // refreshGroupMemberCache writes timestamp under parent groupNo
    const timestamps = _testGetGroupCacheTimestamps();
    const accountTimestamps = new Map<string, number>();
    accountTimestamps.set(parentGroupNo, Date.now());
    timestamps.set(ACCOUNT, accountTimestamps);

    // Advance time past cache max age
    vi.advanceTimersByTime(CACHE_MAX_AGE_MS + 1000);

    // Run cleanup
    cleanupStaleCaches();

    // The parent-keyed timestamp should be reclaimed
    expect(timestamps.get(ACCOUNT)?.has(parentGroupNo)).toBe(false);
  });

  it("reclaims parent-keyed _currentGroupMembersMaps when thread goes stale", () => {
    const threadChannelId = "GROUP2____threadA";
    const parentGroupNo = "GROUP2";

    touchCache(ACCOUNT, threadChannelId);

    // Simulate refreshGroupMemberCache populating the roster under parent groupNo
    const membersMaps = _testGetCurrentGroupMembersMaps();
    const accountMembers = new Map<string, any[]>();
    accountMembers.set(parentGroupNo, [{ uid: "u1", name: "Alice" }]);
    membersMaps.set(ACCOUNT, accountMembers);

    vi.advanceTimersByTime(CACHE_MAX_AGE_MS + 1000);
    cleanupStaleCaches();

    expect(membersMaps.get(ACCOUNT)?.has(parentGroupNo)).toBe(false);
  });

  it("does NOT evict parent-keyed cache when a sibling thread is still active", () => {
    const thread1 = "GROUP3____thread1"; // will go stale
    const thread2 = "GROUP3____thread2"; // still active
    const parentGroupNo = "GROUP3";

    // Both threads were active at t=0
    touchCache(ACCOUNT, thread1);
    touchCache(ACCOUNT, thread2);

    // Populate parent-keyed caches
    const timestamps = _testGetGroupCacheTimestamps();
    const accountTimestamps = new Map<string, number>();
    accountTimestamps.set(parentGroupNo, Date.now());
    timestamps.set(ACCOUNT, accountTimestamps);

    const membersMaps = _testGetCurrentGroupMembersMaps();
    const accountMembers = new Map<string, any[]>();
    accountMembers.set(parentGroupNo, [{ uid: "u1", name: "Alice" }]);
    membersMaps.set(ACCOUNT, accountMembers);

    // Advance time — thread1 goes stale, but advance only partway
    vi.advanceTimersByTime(CACHE_MAX_AGE_MS + 1000);

    // "Refresh" thread2 (simulating a new message arriving)
    touchCache(ACCOUNT, thread2);

    cleanupStaleCaches();

    // Parent-keyed cache should still be present (thread2 is active)
    expect(timestamps.get(ACCOUNT)?.has(parentGroupNo)).toBe(true);
    expect(membersMaps.get(ACCOUNT)?.has(parentGroupNo)).toBe(true);

    // But the stale thread1 raw key should be removed from activity
    expect(_testGetCacheActivity().get(ACCOUNT)?.has(thread1)).toBe(false);
    // Active thread2 should still be in activity
    expect(_testGetCacheActivity().get(ACCOUNT)?.has(thread2)).toBe(true);
  });

  it("evicts parent-keyed cache only when ALL sibling threads are stale", () => {
    const thread1 = "GROUP4____t1";
    const thread2 = "GROUP4____t2";
    const parentGroupNo = "GROUP4";

    touchCache(ACCOUNT, thread1);
    touchCache(ACCOUNT, thread2);

    const timestamps = _testGetGroupCacheTimestamps();
    const accountTimestamps = new Map<string, number>();
    accountTimestamps.set(parentGroupNo, Date.now());
    timestamps.set(ACCOUNT, accountTimestamps);

    // Advance past max age — both stale
    vi.advanceTimersByTime(CACHE_MAX_AGE_MS + 1000);
    cleanupStaleCaches();

    // Now the parent-keyed entry should be gone
    expect(timestamps.get(ACCOUNT)?.has(parentGroupNo)).toBe(false);
  });

  it("still correctly cleans raw-keyed caches (plain group, no thread)", () => {
    // Plain group channel (no ____ suffix)
    const plainGroup = "GROUP5";

    touchCache(ACCOUNT, plainGroup);

    // Raw-keyed maps
    const memberMaps = _testGetMemberMaps();
    const accountMembers = new Map<string, string>();
    accountMembers.set(plainGroup, "Alice");
    memberMaps.set(ACCOUNT, accountMembers);

    // Parent-keyed maps (for plain group, parent = raw key)
    const timestamps = _testGetGroupCacheTimestamps();
    const accountTimestamps = new Map<string, number>();
    accountTimestamps.set(plainGroup, Date.now());
    timestamps.set(ACCOUNT, accountTimestamps);

    vi.advanceTimersByTime(CACHE_MAX_AGE_MS + 1000);
    cleanupStaleCaches();

    // Both raw-keyed and parent-keyed should be cleaned
    expect(memberMaps.get(ACCOUNT)?.has(plainGroup)).toBe(false);
    expect(timestamps.get(ACCOUNT)?.has(plainGroup)).toBe(false);
    // Account entry removed entirely (only entry was stale)
    expect(_testGetCacheActivity().has(ACCOUNT)).toBe(false);
  });

  it("cleans up empty account entries from _cacheActivity", () => {
    touchCache(ACCOUNT, "GROUP6____t1");

    vi.advanceTimersByTime(CACHE_MAX_AGE_MS + 1000);
    cleanupStaleCaches();

    expect(_testGetCacheActivity().has(ACCOUNT)).toBe(false);
  });
});
