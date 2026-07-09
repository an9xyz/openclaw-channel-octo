import { describe, it, expect } from "vitest";
import { buildDisplayCard, validateDisplayBlocks, type DisplayBlock } from "./card-blocks.js";
import type { CardCaps } from "./card-render.js";

/**
 * 展示卡构建器 —— 方案乙契约测试:DisplayBlock → AC 1.5 JSON,按 caps 协商降级,
 * 每 block 产 plain 兜底,脱敏与 card-render 同套(URL 降级 + secret 命中隐藏)。
 */

/** 便利:advertise 全套元素(RichTextBlock/FactSet/Container 都可用)。 */
const FULL_CAPS: CardCaps = {
  elements: new Set(["TextBlock", "RichTextBlock", "FactSet", "Container", "ColumnSet", "Column", "Image"]),
};

/** 便利:仅基线(相当于旧部署不 advertise elements,card-render baseline)。 */
const BASELINE_CAPS: CardCaps | undefined = undefined;

/** 类型窄化:取 body 元素。 */
type Element = Record<string, unknown>;
function body(res: { card: Record<string, unknown> }): Element[] {
  return (res.card.body as Element[]) ?? [];
}

describe("buildDisplayCard 骨架", () => {
  it("最小卡:type=AdaptiveCard + version=1.5 + $schema + body 数组", () => {
    const { card } = buildDisplayCard({ blocks: [] });
    expect(card.type).toBe("AdaptiveCard");
    expect(card.version).toBe("1.5");
    expect(card.$schema).toBe("http://adaptivecards.io/schemas/adaptive-card.json");
    expect(Array.isArray(card.body)).toBe(true);
  });

  it("title 渲染成置顶 Bolder TextBlock,plain 首行是 title", () => {
    const { card, plain } = buildDisplayCard({ title: "审批请求", blocks: [] });
    const els = body({ card });
    expect(els[0]).toEqual({ type: "TextBlock", text: "审批请求", wrap: true, weight: "Bolder" });
    expect(plain.split("\n")[0]).toBe("审批请求");
  });

  it("plain 每个 block 一行,与视觉降级无关", () => {
    const { plain } = buildDisplayCard({
      blocks: [
        { type: "heading", text: "H" },
        { type: "text", text: "L1" },
        { type: "text", text: "L2" },
      ],
    });
    expect(plain.split("\n")).toEqual(["H", "L1", "L2"]);
  });
});

describe("heading / text block", () => {
  it("heading → Bolder TextBlock", () => {
    const { card } = buildDisplayCard({ blocks: [{ type: "heading", text: "标题" }] });
    expect(body({ card })[0]).toEqual({ type: "TextBlock", text: "标题", wrap: true, weight: "Bolder" });
  });

  it("text → 普通 TextBlock(wrap)", () => {
    const { card } = buildDisplayCard({ blocks: [{ type: "text", text: "正文" }] });
    expect(body({ card })[0]).toEqual({ type: "TextBlock", text: "正文", wrap: true });
  });

  it("text 内嵌 URL 降级到 scheme://注册域(webhook/隧道/预签名主机都吃)", () => {
    const { card } = buildDisplayCard({
      blocks: [{ type: "text", text: "回调 https://hooks.slack.com/services/T00/B00/xy → 500" }],
    });
    // Slack webhook path 里嵌的密钥被 URL 降级抹掉,只留 slack.com 主机
    expect((body({ card })[0] as { text: string }).text).toContain("https://slack.com");
    expect((body({ card })[0] as { text: string }).text).not.toContain("xy");
    expect((body({ card })[0] as { text: string }).text).not.toContain("services");
  });

  it("text 命中 secret shape → 整个 block 不渲染(fail-closed)", () => {
    const { card, plain } = buildDisplayCard({
      blocks: [
        { type: "text", text: "token=AKIAIOSFODNN7EXAMPLE" }, // AWS key shape
        { type: "text", text: "正常正文" },
      ],
    });
    const texts = body({ card }).map((e) => (e as { text?: string }).text);
    expect(texts).toContain("正常正文");
    expect(texts).not.toContain("token=AKIAIOSFODNN7EXAMPLE");
    // plain 也应隐藏,保持一致
    expect(plain).not.toContain("AKIA");
  });
});

