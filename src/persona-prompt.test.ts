import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  composePersonaHint,
  getPersonaPromptForSession,
  getRegisteredPersonaAccountIds,
  initPersonaPromptCache,
  refreshPersonaPromptCache,
  resolvePersonaHintForSession,
  setPersonaPromptRefreshIntervalMs,
  stopPersonaPromptCache,
  _resetPersonaPromptCacheForTests,
} from "./persona-prompt.js";
import type { BotOboGrant } from "./api-fetch.js";

const originalFetch = global.fetch;

function mockFetchOnce(body: unknown, init: Partial<{ status: number; ok: boolean }> = {}) {
  const status = init.status ?? 200;
  const ok = init.ok ?? status < 400;
  const fn = vi.fn().mockResolvedValue({
    ok,
    status,
    statusText: ok ? "OK" : "Err",
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

beforeEach(() => {
  _resetPersonaPromptCacheForTests();
  vi.restoreAllMocks();
});

afterEach(() => {
  _resetPersonaPromptCacheForTests();
  global.fetch = originalFetch;
});

describe("composePersonaHint", () => {
  const baseGrant: BotOboGrant = {
    has_grant: true,
    grantor_uid: "u_admin",
    grantor_name: "Admin",
    persona_prompt: "Reply concisely.",
    active: true,
  };

  it("composes a hint matching the buildFanoutCopyReq-style prefix", () => {
    const hint = composePersonaHint(baseGrant);
    expect(hint).toBe(
      `你正在以「Admin」的分身身份运作。请以 Admin 的身份回复。\n\nReply concisely.`,
    );
  });

  it("falls back to grantor_uid when grantor_name is missing", () => {
    const hint = composePersonaHint({ ...baseGrant, grantor_name: "" });
    expect(hint).toContain("「u_admin」");
    expect(hint).toContain("请以 u_admin 的身份");
  });

  it("returns undefined when persona_prompt is empty / whitespace", () => {
    expect(composePersonaHint({ ...baseGrant, persona_prompt: "" })).toBeUndefined();
    expect(composePersonaHint({ ...baseGrant, persona_prompt: "   " })).toBeUndefined();
  });

  it("returns undefined when grant is inactive", () => {
    expect(composePersonaHint({ ...baseGrant, active: false })).toBeUndefined();
  });

  it("returns undefined when has_grant is false", () => {
    expect(composePersonaHint({ has_grant: false })).toBeUndefined();
  });

  it("returns undefined when both grantor_name and grantor_uid are missing", () => {
    expect(
      composePersonaHint({
        has_grant: true,
        persona_prompt: "p",
        active: true,
      }),
    ).toBeUndefined();
  });
});

describe("refreshPersonaPromptCache + getPersonaPromptForSession", () => {
  it("populates the cache from a 200 response", async () => {
    mockFetchOnce({
      has_grant: true,
      grantor_uid: "u_admin",
      grantor_name: "Admin",
      persona_prompt: "Be brief.",
      active: true,
    });

    await refreshPersonaPromptCache({
      accountId: "bot_a",
      apiUrl: "http://api",
      botToken: "bf_x",
      onBehalfOf: "u_admin",
    });

    const hint = getPersonaPromptForSession("bot_a");
    expect(hint).toContain("「Admin」");
    expect(hint).toContain("Be brief.");
  });

  it("clears the cached hint when the server returns has_grant=false", async () => {
    mockFetchOnce({
      has_grant: true,
      grantor_uid: "u_admin",
      grantor_name: "Admin",
      persona_prompt: "old",
      active: true,
    });
    const account = {
      accountId: "bot_b",
      apiUrl: "http://api",
      botToken: "bf_x",
      onBehalfOf: "u_admin",
    };
    await refreshPersonaPromptCache(account);
    expect(getPersonaPromptForSession("bot_b")).toBeDefined();

    mockFetchOnce({ has_grant: false });
    await refreshPersonaPromptCache(account);
    expect(getPersonaPromptForSession("bot_b")).toBeUndefined();
  });

  it("treats 404 as no grant (cache cleared, no throw)", async () => {
    mockFetchOnce({}, { status: 404, ok: false });
    await refreshPersonaPromptCache({
      accountId: "bot_c",
      apiUrl: "http://api",
      botToken: "bf_x",
      onBehalfOf: "u_admin",
    });
    expect(getPersonaPromptForSession("bot_c")).toBeUndefined();
  });

  it("is a no-op when onBehalfOf is undefined", async () => {
    const fetchSpy = mockFetchOnce({ has_grant: true });
    await refreshPersonaPromptCache({
      accountId: "bot_regular",
      apiUrl: "http://api",
      botToken: "bf_x",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getPersonaPromptForSession("bot_regular")).toBeUndefined();
  });

  it("swallows 5xx errors and keeps the previous cached hint", async () => {
    mockFetchOnce({
      has_grant: true,
      grantor_uid: "u_admin",
      grantor_name: "Admin",
      persona_prompt: "stable",
      active: true,
    });
    const account = {
      accountId: "bot_d",
      apiUrl: "http://api",
      botToken: "bf_x",
      onBehalfOf: "u_admin",
    };
    await refreshPersonaPromptCache(account);
    const before = getPersonaPromptForSession("bot_d");
    expect(before).toBeDefined();

    // Second call: server hiccups. Old cache must remain intact and we
    // must not throw — message processing depends on this.
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    await expect(refreshPersonaPromptCache(account, log)).resolves.toBeUndefined();
    expect(getPersonaPromptForSession("bot_d")).toBe(before);
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it("sends Authorization: Bearer <botToken> to /v1/bot/obo-grant", async () => {
    const fetchSpy = mockFetchOnce({ has_grant: false });
    await refreshPersonaPromptCache({
      accountId: "bot_e",
      apiUrl: "http://api/",
      botToken: "bf_secret",
      onBehalfOf: "u_admin",
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://api/v1/bot/obo-grant");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer bf_secret",
    );
  });
});

describe("initPersonaPromptCache (timer behavior)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setPersonaPromptRefreshIntervalMs(1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("performs an initial fetch + periodic refreshes at the configured interval", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        has_grant: true,
        grantor_uid: "u_admin",
        grantor_name: "Admin",
        persona_prompt: "p",
        active: true,
      }),
      text: async () => "",
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    initPersonaPromptCache({
      accountId: "bot_t",
      apiUrl: "http://api",
      botToken: "bf_x",
      onBehalfOf: "u_admin",
    });

    // initial fetch is scheduled microtask; flush it
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    stopPersonaPromptCache("bot_t");
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("does NOT start a timer when onBehalfOf is undefined", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    initPersonaPromptCache({
      accountId: "bot_plain",
      apiUrl: "http://api",
      botToken: "bf_x",
    });

    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("replaces an existing timer on repeated init (no leak)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ has_grant: false }),
      text: async () => "",
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    initPersonaPromptCache({
      accountId: "bot_repeat",
      apiUrl: "http://api",
      botToken: "bf_x",
      onBehalfOf: "u_admin",
    });
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    // Re-init — should clear old timer and schedule a fresh one.
    initPersonaPromptCache({
      accountId: "bot_repeat",
      apiUrl: "http://api",
      botToken: "bf_x",
      onBehalfOf: "u_admin",
    });
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));

    await vi.advanceTimersByTimeAsync(1000);
    // Only one timer should now be active — exactly one extra call, not two.
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    stopPersonaPromptCache("bot_repeat");
  });
});

describe("generation guard (abort in-flight fetches)", () => {
  beforeEach(() => {
    setPersonaPromptRefreshIntervalMs(60_000);
  });

  it("drops a stale in-flight fetch when stopPersonaPromptCache runs first", async () => {
    // Hold the fetch open until we trigger its resolution.
    let resolveFetch!: (v: unknown) => void;
    const pending = new Promise((res) => {
      resolveFetch = res;
    });
    global.fetch = vi.fn().mockImplementation(() => pending) as unknown as typeof fetch;

    const account = {
      accountId: "bot_race",
      apiUrl: "http://api",
      botToken: "bf_x",
      onBehalfOf: "u_admin",
    };

    const inflight = refreshPersonaPromptCache(account);

    // Simulate "account stopped while fetch is in flight"
    stopPersonaPromptCache("bot_race");

    // Now let the original fetch resolve with a non-empty grant.
    resolveFetch({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        has_grant: true,
        grantor_uid: "u_admin",
        grantor_name: "Admin",
        persona_prompt: "stale",
        active: true,
      }),
      text: async () => "",
    });

    await inflight;

    // The stale fetch must NOT resurrect the cleared cache.
    expect(getPersonaPromptForSession("bot_race")).toBeUndefined();
  });

  it("drops a stale in-flight fetch when initPersonaPromptCache runs first (reconfigure)", async () => {
    // First fetch hangs forever (until we resolve it).
    let resolveFirst!: (v: unknown) => void;
    const firstPending = new Promise((res) => {
      resolveFirst = res;
    });
    // Second fetch resolves immediately with a fresh grant.
    const secondResponse = {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        has_grant: true,
        grantor_uid: "u_admin",
        grantor_name: "Admin",
        persona_prompt: "fresh",
        active: true,
      }),
      text: async () => "",
    };

    const fetchSpy = vi
      .fn()
      .mockImplementationOnce(() => firstPending)
      .mockResolvedValue(secondResponse);
    global.fetch = fetchSpy as unknown as typeof fetch;

    const account = {
      accountId: "bot_reconf",
      apiUrl: "http://api",
      botToken: "bf_x",
      onBehalfOf: "u_admin",
    };

    // Kick off the first in-flight fetch via the explicit refresh API
    // (initPersonaPromptCache's timer would otherwise complicate the test).
    const stale = refreshPersonaPromptCache(account);

    // Simulate reconfigure: bump generation, immediate fetch with new grant.
    initPersonaPromptCache(account);
    // Wait for the fresh fetch to populate the cache.
    await vi.waitFor(() => {
      expect(getPersonaPromptForSession("bot_reconf")).toContain("fresh");
    });

    // Now the original fetch resolves with a different (stale) grant.
    resolveFirst({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        has_grant: true,
        grantor_uid: "u_admin",
        grantor_name: "Admin",
        persona_prompt: "stale",
        active: true,
      }),
      text: async () => "",
    });
    await stale;

    // Fresh entry must survive — stale fetch was superseded.
    expect(getPersonaPromptForSession("bot_reconf")).toContain("fresh");

    stopPersonaPromptCache("bot_reconf");
  });
});

