/**
 * 展示卡构建器 —— 方案乙:agent / 进度卡用受控的 DisplayBlock 描述展示意图,构建器翻译成
 * Adaptive Cards 1.5 JSON,按服务端下放的能力清单(CardCaps)协商降级,统一脱敏(与 card-render
 * 同套 helper:URL 降级到 scheme://注册域、命中 secret shape 整块隐藏)。绝不产出会被服务端
 * 400 的结构,消费者无需自己判断白名单。
 *
 * 本轮支持的 block:heading / text / rich / facts / group(高价值子集)。
 * collapsible 在 P1-c 引入(依赖 caps.actions 里 Action.ToggleVisibility);
 * table/image/gallery/columns 后续轮次。
 *
 * 纯函数、无副作用、无 I/O —— hook 进度卡与 agent 展示卡工具共享这一层。
 */

import { cardSupports, isSensitive, reduceUrlsInText, type CardCaps } from "./card-render.js";
import { CARD_VERSION } from "./types.js";

// ── DisplayBlock:展示意图 ──────────────────────────────────
/** 富文本行内片段(rich block 用)。 */
export interface RichSegment {
  text: string;
  bold?: boolean;
  color?: "default" | "good" | "warning" | "attention" | "accent";
}

/** 一条键值(facts block 用)。 */
export interface Fact {
  label: string;
  value: string;
}

/** Container 语义着色(group block 用)。 */
export type GroupStyle = "default" | "good" | "warning" | "attention";

/**
 * 展示 block —— agent / 进度卡用它表达「想展示什么」,不直接写 AC element JSON。
 * 构建器负责翻译成受能力约束的 AC element,并在不支持时降级。
 */
export type DisplayBlock =
  | { type: "heading"; text: string; size?: "medium" | "large" }
  | { type: "text"; text: string }
  | { type: "rich"; segments: RichSegment[] }
  | { type: "facts"; items: Fact[] }
  | { type: "group"; style?: GroupStyle; blocks: DisplayBlock[] }
  | { type: "collapsible"; summary: string; blocks: DisplayBlock[] };

export interface BuildDisplayCardOptions {
  /** 卡片标题(渲染成置顶的 Bolder TextBlock)。 */
  title?: string;
  blocks: DisplayBlock[];
  /** 服务端能力清单;缺省用 card-render 的保守 baseline。 */
  caps?: CardCaps;
  /**
   * 内容是否**可信/已脱敏**。默认 false(不可信 agent 输入 → sanitize 用最严 generic=true)。
   * 进度卡文案上游已逐 sink 脱敏 → 传 true(sanitize 用 generic=false,不再二次误删 git SHA 等)。
   */
  trusted?: boolean;
}

export interface BuildDisplayCardResult {
  card: Record<string, unknown>;
  plain: string;
}

// ── 文本清洗(与 card-render 的参数摘要/错误脱敏同套)────────
/**
 * 群卡片全员可见 → 与 summarizeToolParams/sanitizeErrorText 同套:
 *   1. 折叠空白;
 *   2. 内嵌 URL 降级为 `scheme://注册域`(丢子域/path/query/userinfo,杀 webhook/预签名/隧道
 *      场景里的密钥);
 *   3. 命中 secret 关键词/形状 → 返回 null(整个 block 不渲染,fail-closed)。
 *
 * `generic`:
 *   - `true`(默认,**不可信** agent 展示卡输入)—— 额外套用长 hex/高熵检测,最严;
 *   - `false`(**可信**、上游已逐 sink 脱敏的进度卡文案)—— 只走关键词 + 明确前缀,避免把
 *     git SHA / docker digest / 缓存哈希等正常内容二次误删(见 renderProgressCard 的 trusted)。
 * 返回 null 表示"敏感,不该展示";空串同 null(text-only block 无内容也不渲染)。
 */
function sanitize(text: string, generic = true): string | null {
  let s = text.replace(/\s+/g, " ").trim();
  if (!s) return null;
  s = reduceUrlsInText(s).replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (isSensitive(s, generic)) return null;
  return s;
}

// ── 单 block → { elements, plainLines }─────────────────────
interface Rendered {
  elements: Record<string, unknown>[];
  plainLines: string[];
}

const EMPTY: Rendered = { elements: [], plainLines: [] };

/**
 * 渲染上下文 —— collapsible 需要在整卡内生成唯一 id 用于 Action.ToggleVisibility 的
 * targetElements。用 counter 而非 Math.random(),便于测试且不引入非确定性。
 */
interface RenderCtx {
  caps?: CardCaps;
  uid: { n: number };
  /** 传给 sanitize 的 generic 档位:false=可信(进度卡),true=不可信(agent 展示卡,默认最严)。 */
  generic: boolean;
}

function nextId(ctx: RenderCtx, prefix: string): string {
  return `${prefix}_${ctx.uid.n++}`;
}