describe("rich block(高价值:一行多样式,顺带解决 ColumnSet plain 分行)", () => {
  it("advertise RichTextBlock → RichTextBlock + inlines(bold/color 逐段)", () => {
    const { card } = buildDisplayCard({
      caps: FULL_CAPS,
      blocks: [{ type: "rich", segments: [
        { text: "📖 " },
        { text: "读取文件", bold: true },
        { text: "：/a.md" },
        { text: " · 30ms", color: "good" },
      ]}],
    });
    const el = body({ card })[0] as { type: string; inlines: Array<Record<string, unknown>> };
    expect(el.type).toBe("RichTextBlock");
    expect(el.inlines).toHaveLength(4);
    expect(el.inlines[1]).toEqual({ type: "TextRun", text: "读取文件", weight: "Bolder" });
    expect(el.inlines[3]).toEqual({ type: "TextRun", text: " · 30ms", color: "good" });
  });

  it("不 advertise RichTextBlock → 段拼成单个 TextBlock(降级,零回归)", () => {
    const { card, plain } = buildDisplayCard({
      caps: { elements: new Set(["TextBlock"]) }, // 只 baseline TextBlock
      blocks: [{ type: "rich", segments: [
        { text: "📖 " },
        { text: "读取文件" },
        { text: "：/a.md · 30ms" },
      ]}],
    });
    const el = body({ card })[0] as { type: string; text: string };
    expect(el.type).toBe("TextBlock");
    expect(el.text).toBe("📖 读取文件：/a.md · 30ms"); // 一行,顺带解决 ColumnSet plain 分行
    expect(plain).toBe("📖 读取文件：/a.md · 30ms");
  });

  it("rich 段命中 secret → 整块隐藏", () => {
    const { card } = buildDisplayCard({
      caps: FULL_CAPS,
      blocks: [{ type: "rich", segments: [
        { text: "Bearer sk-1234567890abcdef" },
      ]}],
    });
    expect(body({ card })).toEqual([]);
  });

  it("F1: rich 段内 URL 也降级 —— card 绝不多于 plain(webhook 密钥不进 TextRun)", () => {
    const { card, plain } = buildDisplayCard({
      caps: FULL_CAPS,
      blocks: [{ type: "rich", segments: [
        { text: "Webhook: " },
        { text: "https://hooks.slack.com/services/T00000000/B11111111/AbCdEfSecretTokenXyz123" }, // gitleaks:allow (fake fixture)
      ]}],
    });
    const cardStr = JSON.stringify(card);
    expect(cardStr).not.toContain("AbCdEfSecretTokenXyz123");
    expect(cardStr).not.toContain("/services/");
    expect(cardStr).toContain("https://slack.com");
    expect(plain).toBe("Webhook: https://slack.com");
    // 含 URL → 降级为单个 TextBlock(不再逐段 TextRun,防跨段拆开的 URL 漏出)
    expect((body({ card })[0] as { type: string }).type).toBe("TextBlock");
  });

  it("前缀式密钥被词字符粘连(含 rich 段空串拼接)也不漏进卡体", () => {
    // 回归 yujiawei P1:renderRich 用空串拼 segments,相邻段会把 `foo` 与 `sk-…` 粘成 `foosk-…`,
    // 抹掉词界 → 若前缀检测带 `\b` 就漏。text 单字段粘连同理。
    const text = buildDisplayCard({ blocks: [{ type: "text", text: "KeyAKIA1234567890ABCDEF" }], caps: FULL_CAPS });
    expect(JSON.stringify(text.card)).not.toContain("AKIA1234567890ABCDEF");
    expect(text.plain).not.toContain("AKIA1234567890ABCDEF");
    const rich = buildDisplayCard({
      caps: FULL_CAPS,
      blocks: [{ type: "rich", segments: [{ text: "foo" }, { text: "sk-liveABCDEFGHIJKLMNOP" }] }],
    });
    expect(JSON.stringify(rich.card)).not.toContain("sk-liveABCDEFGHIJKLMNOP");
    expect(rich.plain).not.toContain("sk-liveABCDEFGHIJKLMNOP");
  });

  it("F1: URL 跨 segment 拆开也不漏(joined 降级 + 降级为 TextBlock)", () => {
    const { card, plain } = buildDisplayCard({
      caps: FULL_CAPS,
      blocks: [{ type: "rich", segments: [
        { text: "https://hooks.slack.com/services/T00" },
        { text: "/B00/SuperSecretTail99" },
      ]}],
    });
    const cardStr = JSON.stringify(card);
    expect(cardStr).not.toContain("SuperSecretTail99");
    expect(plain).toBe("https://slack.com");
  });
});

