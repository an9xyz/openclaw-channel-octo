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

const allInputCaps = {
  ...caps,
  inputs: new Set([
    "Input.Text",
    "Input.Number",
    "Input.Date",
    "Input.Time",
    "Input.Toggle",
    "Input.ChoiceSet",
  ]),
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

  it("覆盖所有输入类型并执行文本截断、data 深度限制和样式保留", () => {
    const result = buildInteractiveCard({
      title: "T".repeat(250),
      buttons: [{
        id: "delete",
        label: "删除",
        style: "destructive",
        data: {
          nested: [[[[[["too deep"]]]]]],
          values: [null, 1, true],
          note: "safe",
          ignored: undefined,
        },
      }],
      inputs: [
        { id: "text", placeholder: "说明" },
        { id: "number", kind: "number" },
        { id: "date", kind: "date" },
        { id: "time", kind: "time" },
        { id: "toggle", kind: "toggle" },
      ],
    }, { ...allInputCaps, maxInputTextBytes: 1 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.title).toHaveLength(201);
    expect(result.card.actions).toEqual([
      expect.objectContaining({ id: "delete", style: "destructive" }),
    ]);
    expect(JSON.stringify(result.card)).toContain("[truncated]");
    expect(result.card.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "Input.Text", maxLength: 1, placeholder: "说明" }),
      expect.objectContaining({ type: "Input.Number" }),
      expect.objectContaining({ type: "Input.Date" }),
      expect.objectContaining({ type: "Input.Time" }),
      expect.objectContaining({ type: "Input.Toggle" }),
    ]));
  });

  it("拒绝不支持元素、数量越界和非法字段", () => {
    expect(buildInteractiveCard({
      title: "确认",
      buttons: [{ id: "ok", label: "确定" }],
    }, { ...caps, elements: new Set() })).toEqual(expect.objectContaining({ error: "TextBlock is not supported" }));
    expect(buildInteractiveCard({
      title: "确认",
      buttons: Array.from({ length: 7 }, (_, index) => ({ id: `b${index}`, label: `B${index}` })),
    }, caps)).toEqual(expect.objectContaining({ error: expect.stringMatching(/too many buttons/) }));
    expect(buildInteractiveCard({
      title: "确认",
      buttons: [{ id: "", label: "确定" }],
    }, caps)).toEqual(expect.objectContaining({ error: expect.stringMatching(/button id/) }));
    expect(buildInteractiveCard({
      title: "确认",
      buttons: [{ id: "ok", label: "token=sk-abcdefghijklmnopqrstuvwxyz123456" }],
    }, caps)).toEqual(expect.objectContaining({ error: expect.stringMatching(/safe label/) }));
    expect(buildInteractiveCard({
      title: "确认",
      text: "token=sk-abcdefghijklmnopqrstuvwxyz123456",
      buttons: [{ id: "ok", label: "确定" }],
    }, caps)).toEqual(expect.objectContaining({ error: expect.stringMatching(/text contains/) }));
  });

  it("拒绝非法输入定义、占位符和输入定义字节超限", () => {
    expect(buildInteractiveCard({
      title: "确认", buttons: [{ id: "ok", label: "确定" }], inputs: "bad",
    } as never, caps)).toEqual(expect.objectContaining({ error: "inputs must be an array" }));
    expect(buildInteractiveCard({
      title: "确认",
      buttons: [{ id: "ok", label: "确定" }],
      inputs: Array.from({ length: 6 }, (_, index) => ({ id: `i${index}` })),
    }, caps)).toEqual(expect.objectContaining({ error: expect.stringMatching(/too many inputs/) }));
    expect(buildInteractiveCard({
      title: "确认", buttons: [{ id: "ok", label: "确定" }], inputs: [{ id: "same" }, { id: "same" }],
    }, caps)).toEqual(expect.objectContaining({ error: "duplicate input id: same" }));
    expect(buildInteractiveCard({
      title: "确认", buttons: [{ id: "ok", label: "确定" }], inputs: [{ id: "kind", kind: "other" }],
    } as never, allInputCaps)).toEqual(expect.objectContaining({ error: "unsupported input kind: other" }));
    expect(buildInteractiveCard({
      title: "确认",
      buttons: [{ id: "ok", label: "确定" }],
      inputs: [{ id: "note", placeholder: "token=sk-abcdefghijklmnopqrstuvwxyz123456" }],
    }, caps)).toEqual(expect.objectContaining({ error: expect.stringMatching(/invalid placeholder/) }));
    expect(buildInteractiveCard({
      title: "确认",
      buttons: [{ id: "ok", label: "确定" }],
      inputs: [{ id: "env", kind: "choice", choices: [{ title: "", value: "prod" }] }],
    }, caps)).toEqual(expect.objectContaining({ error: expect.stringMatching(/invalid choices/) }));
    expect(buildInteractiveCard({
      title: "确认", buttons: [{ id: "ok", label: "确定" }], inputs: [{ id: "note", label: "备注" }],
    }, { ...caps, maxInputsBytes: 1 })).toEqual(expect.objectContaining({ error: "input definitions exceed max_inputs_bytes" }));
  });
});