function textBlock(text: string, opts?: { bold?: boolean; size?: "medium" | "large" }): Record<string, unknown> {
  return {
    type: "TextBlock",
    text,
    wrap: true,
    ...(opts?.bold ? { weight: "Bolder" } : {}),
    ...(opts?.size ? { size: opts.size === "medium" ? "Medium" : "Large" } : {}),
  };
}

function renderHeading(text: string, size: "medium" | "large" | undefined, ctx: RenderCtx): Rendered {
  const clean = sanitize(text, ctx.generic);
  if (!clean) return EMPTY;
  return { elements: [textBlock(clean, { bold: true, size })], plainLines: [clean] };
}

function renderText(text: string, ctx: RenderCtx): Rendered {
  const clean = sanitize(text, ctx.generic);
  if (!clean) return EMPTY;
  return { elements: [textBlock(clean)], plainLines: [clean] };
}

function renderRich(segments: RichSegment[], ctx: RenderCtx): Rendered {
  const joined = segments.map((s) => s.text).join("");
  // clean 走完整 sanitize:对**整段 joined** 做 URL 降级(能抓到跨 segment 拆开的 URL)+ secret 检查。
  const clean = sanitize(joined, ctx.generic);
  if (!clean) return EMPTY;
  // 关键(F1 修复):仅当 joined 里**没有任何可降级 URL** 时,才保留逐段 TextRun 的富样式 ——
  // 否则某个 segment(或跨段拆开)的 URL 会以原文进 TextRun,而 plain 已降级 → card ⊋ plain 泄露。
  // 含 URL 时降级为单个 TextBlock(用已降级的 clean),card 与 plain 一致、绝不多出密钥。
  const noReducibleUrl = reduceUrlsInText(joined) === joined;
  if (noReducibleUrl && cardSupports(ctx.caps, "RichTextBlock")) {
    return {
      elements: [
        {
          type: "RichTextBlock",
          inlines: segments.map((s) => ({
            type: "TextRun",
            text: s.text,
            ...(s.bold ? { weight: "Bolder" } : {}),
            ...(s.color && s.color !== "default" ? { color: s.color } : {}),
          })),
        },
      ],
      plainLines: [clean],
    };
  }
  // 降级:段拼成单个 TextBlock(已 URL 降级;顺带解决 ColumnSet plain 分行:一行完整而非按列拆行)。
  return { elements: [textBlock(clean)], plainLines: [clean] };
}

function renderFacts(items: Fact[], ctx: RenderCtx): Rendered {
  // 每条键值独立过 sanitize:label 或 value 命中 secret → 该条隐藏,不影响其它条(细粒度)。
  const cleaned: Array<{ label: string; value: string }> = [];
  for (const f of items) {
    const label = sanitize(f.label, ctx.generic);
    const value = sanitize(f.value, ctx.generic);
    if (!label || !value) continue;
    cleaned.push({ label, value });
  }
  if (cleaned.length === 0) return EMPTY;
  const plainLines = cleaned.map((f) => `${f.label}：${f.value}`);
  if (cardSupports(ctx.caps, "FactSet")) {
    return {
      elements: [
        {
          type: "FactSet",
          facts: cleaned.map((f) => ({ title: f.label, value: f.value })),
        },
      ],
      plainLines,
    };
  }
  // 降级:每条键值一行 TextBlock。
  return {
    elements: cleaned.map((f) => textBlock(`${f.label}：${f.value}`)),
    plainLines,
  };
}

function renderGroup(
  style: GroupStyle | undefined,
  blocks: DisplayBlock[],
  ctx: RenderCtx,
): Rendered {
  const inner = renderBlocks(blocks, ctx);
  if (inner.elements.length === 0) return EMPTY;
  if (cardSupports(ctx.caps, "Container")) {
    return {
      elements: [
        {
          type: "Container",
          ...(style && style !== "default" ? { style } : {}),
          items: inner.elements,
        },
      ],
      plainLines: inner.plainLines,
    };
  }
  // 降级:平铺子 block(不丢内容,只丢着色/分组视觉)。
  return inner;
}

/**
 * 折叠/展开 —— 升级条件三维齐备(forward-compat,任一未 advertise 就降级平铺):
 *   1. `caps.elements` 含 `Container` —— 用来包 hidden 内容 + `isVisible:false`;
 *   2. `caps.elements` 含 `ActionSet` —— 触发器容器(比 selectAction 更少属性依赖);
 *   3. `caps.actions` 含 `Action.ToggleVisibility` —— 具体动作被服务端接受(旧部署无该 advertise
 *      → 保守 fail-closed,避免乐观发出被 400)。
 *
 * summary 是永远可见的"点我展开"入口,inner 是默认隐藏的正文。降级形态 = summary 当 heading +
 * inner 全部展开在下方(视觉上等同"已展开",信息不丢)。
 *
 * 若 summary 被脱敏或空 / inner 全被脱敏或空,整个 collapsible 不渲染 —— 避免展开后是空块。
 */
