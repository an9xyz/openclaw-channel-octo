import { describe, it, expect } from "vitest";
import { normalizeAccountId } from "./account-id.js";

describe("normalizeAccountId", () => {
  it("lowercases ASCII letters", () => {
    expect(normalizeAccountId("27pBwzf2F6bfa5cd142_bot"))
      .toBe("27pbwzf2f6bfa5cd142_bot");
  });

  it("leaves already-lowercase IDs unchanged", () => {
    expect(normalizeAccountId("27pbwzf2_bot")).toBe("27pbwzf2_bot");
  });

  it("is idempotent (normalize ∘ normalize == normalize)", () => {
    const id = "AaBbCc_bot";
    expect(normalizeAccountId(normalizeAccountId(id))).toBe(normalizeAccountId(id));
  });

  it("leaves digits and underscores untouched", () => {
    expect(normalizeAccountId("123_bot")).toBe("123_bot");
    expect(normalizeAccountId("a_b_c_bot")).toBe("a_b_c_bot");
  });

  it("handles full uppercase", () => {
    expect(normalizeAccountId("BOTNAME_BOT")).toBe("botname_bot");
  });
});