describe("cache lifecycle on reconfigure", () => {
  // persona → regular bot must not leave a stale hint behind.
  it("clears the cached hint when the account is reconfigured to drop onBehalfOf", async () => {
    // 1. Seed the cache as a persona-clone.
    mockFetchOnce({
      has_grant: true,
      grantor_uid: "u_admin",
      grantor_name: "Admin",
      persona_prompt: "old persona",
      active: true,
    });
    const personaAccount = {
      accountId: "bot_switch",
      apiUrl: "http://api",
      botToken: "bf_x",
      onBehalfOf: "u_admin",
    };
    await refreshPersonaPromptCache(personaAccount);
    expect(getPersonaPromptForSession("bot_switch")).toContain("old persona");

    // Also start the refresh loop (mirrors the real channel-start path).
    mockFetchOnce({ has_grant: false });
    initPersonaPromptCache(personaAccount);
    expect(getRegisteredPersonaAccountIds()).toContain("bot_switch");

    // 2. Reconfigure: same accountId, but onBehalfOf cleared (now a plain bot).
    initPersonaPromptCache({
      accountId: "bot_switch",
      apiUrl: "http://api",
      botToken: "bf_x",
      // onBehalfOf intentionally omitted
    });

    // 3. The old persona hint must be gone — before this fix, the early
    //    return left _cache untouched and the before_prompt_build hook
    //    would keep injecting "old persona" into the now-regular bot.
    expect(getPersonaPromptForSession("bot_switch")).toBeUndefined();
    // And the timer must be torn down so we don't keep polling either.
    expect(getRegisteredPersonaAccountIds()).not.toContain("bot_switch");
  });

  // Re-init with a different grantor must not serve the old
  // grantor's hint during the new fetch's in-flight window.
  it("returns undefined during the refetch window when re-init switches grantor", async () => {
    // Seed cache with grantor A's hint.
    mockFetchOnce({
      has_grant: true,
      grantor_uid: "u_alice",
      grantor_name: "Alice",
      persona_prompt: "alice voice",
      active: true,
    });
    await refreshPersonaPromptCache({
      accountId: "bot_regrant",
      apiUrl: "http://api",
      botToken: "bf_x",
      onBehalfOf: "u_alice",
    });
    expect(getPersonaPromptForSession("bot_regrant")).toContain("alice voice");

    // Re-init with grantor B, but hold the new fetch open so we can
    // observe the in-flight window.
    let resolveNew!: (v: unknown) => void;
    const pending = new Promise((res) => {
      resolveNew = res;
    });
    global.fetch = vi.fn().mockImplementation(() => pending) as unknown as typeof fetch;

    initPersonaPromptCache({
      accountId: "bot_regrant",
      apiUrl: "http://api",
      botToken: "bf_x",
      onBehalfOf: "u_bob",
    });

    // Before this fix, _cache.get("bot_regrant") still returned Alice's
    // hint during the gap. Now it must be cleared eagerly so the hook
    // fails safe (no persona injection) until the new fetch completes.
    expect(getPersonaPromptForSession("bot_regrant")).toBeUndefined();

    // Resolve with grantor B's grant — cache should now reflect B.
    resolveNew({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        has_grant: true,
        grantor_uid: "u_bob",
        grantor_name: "Bob",
        persona_prompt: "bob voice",
        active: true,
      }),
      text: async () => "",
    });
    await vi.waitFor(() => {
      expect(getPersonaPromptForSession("bot_regrant")).toContain("bob voice");
    });
    expect(getPersonaPromptForSession("bot_regrant")).not.toContain("alice voice");

    stopPersonaPromptCache("bot_regrant");
  });
});