describe("facts block(键值对)", () => {
  it("advertise FactSet → FactSet + facts[]", () => {
    const { card } = buildDisplayCard({
      caps: FULL_CAPS,
      blocks: [{ type: "facts", items: [
        { label: "状态", value: "已完成" },
        { label: "耗时", value: "30ms" },
      ]}],
    });
    const el = body({ card })[0] as { type: string; facts: Array<{ title: string; value: string }> };
    expect(el.type).toBe("FactSet");
    expect(el.facts).toEqual([
      { title: "状态", value: "已完成" },
      { title: "耗时", value: "30ms" },
    ]);
  });

  it("不 advertise FactSet → 降级为多行 TextBlock 「label:value」", () => {
    const { card, plain } = buildDisplayCard({
      caps: { elements: new Set(["TextBlock"]) },
      blocks: [{ type: "facts", items: [
        { label: "状态", value: "已完成" },
        { label: "耗时", value: "30ms" },
      ]}],
    });
    const els = body({ card });
    expect(els).toHaveLength(2);
    expect((els[0] as { text: string }).text).toBe("状态：已完成");
    expect((els[1] as { text: string }).text).toBe("耗时：30ms");
    expect(plain).toBe("状态：已完成\n耗时：30ms");
  });

  it("facts.value 内嵌 URL 降级;命中 secret → 该条隐藏,不影响其它条", () => {
    const { card, plain } = buildDisplayCard({
      caps: FULL_CAPS,
      blocks: [{ type: "facts", items: [
        { label: "webhook", value: "https://hooks.slack.com/services/T/B/xy" },
        { label: "token", value: "AKIAIOSFODNN7EXAMPLE" }, // secret shape
        { label: "状态", value: "ok" },
      ]}],
    });
    const el = body({ card })[0] as { facts: Array<{ title: string; value: string }> };
    // 3 条剩下 2 条:webhook 只留主机;token 整条被抹;状态原样
    expect(el.facts).toHaveLength(2);
    expect(el.facts[0].value).toBe("https://slack.com");
    expect(el.facts[1].title).toBe("状态");
    expect(plain).not.toContain("AKIA");
  });
});

describe("group block(分组着色)", () => {
  it("advertise Container → Container(style)包住子 block", () => {
    const { card } = buildDisplayCard({
      caps: FULL_CAPS,
      blocks: [{ type: "group", style: "good", blocks: [
        { type: "text", text: "成功" },
      ]}],
    });
    const el = body({ card })[0] as { type: string; style: string; items: Element[] };
    expect(el.type).toBe("Container");
    expect(el.style).toBe("good");
    expect(el.items).toHaveLength(1);
    expect((el.items[0] as { text: string }).text).toBe("成功");
  });

  it("baseline(无 caps)含 Container → 走 Container 路径(零回归)", () => {
    const { card } = buildDisplayCard({
      caps: BASELINE_CAPS,
      blocks: [{ type: "group", blocks: [{ type: "text", text: "内" }] }],
    });
    expect((body({ card })[0] as { type: string }).type).toBe("Container");
  });

  it("不 advertise Container → 平铺子 block(降级不丢内容,只丢着色)", () => {
    const { card } = buildDisplayCard({
      caps: { elements: new Set(["TextBlock"]) },
      blocks: [{ type: "group", style: "warning", blocks: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]}],
    });
    const els = body({ card });
    expect(els).toHaveLength(2); // 平铺,无 Container 外壳
    expect((els[0] as { text: string }).text).toBe("a");
    expect((els[1] as { text: string }).text).toBe("b");
  });
});

