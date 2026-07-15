import { describe, expect, it } from "vitest";
import { renderCardActionStatus } from "./card-action-status.js";

describe("renderCardActionStatus", () => {
  it("保留原卡方案正文，冻结已选输入，移除 Submit 并追加选择状态", () => {
    const rendered = renderCardActionStatus({
      card: {
        type: "AdaptiveCard",
        version: "1.5",
        body: [
          { type: "TextBlock", text: "选择一个方案", weight: "Bolder" },
          {
            type: "Container",
            items: [
              { type: "TextBlock", text: "A · 体验碾压" },
              { type: "TextBlock", text: "C · 生态打法" },
            ],
          },
          {
            type: "Input.ChoiceSet",
            id: "strategy",
            label: "方案",
            choices: [
              { title: "A · 体验碾压", value: "a" },
              { title: "C · 生态打法", value: "c" },
            ],
          },
        ],
        actions: [{ type: "Action.Submit", id: "submit", title: "确认选择" }],
      },
      plain: "选择一个方案\nA · 体验碾压\nC · 生态打法\n可选操作：确认选择",
      inputs: { strategy: "c" },
      operator: "Alice",
      actionLabel: "确认选择",
      status: "completed",
    } as never);

    const json = JSON.stringify(rendered.card);
    expect(json).toContain("A · 体验碾压");
    expect(json).toContain("C · 生态打法");
    expect(json).toContain("方案：C · 生态打法");
    expect(json).toContain("Alice 已选择");
    expect(json).not.toContain("Action.Submit");
    expect(json).not.toContain("Input.ChoiceSet");
    expect(rendered.plain).toContain("选择一个方案");
    expect(rendered.plain).toContain("方案：C · 生态打法");
    expect(rendered.plain).not.toContain("可选操作：");
  });
});