describe("getRegisteredPersonaAccountIds", () => {
  it("returns the accountIds of accounts that called initPersonaPromptCache", async () => {
    // Initial fetch is fire-and-forget; stub fetch so it can't reach the network.
    mockFetchOnce({ has_grant: false });
    initPersonaPromptCache({
      accountId: "persona_a",
      apiUrl: "http://api.example/",
      botToken: "bf_a",
      onBehalfOf: "u_admin",
    });
    mockFetchOnce({ has_grant: false });
    initPersonaPromptCache({
      accountId: "persona_b",
      apiUrl: "http://api.example/",
      botToken: "bf_b",
      onBehalfOf: "u_admin",
    });

    expect(getRegisteredPersonaAccountIds().sort()).toEqual(["persona_a", "persona_b"]);

    stopPersonaPromptCache("persona_a");
    expect(getRegisteredPersonaAccountIds()).toEqual(["persona_b"]);
  });

  it("skips non-persona accounts (no onBehalfOf)", () => {
    initPersonaPromptCache({
      accountId: "regular_bot",
      apiUrl: "http://api.example/",
      botToken: "bf_x",
      // onBehalfOf intentionally undefined
    });
    expect(getRegisteredPersonaAccountIds()).toEqual([]);
  });
});

describe("resolvePersonaHintForSession — multi-account isolation", () => {
  async function seedPersonaCache(accountId: string, personaPrompt: string) {
    mockFetchOnce({
      has_grant: true,
      grantor_uid: "u_admin",
      grantor_name: `Admin-${accountId}`,
      persona_prompt: personaPrompt,
      active: true,
    });
    await refreshPersonaPromptCache({
      accountId,
      apiUrl: "http://api.example/",
      botToken: `bf_${accountId}`,
      onBehalfOf: "u_admin",
    });
  }

  /**
   * Build a fake sessionAccountMap closure over a plain Map so the test
   * mirrors the real call site in index.ts (`sessionAccountMap.has(
   * buildSessionAccountKey(accountId, sessionKey))`) without importing
   * from inbound.ts (which would drag the channel runtime into this
   * isolated test).
   */
  function makeHasAccountSession(entries: Array<[string, string]>) {
    const set = new Set(entries.map(([acct, sk]) => `${acct}:${sk}`));
    return (accountId: string, sessionKey: string) => set.has(`${accountId}:${sessionKey}`);
  }

  it("returns the hint when exactly one persona account is bound to the session", async () => {
    mockFetchOnce({ has_grant: false }); // suppress init's fire-and-forget fetch
    initPersonaPromptCache({
      accountId: "persona_only",
      apiUrl: "http://api.example/",
      botToken: "bf_only",
      onBehalfOf: "u_admin",
    });
    await seedPersonaCache("persona_only", "be helpful");

    const sessionKey = "agent:default:octo:group:abc";
    const hint = resolvePersonaHintForSession({
      sessionKey,
      hasAccountSession: makeHasAccountSession([["persona_only", sessionKey]]),
    });
    expect(hint).toContain("be helpful");

    stopPersonaPromptCache("persona_only");
  });

  it("returns undefined when zero persona accounts match the session", async () => {
    mockFetchOnce({ has_grant: false });
    initPersonaPromptCache({
      accountId: "persona_alpha",
      apiUrl: "http://api.example/",
      botToken: "bf_alpha",
      onBehalfOf: "u_admin",
    });
    await seedPersonaCache("persona_alpha", "alpha prompt");

    const hint = resolvePersonaHintForSession({
      sessionKey: "agent:default:octo:group:other",
      // Empty map — persona_alpha never seen on this sessionKey.
      hasAccountSession: makeHasAccountSession([]),
    });
    expect(hint).toBeUndefined();

    stopPersonaPromptCache("persona_alpha");
  });

  it("returns undefined when two persona accounts share the same sessionKey (no cross-account leak)", async () => {
    // 🔴 Core regression guard for cross-account isolation:
    // when two persona-clone accounts collide on a sessionKey we MUST
    // refuse to inject either persona prompt rather than guessing,
    // because the hook cannot tell which account the prompt build is for.
    mockFetchOnce({ has_grant: false });
    initPersonaPromptCache({
      accountId: "persona_a",
      apiUrl: "http://api.example/",
      botToken: "bf_a",
      onBehalfOf: "u_admin",
    });
    mockFetchOnce({ has_grant: false });
    initPersonaPromptCache({
      accountId: "persona_b",
      apiUrl: "http://api.example/",
      botToken: "bf_b",
      onBehalfOf: "u_admin",
    });
    await seedPersonaCache("persona_a", "A-only prompt");
    await seedPersonaCache("persona_b", "B-only prompt");

    const sharedSessionKey = "agent:default:octo:group:shared";
    const hint = resolvePersonaHintForSession({
      sessionKey: sharedSessionKey,
      hasAccountSession: makeHasAccountSession([
        ["persona_a", sharedSessionKey],
        ["persona_b", sharedSessionKey],
      ]),
    });

    expect(hint).toBeUndefined();
    // And the per-account caches themselves are untouched — each persona
    // still has its own prompt, the resolver just refused to disambiguate.
    expect(getPersonaPromptForSession("persona_a")).toContain("A-only");
    expect(getPersonaPromptForSession("persona_b")).toContain("B-only");

    stopPersonaPromptCache("persona_a");
    stopPersonaPromptCache("persona_b");
  });

  it("ignores non-persona accounts that share a sessionKey with a persona account", async () => {
    // Regular bot (no onBehalfOf) bound to the same sessionKey must NOT
    // prevent the persona account's prompt from being resolved — only
    // entries from registered persona accounts count toward disambiguation.
    mockFetchOnce({ has_grant: false });
    initPersonaPromptCache({
      accountId: "persona_solo",
      apiUrl: "http://api.example/",
      botToken: "bf_solo",
      onBehalfOf: "u_admin",
    });
    await seedPersonaCache("persona_solo", "solo prompt");

    const sharedSessionKey = "agent:default:octo:group:mixed";
    const hint = resolvePersonaHintForSession({
      sessionKey: sharedSessionKey,
      // sessionAccountMap contains both a persona and a regular bot, but
      // only `persona_solo` is a registered persona account so only its
      // membership is consulted.
      hasAccountSession: makeHasAccountSession([
        ["persona_solo", sharedSessionKey],
        ["regular_bot", sharedSessionKey],
      ]),
    });
    expect(hint).toContain("solo prompt");

    stopPersonaPromptCache("persona_solo");
  });

  it("returns undefined for empty sessionKey", () => {
    const hint = resolvePersonaHintForSession({
      sessionKey: "",
      hasAccountSession: () => true,
    });
    expect(hint).toBeUndefined();
  });

  it("returns undefined when the matching persona account has no cached hint yet (cold start)", async () => {
    mockFetchOnce({ has_grant: false });
    initPersonaPromptCache({
      accountId: "persona_cold",
      apiUrl: "http://api.example/",
      botToken: "bf_cold",
      onBehalfOf: "u_admin",
    });
    // Deliberately do NOT seed a hint — _cache.get returns undefined.

    const sessionKey = "agent:default:octo:dm:user1";
    const hint = resolvePersonaHintForSession({
      sessionKey,
      hasAccountSession: makeHasAccountSession([["persona_cold", sessionKey]]),
    });
    // Single match, but no hint cached → undefined (fail-safe).
    expect(hint).toBeUndefined();

    stopPersonaPromptCache("persona_cold");
  });
});

