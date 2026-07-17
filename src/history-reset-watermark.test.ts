/**
 * Regression tests for issue #155 — history injection bleeds past /new.
 *
 * The plugin injects channel-level history (via segmentHistoryEntries) keyed by
 * a channel-stable sessionId. That key never resets on /new, so after a user
 * resets the session, messages from *before* the reset were still injected as
 * "already answered" context — carrying stale instructions into the fresh
 * session and polluting it.
 *
 * Fix: segmentHistoryEntries accepts a resetWatermarkMs (the OpenClaw session's
 * sessionStartedAt, in ms). Entries whose timestamp predates the watermark are
 * dropped entirely — from BOTH the answered and new segments — so a /new gives
 * a genuine clean context boundary. Entry timestamps are normalized to ms on
 * both the live-cache and API-backfill paths, so the comparison is unit-safe.
 */
import { describe, it, expect } from "vitest";
import {
  segmentHistoryEntries,
  recordSessionResetWatermark,
  resolveResetWatermarkMs,
  _test_clearResetWatermarks,
} from "./inbound.js";

const entry = (seq: number, tsMs: number, id = `m${seq}`) => ({
  message_id: id,
  message_seq: seq,
  timestamp: tsMs,
  sender: "u1",
  body: `msg ${seq}`,
});

describe("issue #155 — reset watermark filters pre-/new history", () => {
  it("drops entries older than the watermark from BOTH answered and new segments", () => {
    // watermark = 1000ms. seqs 1,2 are before the reset; 3,4 after.
    const entries = [
      entry(1, 500),   // pre-reset  → drop
      entry(2, 900),   // pre-reset  → drop
      entry(3, 1500),  // post-reset → keep
      entry(4, 2000),  // post-reset → keep
    ];

    const { answered, new: fresh } = segmentHistoryEntries({
      entries,
      cutoffSeq: 3, // seq<=3 answered, seq>3 new — regardless, pre-reset must vanish
      resetWatermarkMs: 1000,
    });

    const seqs = [...answered, ...fresh].map((e) => e.message_seq).sort((a, b) => a! - b!);
    expect(seqs).toEqual([3, 4]);
    // seq 3 (ts 1500, <= cutoff 3) stays answered; seq 4 stays new.
    expect(answered.map((e) => e.message_seq)).toEqual([3]);
    expect(fresh.map((e) => e.message_seq)).toEqual([4]);
  });

  it("keeps an entry exactly at the watermark (>= boundary is inclusive)", () => {
    const entries = [entry(1, 999), entry(2, 1000), entry(3, 1001)];
    const { answered, new: fresh } = segmentHistoryEntries({
      entries,
      cutoffSeq: 0,
      resetWatermarkMs: 1000,
    });
    // cutoffSeq 0 → everything that survives the watermark lands in `new`.
    expect(fresh.map((e) => e.message_seq)).toEqual([2, 3]);
    expect(answered).toEqual([]);
  });

  it("is a no-op when no watermark is provided (backward compatible)", () => {
    const entries = [entry(1, 500), entry(2, 1500)];
    const { answered, new: fresh } = segmentHistoryEntries({
      entries,
      cutoffSeq: 1,
    });
    expect(answered.map((e) => e.message_seq)).toEqual([1]);
    expect(fresh.map((e) => e.message_seq)).toEqual([2]);
  });

  it("is a no-op when watermark is 0 or negative (no reset recorded)", () => {
    const entries = [entry(1, 500), entry(2, 1500)];
    const { answered, new: fresh } = segmentHistoryEntries({
      entries,
      cutoffSeq: 1,
      resetWatermarkMs: 0,
    });
    expect([...answered, ...fresh].map((e) => e.message_seq)).toEqual([1, 2]);
  });

  it("still excludes the current message alongside watermark filtering", () => {
    const entries = [entry(1, 500), entry(2, 1500), entry(3, 2000, "current")];
    const { answered, new: fresh } = segmentHistoryEntries({
      entries,
      cutoffSeq: 2,
      currentMsgId: "current",
      resetWatermarkMs: 1000,
    });
    // seq1 dropped by watermark, seq3 dropped as current → only seq2 remains.
    expect([...answered, ...fresh].map((e) => e.message_seq)).toEqual([2]);
  });

  it("drops entries missing a timestamp when a watermark is active (fail-safe)", () => {
    // A pre-reset entry with no timestamp must not leak through the watermark.
    const entries = [
      { message_id: "a", message_seq: 1, sender: "u1", body: "no ts" },
      entry(2, 1500),
    ];
    const { answered, new: fresh } = segmentHistoryEntries({
      entries,
      cutoffSeq: 0,
      resetWatermarkMs: 1000,
    });
    expect([...answered, ...fresh].map((e) => e.message_seq)).toEqual([2]);
  });
});

describe("issue #155 — reset watermark store helpers", () => {
  it("resolveResetWatermarkMs takes the later of hook mark and sessionStartedAt", () => {
    _test_clearResetWatermarks();
    // no hook mark yet → falls back to sessionStartedAt
    expect(resolveResetWatermarkMs("sk1", 5000)).toBe(5000);
    // hook mark newer than sessionStartedAt → hook wins
    recordSessionResetWatermark("sk1", 8000);
    expect(resolveResetWatermarkMs("sk1", 5000)).toBe(8000);
    // sessionStartedAt newer (e.g. a later reset the hook missed) → it wins
    expect(resolveResetWatermarkMs("sk1", 9000)).toBe(9000);
  });

  it("recordSessionResetWatermark is monotonic (never rewinds)", () => {
    _test_clearResetWatermarks();
    recordSessionResetWatermark("sk2", 8000);
    recordSessionResetWatermark("sk2", 3000); // older — must be ignored
    expect(resolveResetWatermarkMs("sk2", 0)).toBe(8000);
  });

  it("returns 0 when nothing is known (no reset → no filtering)", () => {
    _test_clearResetWatermarks();
    expect(resolveResetWatermarkMs("unknown", undefined)).toBe(0);
    expect(resolveResetWatermarkMs(undefined, undefined)).toBe(0);
  });

  it("ignores empty sessionKey and non-positive timestamps", () => {
    _test_clearResetWatermarks();
    recordSessionResetWatermark("", 8000);
    recordSessionResetWatermark("sk3", 0);
    recordSessionResetWatermark("sk3", -1);
    expect(resolveResetWatermarkMs("sk3", 0)).toBe(0);
  });
});

