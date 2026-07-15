import { describe, expect, it } from "vitest";
import {
  cardFitsLimits,
  cardMaxDepth,
  cardPayloadBytes,
  countCardNodes,
} from "./card-limits.js";
import { CARD_INTERACTIVE_PROFILE } from "./types.js";

const card = (body: Array<Record<string, unknown>>): Record<string, unknown> => ({
  type: "AdaptiveCard",
  version: "1.5",
  body,
});

describe("card hard-limit walker", () => {
  it("递归统计对象节点,数组与根 AdaptiveCard 不单独计数", () => {
    const value = card([{
      type: "Container",
      items: [
        { type: "TextBlock", text: "a" },
        { type: "RichTextBlock", inlines: [{ type: "TextRun", text: "b" }] },
      ],
    }]);
    expect(countCardNodes(value)).toBe(4); // Container + TextBlock + RichTextBlock + TextRun
    expect(countCardNodes(null)).toBe(0);
    expect(countCardNodes("scalar")).toBe(0);
  });

  it("深度遍历嵌套对象且数组透明", () => {
    expect(cardMaxDepth(card([{ type: "TextBlock", text: "a" }]))).toBe(1);
    expect(cardMaxDepth(card([{ type: "Container", items: [{ type: "TextBlock", text: "a" }] }]))).toBe(2);
    expect(cardMaxDepth(undefined)).toBe(0);
  });

  it("payload 字节按完整 type-17 信封和 UTF-8 计算", () => {
    const ascii = cardPayloadBytes(card([{ type: "TextBlock", text: "aaa" }]), "aaa");
    const utf8 = cardPayloadBytes(card([{ type: "TextBlock", text: "汉汉汉" }]), "汉汉汉");
    expect(utf8).toBeGreaterThan(ascii);
  });

  it("payload 字节预算使用实际 profile，而不是固定 octo/v1", () => {
    const value = card([{ type: "TextBlock", text: "ok" }]);
    const displayBytes = cardPayloadBytes(value, "ok");
    const interactiveBytes = cardPayloadBytes(value, "ok", CARD_INTERACTIVE_PROFILE);

    expect(interactiveBytes).toBe(displayBytes);
    expect(cardFitsLimits(
      value,
      "ok",
      { maxPayloadBytes: interactiveBytes },
      CARD_INTERACTIVE_PROFILE,
    )).toBe(true);
  });

  it("无有效限制时放行；节点、深度、字节任一超限都拒绝", () => {
    const nested = card([{ type: "Container", items: [{ type: "TextBlock", text: "hello" }] }]);
    const bytes = cardPayloadBytes(nested, "hello");
    expect(cardFitsLimits(nested, "hello", undefined)).toBe(true);
    expect(cardFitsLimits(nested, "hello", { maxNodes: 1 })).toBe(false);
    expect(cardFitsLimits(nested, "hello", { maxDepth: 1 })).toBe(false);
    expect(cardFitsLimits(nested, "hello", { maxPayloadBytes: bytes - 1 })).toBe(false);
    expect(cardFitsLimits(nested, "hello", {
      maxNodes: 2,
      maxDepth: 2,
      maxPayloadBytes: bytes,
    })).toBe(true);
  });

  it("0、负数、NaN 不是有效服务端限制,不会意外关闭卡片", () => {
    const minimal = card([{ type: "TextBlock", text: "ok" }]);
    expect(cardFitsLimits(minimal, "ok", {
      maxNodes: 0,
      maxDepth: -1,
      maxPayloadBytes: Number.NaN,
    })).toBe(true);
  });
});