describe("collapsible block(forward-compat 折叠/展开)", () => {
  /**
   * 升级 = advertise Container + advertise ActionSet + advertise Action.ToggleVisibility。
   * 任一不满足 → 降级为平铺(summary 当 heading,inner 全部展开在下方 —— 零回归)。
   */
  const CAPS_WITH_TOGGLE: CardCaps = {
    elements: new Set(["TextBlock", "Container", "ActionSet"]),
    actions: new Set(["Action.ToggleVisibility"]),
  };

  it("advertise ToggleVisibility+ActionSet+Container → 升级:summary+隐藏 Container", () => {
    const { card } = buildDisplayCard({
      caps: CAPS_WITH_TOGGLE,
      blocks: [{ type: "collapsible", summary: "详情", blocks: [
        { type: "text", text: "机密上下文 A" },
        { type: "text", text: "机密上下文 B" },
      ]}],
    });
    const els = body({ card });
    // 应有:summary(TextBlock)+ toggle 触发器(ActionSet)+ 目标 Container(isVisible:false)
    const container = els.find((e) => e.type === "Container") as { id: string; isVisible: boolean; items: Element[] };
    expect(container).toBeTruthy();
    expect(container.isVisible).toBe(false);
    expect(container.id).toBeTruthy(); // 有 id 才能 target
    expect(container.items).toHaveLength(2);

    const actionSet = els.find((e) => e.type === "ActionSet") as { actions: Array<Record<string, unknown>> };
    expect(actionSet).toBeTruthy();
    expect(actionSet.actions[0]).toMatchObject({
      type: "Action.ToggleVisibility",
      title: "详情",
      targetElements: [container.id],
    });
  });

  it("plain 兜底:summary + 详情行(全展开,与折叠无关 —— 服务端 Finalize 权威重算)", () => {
    const { plain } = buildDisplayCard({
      caps: CAPS_WITH_TOGGLE,
      blocks: [{ type: "collapsible", summary: "详情", blocks: [
        { type: "text", text: "行1" },
        { type: "text", text: "行2" },
      ]}],
    });
    expect(plain).toBe("详情\n行1\n行2");
  });

  it("未 advertise Action.ToggleVisibility → 降级平铺(summary 当 heading,inner 展开)", () => {
    // Container/ActionSet 有,但缺 actions 白名单 → 保守降级。
    const { card } = buildDisplayCard({
      caps: { elements: new Set(["TextBlock", "Container", "ActionSet"]) }, // 无 actions
      blocks: [{ type: "collapsible", summary: "详情", blocks: [
        { type: "text", text: "行1" },
      ]}],
    });
    const els = body({ card });
    // 无 ActionSet / 无 isVisible:false 的 Container(全展开,heading + text)
    expect(els.some((e) => e.type === "ActionSet")).toBe(false);
    expect(els.some((e) => (e as { isVisible?: boolean }).isVisible === false)).toBe(false);
    // 至少有:summary heading + inner 行
    const texts = els.map((e) => (e as { text?: string }).text).filter(Boolean);
    expect(texts).toEqual(expect.arrayContaining(["详情", "行1"]));
  });

  it("未 advertise ActionSet → 同样降级(缺哪一维都退回展开)", () => {
    const { card } = buildDisplayCard({
      caps: {
        elements: new Set(["TextBlock", "Container"]), // 缺 ActionSet
        actions: new Set(["Action.ToggleVisibility"]),
      },
      blocks: [{ type: "collapsible", summary: "S", blocks: [{ type: "text", text: "inner" }] }],
    });
    const els = body({ card });
    expect(els.some((e) => e.type === "ActionSet")).toBe(false);
  });

  it("summary 命中 secret 整块隐藏(fail-closed);summary 空 → 整块跳过", () => {
    const { card: c1 } = buildDisplayCard({
      caps: CAPS_WITH_TOGGLE,
      blocks: [{ type: "collapsible", summary: "Bearer sk-1234567890abcdef", blocks: [
        { type: "text", text: "inner" },
      ]}],
    });
    expect(body({ card: c1 })).toEqual([]);

    const { card: c2 } = buildDisplayCard({
      caps: CAPS_WITH_TOGGLE,
      blocks: [{ type: "collapsible", summary: "", blocks: [{ type: "text", text: "inner" }] }],
    });
    expect(body({ card: c2 })).toEqual([]);
  });

  it("inner 全部空/被脱敏抹掉 → 整个 collapsible 不渲染(避免产生「点击展开发现空」的死块)", () => {
    const { card } = buildDisplayCard({
      caps: CAPS_WITH_TOGGLE,
      blocks: [{ type: "collapsible", summary: "标题", blocks: [
        { type: "text", text: "" },
        { type: "text", text: "AKIAIOSFODNN7EXAMPLE" }, // secret shape → 隐藏
      ]}],
    });
    expect(body({ card })).toEqual([]);
  });

  it("多个 collapsible 各自 target 独立 id(不串扰)", () => {
    const { card } = buildDisplayCard({
      caps: CAPS_WITH_TOGGLE,
      blocks: [
        { type: "collapsible", summary: "A", blocks: [{ type: "text", text: "a" }] },
        { type: "collapsible", summary: "B", blocks: [{ type: "text", text: "b" }] },
      ],
    });
    const containers = body({ card }).filter((e) => e.type === "Container") as Array<{ id: string }>;
    expect(containers).toHaveLength(2);
    expect(containers[0].id).not.toBe(containers[1].id);
  });
});

