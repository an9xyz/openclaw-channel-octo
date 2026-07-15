import { describe, expect, it } from "vitest";
import { buildInteractiveCard } from "./card-author.js";
import { CARD_INTERACTIVE_PROFILE } from "./types.js";
import { cardPayloadBytes } from "./card-limits.js";

const caps = {
  elements: new Set(["TextBlock"]),
  inputs: new Set(["Input.Text", "Input.ChoiceSet"]),
  actions: new Set(["Action.Submit"]),
  maxNodes: 20,
  maxDepth: 8,
  maxPayloadBytes: 16_384,
  maxInputTextBytes: 4096,
  maxInputsBytes: 8192,
};

describe("buildInteractiveCard", () => {
  it("构造顶层 Action.Submit 与输入，并生成同源 plain", () => {
    const result = buildInteractiveCard({
      title: "发布确认",
      text: "请选择下一步",
      buttons: [
        { id: "approve", label: "批准", data: { workflow: "release" }, style: "positive" },
        { id: "reject", label: "拒绝" },
      ],
      inputs: [
        { id: "reason", kind: "text", label: "原因" },
        {
          id: "env",
          kind: "choice",
          label: "环境",
          choices: [{ title: "生产", value: "prod" }],
        },
      ],
    }, caps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.card.actions).toEqual([
      expect.objectContaining({ type: "Action.Submit", id: "approve", title: "批准" }),
      expect.objectContaining({ type: "Action.Submit", id: "reject", title: "拒绝" }),
    ]);
    expect(JSON.stringify(result.card.body)).toContain("Input.Text");
    expect(JSON.stringify(result.card.body)).toContain("Input.ChoiceSet");
    expect(result.plain).toContain("批准 / 拒绝");
    expect(cardPayloadBytes(result.card, result.plain, CARD_INTERACTIVE_PROFILE))
      .toBeLessThanOrEqual(caps.maxPayloadBytes);
  });

  it("缺少 Action.Submit 或具体 Input capability 时 fail-closed", () => {
    expect(buildInteractiveCard({
      title: "确认",
      buttons: [{ id: "ok", label: "确定" }],
    }, { ...caps, actions: new Set() })).toEqual(expect.objectContaining({ ok: false }));

    expect(buildInteractiveCard({
      title: "确认",
      buttons: [{ id: "ok", label: "确定" }],
      inputs: [{ id: "amount", kind: "number" }],
    }, caps)).toEqual(expect.objectContaining({ ok: false }));
  });

  it("拒绝重复 id、无按钮、choice 无选项和超限 payload", () => {
    expect(buildInteractiveCard({ title: "确认", buttons: [] }, caps)).toEqual(expect.objectContaining({ ok: false }));
    expect(buildInteractiveCard({
      title: "确认",
      buttons: [{ id: "same", label: "A" }, { id: "same", label: "B" }],
    }, caps)).toEqual(expect.objectContaining({ ok: false }));
    expect(buildInteractiveCard({
      title: "确认",
      buttons: [{ id: "ok", label: "确定" }],
      inputs: [{ id: "env", kind: "choice", choices: [] }],
    }, caps)).toEqual(expect.objectContaining({ ok: false }));
    expect(buildInteractiveCard({
      title: "确认",
      text: "x".repeat(1000),
      buttons: [{ id: "ok", label: "确定" }],
    }, { ...caps, maxPayloadBytes: 100 })).toEqual(expect.objectContaining({ ok: false }));
  });

  it("卡片文本和 Action.data 中的密钥会被拒绝或脱敏", () => {
    expect(buildInteractiveCard({
      title: "token=sk-abcdefghijklmnopqrstuvwxyz123456",
      buttons: [{ id: "ok", label: "确定" }],
    }, caps)).toEqual(expect.objectContaining({ ok: false }));

    const result = buildInteractiveCard({
      title: "确认",
      buttons: [{
        id: "ok",
        label: "确定",
        data: { apiKey: "sk-abcdefghijklmnopqrstuvwxyz123456", note: "safe" },
      }],
    }, caps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(JSON.stringify(result.card)).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
  });
});