function renderCollapsible(summary: string, blocks: DisplayBlock[], ctx: RenderCtx): Rendered {
  const cleanSummary = sanitize(summary, ctx.generic);
  if (!cleanSummary) return EMPTY;
  const inner = renderBlocks(blocks, ctx);
  if (inner.elements.length === 0) return EMPTY;

  const canToggle =
    cardSupports(ctx.caps, "Container") &&
    cardSupports(ctx.caps, "ActionSet") &&
    cardSupports(ctx.caps, "Action.ToggleVisibility");

  if (canToggle) {
    const targetId = nextId(ctx, "clp");
    return {
      elements: [
        textBlock(cleanSummary, { bold: true }),
        {
          type: "ActionSet",
          actions: [
            {
              type: "Action.ToggleVisibility",
              title: cleanSummary,
              targetElements: [targetId],
            },
          ],
        },
        {
          type: "Container",
          id: targetId,
          isVisible: false,
          items: inner.elements,
        },
      ],
      // plain 全展开,与折叠视觉无关。服务端 Finalize 会权威重算 plain。
      plainLines: [cleanSummary, ...inner.plainLines],
    };
  }

  // 降级:summary 当 heading + inner 全部展开在下方(零回归展开态)。
  return {
    elements: [textBlock(cleanSummary, { bold: true }), ...inner.elements],
    plainLines: [cleanSummary, ...inner.plainLines],
  };
}

function renderBlock(block: DisplayBlock, ctx: RenderCtx): Rendered {
  switch (block.type) {
    case "heading":
      return renderHeading(block.text, block.size, ctx);
    case "text":
      return renderText(block.text, ctx);
    case "rich":
      return renderRich(block.segments, ctx);
    case "facts":
      return renderFacts(block.items, ctx);
    case "group":
      return renderGroup(block.style, block.blocks, ctx);
    case "collapsible":
      return renderCollapsible(block.summary, block.blocks, ctx);
  }
}

function renderBlocks(blocks: DisplayBlock[], ctx: RenderCtx): Rendered {
  const elements: Record<string, unknown>[] = [];
  const plainLines: string[] = [];
  for (const b of blocks) {
    const r = renderBlock(b, ctx);
    elements.push(...r.elements);
    plainLines.push(...r.plainLines);
  }
  return { elements, plainLines };
}

/**
 * 构建展示卡。返回 `{ card, plain }`:card = AC 1.5 JSON(按 caps 协商降级、逐 block 脱敏),
 * plain = 纯文本兜底(与布局无关,服务端 Finalize 会权威重算)。
 */
export function buildDisplayCard(opts: BuildDisplayCardOptions): BuildDisplayCardResult {
  const { title, blocks, caps, trusted } = opts;
  const ctx: RenderCtx = { caps, uid: { n: 0 }, generic: !trusted };
  const body: Record<string, unknown>[] = [];
  const plainLines: string[] = [];

  if (title) {
    const cleanTitle = sanitize(title, ctx.generic);
    if (cleanTitle) {
      body.push(textBlock(cleanTitle, { bold: true }));
      plainLines.push(cleanTitle);
    }
  }

  const rendered = renderBlocks(blocks, ctx);
  body.push(...rendered.elements);
  plainLines.push(...rendered.plainLines);

  // 服务端 max_nodes 权威约束:顶层 body 元素数超上限时截断并附一行说明,避免 edit/send 撞 400
  // (card-blocks.ts 契约「绝不产出会被服务端 400 的结构」)。节点计数取顶层元素的保守近似。
  const maxNodes = caps?.maxNodes;
  if (typeof maxNodes === "number" && maxNodes > 0 && body.length > maxNodes) {
    const keep = Math.max(1, maxNodes - 1); // 留一格给「截断」提示
    const dropped = body.length - keep;
    body.length = keep;
    // 同步截断 plainLines,保持「plain 与 card 同步」不变量:否则 plain 会列出 card 已丢弃的项。
    // flat 卡片下 body/plainLines 一一对应,截断精确;嵌套卡片下为近似(plain 本就是 advisory,
    // 服务端 Finalize 会权威重算),至少不再多列一整串被丢弃的内容。
    plainLines.length = Math.min(plainLines.length, keep);
    body.push(textBlock(`… 省略 ${dropped} 项(超出服务端节点上限)`));
    plainLines.push(`… 省略 ${dropped} 项`);
  }

  const card: Record<string, unknown> = {
    type: "AdaptiveCard",
    version: CARD_VERSION,
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    body,
  };
  return { card, plain: plainLines.join("\n") };
}