// ─── issue #33: case-insensitive accountId in persona cache ────────────────

describe("persona-prompt case-insensitive accountId (issue #33)", () => {
  beforeEach(() => _resetPersonaPromptCacheForTests());

  it("refreshPersonaPromptCache writes under normalized accountId; getPersonaPromptForSession hits either case", async () => {
    global.fetch = mockFetchOnce({
      has_grant: true,
      active: true,
      persona_prompt: "always reply in English",
      grantor_name: "Alice",
      grantor_uid: "alice_uid",
    });

    await refreshPersonaPromptCache({
      accountId: "Mixed_Bot",   // mixed-case input
      apiUrl: "http://api",
      botToken: "tk",
      onBehalfOf: "alice_uid",
    });

    // Lookup with either case form should hit the same cache entry
    expect(getPersonaPromptForSession("mixed_bot")).toContain("Alice");
    expect(getPersonaPromptForSession("Mixed_Bot")).toContain("Alice");
    expect(getPersonaPromptForSession("MIXED_BOT")).toContain("Alice");
  });

  it("getRegisteredPersonaAccountIds returns normalized ids only", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      has_grant: true, active: true,
      persona_prompt: "x", grantor_name: "G", grantor_uid: "g",
    }), { status: 200 })) as any;

    initPersonaPromptCache({
      accountId: "MixedCase_Bot",
      apiUrl: "http://api",
      botToken: "tk",
      onBehalfOf: "g",
    });

    expect(getRegisteredPersonaAccountIds()).toContain("mixedcase_bot");
    expect(getRegisteredPersonaAccountIds()).not.toContain("MixedCase_Bot");

    stopPersonaPromptCache("mixedcase_bot");
  });

  it("stopPersonaPromptCache with mixed-case accountId clears the lowercase entry", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      has_grant: true, active: true,
      persona_prompt: "x", grantor_name: "G", grantor_uid: "g",
    }), { status: 200 })) as any;

    await refreshPersonaPromptCache({
      accountId: "MyBot_bot",
      apiUrl: "http://api",
      botToken: "tk",
      onBehalfOf: "g",
    });
    expect(getPersonaPromptForSession("mybot_bot")).toBeDefined();

    // Stop using a DIFFERENT case form than what was registered.
    stopPersonaPromptCache("MYBOT_BOT");

    // Cache should be cleared regardless of original case.
    expect(getPersonaPromptForSession("mybot_bot")).toBeUndefined();
    expect(getPersonaPromptForSession("MyBot_bot")).toBeUndefined();
  });

  it("stop+init race with mixed-case is generation-safe (stop side)", async () => {
    // Background: bumpGeneration / _currentGeneration take raw accountId; if
    // either splits the normalized vs raw form into separate counters, the
    // post-stop refresh fetch would not see a generation mismatch and could
    // resurrect a stale cache entry. This test asserts the counter is shared.
    let resolveFetch!: (v: Response) => void;
    global.fetch = vi.fn(() => new Promise<Response>((res) => { resolveFetch = res; })) as any;

    // Kick off an async refresh under mixed-case (don't await — fetch is gated)
    const inflight = refreshPersonaPromptCache({
      accountId: "RaceBot_bot",
      apiUrl: "http://api",
      botToken: "tk",
      onBehalfOf: "g",
    });

    // Stop with a DIFFERENT case form than the in-flight refresh.
    // _bumpGeneration normalizes, so the counter bump must invalidate
    // the in-flight refresh regardless of which case the stop used.
    stopPersonaPromptCache("racebot_bot");

    // Now let the stale fetch resolve. The refresh should detect the
    // generation mismatch and bail before writing _cache.
    resolveFetch(new Response(JSON.stringify({
      has_grant: true, active: true,
      persona_prompt: "stale", grantor_name: "X", grantor_uid: "g",
    }), { status: 200 }));
    await inflight;

    expect(getPersonaPromptForSession("racebot_bot")).toBeUndefined();
  });

  it("stop+init race with mixed-case is generation-safe (re-init after stop)", async () => {
    // Background: after stopping under one case form, an init under a
    // different case form should produce a fresh, isolated cache entry.
    // A previously-issued stale fetch must NOT overwrite the new entry.
    let resolveStaleFetch!: (v: Response) => void;
    let fetchCallCount = 0;
    global.fetch = vi.fn(() => {
      fetchCallCount++;
      if (fetchCallCount === 1) {
        // First call — gated, simulates the stale in-flight refresh
        return new Promise<Response>((res) => { resolveStaleFetch = res; });
      }
      // Second call — fresh init's initial fetch resolves immediately
      return Promise.resolve(new Response(JSON.stringify({
        has_grant: true, active: true,
        persona_prompt: "fresh", grantor_name: "FreshOwner", grantor_uid: "g2",
      }), { status: 200 }));
    }) as any;

    // 1. Refresh under mixed-case (will hang on first fetch).
    const stale = refreshPersonaPromptCache({
      accountId: "RaceBot_bot",
      apiUrl: "http://api",
      botToken: "tk",
      onBehalfOf: "g",
    });

    // 2. Stop with a different case form.
    stopPersonaPromptCache("RACEBOT_BOT");

    // 3. Re-init under yet another case form — kicks off a fresh fetch
    //    that resolves immediately (second mock call).
    initPersonaPromptCache({
      accountId: "RACEBOT_BOT",
      apiUrl: "http://api",
      botToken: "tk",
      onBehalfOf: "g2",
    });
    // Wait for the fresh init's initial fetch to settle.
    await vi.waitFor(() => {
      expect(getPersonaPromptForSession("racebot_bot")).toContain("FreshOwner");
    });

    // 4. Now resolve the stale fetch from step 1. It should detect the
    //    generation bump and NOT overwrite the fresh cache entry.
    resolveStaleFetch(new Response(JSON.stringify({
      has_grant: true, active: true,
      persona_prompt: "stale", grantor_name: "OldOwner", grantor_uid: "g",
    }), { status: 200 }));
    await stale;

    // Fresh hint must survive.
    expect(getPersonaPromptForSession("racebot_bot")).toContain("FreshOwner");
    expect(getPersonaPromptForSession("racebot_bot")).not.toContain("OldOwner");

    stopPersonaPromptCache("racebot_bot");
  });
});