describe("组合与边界", () => {
  it("多种 block 依序 + title,plain 逐行", () => {
    const blocks: DisplayBlock[] = [
      { type: "heading", text: "报告" },
      { type: "facts", items: [{ label: "总数", value: "3" }] },
      { type: "text", text: "尾注" },
    ];
    const { plain } = buildDisplayCard({ title: "T", blocks, caps: FULL_CAPS });
    expect(plain).toBe("T\n报告\n总数：3\n尾注");
  });

  it("空 blocks + 空 title → 空 body,plain 为空串", () => {
    const { card, plain } = buildDisplayCard({ blocks: [] });
    expect(body({ card })).toEqual([]);
    expect(plain).toBe("");
  });

  it("空白 text 自动跳过(不产元素也不产 plain 行)", () => {
    const { card, plain } = buildDisplayCard({
      blocks: [
        { type: "text", text: "" },
        { type: "text", text: "   " },
        { type: "text", text: "有内容" },
      ],
    });
    expect(body({ card })).toHaveLength(1);
    expect(plain).toBe("有内容");
  });

  it("F3: 超 max_nodes → 截断 body 并附省略提示(不产出会被服务端 400 的结构)", () => {
    const many: DisplayBlock[] = Array.from({ length: 10 }, (_, i) => ({ type: "text", text: `行${i}` }));
    const { card, plain } = buildDisplayCard({ blocks: many, caps: { elements: new Set(["TextBlock"]), maxNodes: 3 } });
    const b = body({ card }) as Array<{ type: string; text: string }>;
    expect(b).toHaveLength(3);
    expect(b[2].text).toContain("省略");
    // plain 与 card 同步:被卡片丢弃的项(行2..行9)不得出现在 plain 里(P2-1)
    expect(plain.split("\n")).toHaveLength(3);
    expect(plain).not.toContain("行2");
    expect(plain).not.toContain("行9");
    expect(plain).toContain("行0");
  });
});

describe("validateDisplayBlocks 结构上限(不可信输入)", () => {
  it("F6: 超深嵌套不 RangeError(深度耗尽 → 该层丢弃)", () => {
    let deep: unknown = { type: "text", text: "leaf" };
    for (let i = 0; i < 5000; i++) deep = { type: "group", blocks: [deep] };
    expect(() => validateDisplayBlocks([deep])).not.toThrow();
  });

  it("F6: 超大数组按总数上限截断", () => {
    const huge = Array.from({ length: 100000 }, (_, i) => ({ type: "text", text: `t${i}` }));
    const out = validateDisplayBlocks(huge);
    expect(out.length).toBeLessThanOrEqual(200);
  });

  it("合法浅结构照常通过", () => {
    const out = validateDisplayBlocks([
      { type: "heading", text: "H" },
      { type: "group", blocks: [{ type: "text", text: "x" }] },
    ]);
    expect(out).toHaveLength(2);
  });

  it("facts.items 计入总节点预算 —— facts-heavy 卡被截断(防服务端 node 上限 400)", () => {
    const bigFacts = { type: "facts", items: Array.from({ length: 1000 }, (_, i) => ({ label: `k${i}`, value: `v${i}` })) };
    const out = validateDisplayBlocks([bigFacts]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("facts");
    const items = (out[0] as { items: unknown[] }).items;
    expect(items.length).toBeLessThanOrEqual(200); // 受 MAX_TOTAL_BLOCKS 约束
  });
});