// ── 不可信输入验证 ────────────────────────────────────────────
/**
 * 白名单校验 agent / 外部输入的 DisplayBlock —— 每 block:
 *   - `type` 在支持集内(heading/text/rich/facts/group/collapsible);
 *   - 关键字段类型正确(text 是 string;facts.items 是 [{label,value}];rich.segments 是 [{text}];
 *     group.blocks / collapsible.blocks 递归校验;heading.size 若给则限于 medium/large)。
 * 任何字段类型错的整块**静默丢弃**(不 fail 整个构建),避免 agent 单个字段错就完全无回复。
 * 内容脱敏由 buildDisplayCard/sanitize 兜底,此处只做结构校验。
 */
/**
 * 不可信输入的结构上限 —— 防止深嵌套(RangeError 栈溢出)/超大数组(node 爆炸 → 服务端 400),
 * 与服务端 limits(max_depth≈16 / max_nodes)对齐的保守本地预检。超限静默截断,不 fail 整卡。
 */
const MAX_BLOCK_DEPTH = 12; // group/collapsible 嵌套深度
const MAX_TOTAL_BLOCKS = 200; // 整棵树累计 block 数(近似 node 上限)

export function validateDisplayBlocks(input: unknown): DisplayBlock[] {
  return validateBlockList(input, MAX_BLOCK_DEPTH, { count: 0 });
}

/** 带深度/总数预算的递归校验。深度耗尽 → 该层丢弃;总数耗尽 → 停止收集。 */
function validateBlockList(
  input: unknown,
  depth: number,
  budget: { count: number },
): DisplayBlock[] {
  if (!Array.isArray(input) || depth <= 0) return [];
  const out: DisplayBlock[] = [];
  for (const raw of input) {
    if (budget.count >= MAX_TOTAL_BLOCKS) break;
    budget.count++;
    const b = validateOneBlock(raw, depth, budget);
    if (b) out.push(b);
  }
  return out;
}

const HEADING_SIZES = new Set(["medium", "large"]);
const GROUP_STYLES = new Set(["default", "good", "warning", "attention"]);
const RICH_COLORS = new Set(["default", "good", "warning", "attention", "accent"]);

function validateOneBlock(raw: unknown, depth: number, budget: { count: number }): DisplayBlock | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  switch (r.type) {
    case "heading": {
      if (typeof r.text !== "string") return null;
      const size = r.size;
      if (size !== undefined && (typeof size !== "string" || !HEADING_SIZES.has(size))) return null;
      return size ? { type: "heading", text: r.text, size: size as "medium" | "large" } : { type: "heading", text: r.text };
    }
    case "text": {
      if (typeof r.text !== "string") return null;
      return { type: "text", text: r.text };
    }
    case "rich": {
      if (!Array.isArray(r.segments)) return null;
      const segs: RichSegment[] = [];
      for (const s of r.segments) {
        if (!s || typeof s !== "object") continue;
        const seg = s as Record<string, unknown>;
        if (typeof seg.text !== "string") continue;
        const color = seg.color;
        if (color !== undefined && (typeof color !== "string" || !RICH_COLORS.has(color))) continue;
        segs.push({
          text: seg.text,
          ...(seg.bold === true ? { bold: true } : {}),
          ...(typeof color === "string" ? { color: color as RichSegment["color"] } : {}),
        });
      }
      if (segs.length === 0) return null;
      return { type: "rich", segments: segs };
    }
    case "facts": {
      if (!Array.isArray(r.items)) return null;
      const items: Fact[] = [];
      for (const it of r.items) {
        // facts.items 也计入总节点预算 —— 服务端按 fact 递归计 node,一个 facts 块可膨胀成
        // 上千节点撞 max_nodes(400)。这里连同 block 一起受 MAX_TOTAL_BLOCKS 约束,超预算即停止收集。
        if (budget.count >= MAX_TOTAL_BLOCKS) break;
        if (!it || typeof it !== "object") continue;
        const f = it as Record<string, unknown>;
        if (typeof f.label !== "string" || typeof f.value !== "string") continue;
        budget.count++;
        items.push({ label: f.label, value: f.value });
      }
      if (items.length === 0) return null;
      return { type: "facts", items };
    }
    case "group": {
      const inner = validateBlockList(r.blocks, depth - 1, budget);
      if (inner.length === 0) return null;
      const style = r.style;
      if (style !== undefined && (typeof style !== "string" || !GROUP_STYLES.has(style))) return null;
      return style
        ? { type: "group", style: style as GroupStyle, blocks: inner }
        : { type: "group", blocks: inner };
    }
    case "collapsible": {
      if (typeof r.summary !== "string") return null;
      const inner = validateBlockList(r.blocks, depth - 1, budget);
      if (inner.length === 0) return null;
      return { type: "collapsible", summary: r.summary, blocks: inner };
    }
    default:
      return null;
  }
}
