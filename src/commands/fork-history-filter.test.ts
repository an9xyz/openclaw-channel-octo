import { describe, it, expect } from "vitest";
import { isForkCommandHistoryMessage } from "./fork-history-filter.js";

describe("isForkCommandHistoryMessage", () => {
  describe("matches /fork commands", () => {
    it("`/fork hello` (no @prefix, not mentioned) → true", () => {
      expect(isForkCommandHistoryMessage("/fork hello", false)).toBe(true);
    });

    it("`@Max /fork hello` (mentioned) → true", () => {
      expect(isForkCommandHistoryMessage("@Max /fork hello", true)).toBe(true);
    });

    it("`@Max /fork` (empty prompt, mentioned) → true", () => {
      expect(isForkCommandHistoryMessage("@Max /fork", true)).toBe(true);
    });

    it("`@Max /fork   ` (whitespace-only prompt, mentioned) → true", () => {
      expect(isForkCommandHistoryMessage("@Max /fork   ", true)).toBe(true);
    });

    it("bare `/fork` (no @prefix) → true", () => {
      expect(isForkCommandHistoryMessage("/fork", false)).toBe(true);
    });
  });

  describe("rejects non-fork messages", () => {
    it("`@Max hello /fork world` (fork not at start) → false", () => {
      expect(isForkCommandHistoryMessage("@Max hello /fork world", true)).toBe(false);
    });

    it("`@Max /forks hello` (prefix, not exact /fork) → false", () => {
      expect(isForkCommandHistoryMessage("@Max /forks hello", true)).toBe(false);
    });

    it("`/forked` → false", () => {
      expect(isForkCommandHistoryMessage("/forked", false)).toBe(false);
    });

    it("`@Max /btw hello` (different command) → false", () => {
      expect(isForkCommandHistoryMessage("@Max /btw hello", true)).toBe(false);
    });

    it("`@Max /Fork hello` (case-sensitive, /Fork ≠ /fork) → false", () => {
      expect(isForkCommandHistoryMessage("@Max /Fork hello", true)).toBe(false);
    });

    it("ordinary group message → false", () => {
      expect(isForkCommandHistoryMessage("今天天气如何", false)).toBe(false);
    });

    it("empty body → false", () => {
      expect(isForkCommandHistoryMessage("", false)).toBe(false);
    });
  });

  describe("mention gating mirrors the live command path", () => {
    // When the bot was NOT explicitly mentioned, the @prefix is NOT stripped,
    // so `@Max /fork x` stays as-is and does not parse as a fork command — same
    // as resolveCommandBody's behavior on the inbound hot path.
    it("`@Max /fork hello` with isExplicitBotMention=false → false (no strip)", () => {
      expect(isForkCommandHistoryMessage("@Max /fork hello", false)).toBe(false);
    });
  });
});
