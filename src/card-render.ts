/**
 * InteractiveCard(=17) 进度卡渲染 —— 把 agent 运行状态渲染成 Adaptive Cards 1.5
 * JSON（octo/v1 profile 白名单:TextBlock/Container 等）。纯函数、无副作用、无
 * `Date.now`（耗时由 state.elapsedMs 传入），便于单测。
 *
 * 波 B(卡片进度帧):卡仅承载过程/状态(C2 决策),最终答案走文本。
 * 帧内容:工具名友好化 + 参数摘要 + 耗时,让用户看清 agent 在做什么。
 * 视觉属性仅用端到端验证过的(weight/spacing/size/wrap),不用未验证的 color 以规避白名单。
 */
import { CARD_PLACEHOLDER } from "./types.js";

/** 单个工具步骤的状态。 */
export interface CardStep {
  tool: string;
  status: "running" | "done" | "error";
  durationMs?: number;
  error?: string;
  /** 参数摘要(在读哪个文件 / 执行什么命令),来自 before_tool_call 的 params。 */
  summary?: string;
  /**
   * SDK 提供的工具调用唯一 id(before/after_tool_call 都带)。用于把 after 事件
   * 精确回填到对应步骤 —— 并发同名工具(两个 exec/process)乱序完成时,按 id 匹配
   * 避免把 duration/error 标到错误行。缺失(旧 host)时回退按 toolName 匹配。
   */
  toolCallId?: string;
}

/** 进度卡的渲染状态。 */
export interface CardProgressState {
  phase: "thinking" | "tool" | "done" | "error";
  steps: CardStep[];
  elapsedMs?: number;
  errorText?: string;
}

const MCP_TOOL_PREFIX = "mcp__";

/** 常见工具 → 图标 + 中文标签;未知工具用通用图标 + 原名。 */
const TOOL_META: Record<string, { icon: string; label: string }> = {
  read: { icon: "📖", label: "读取文件" },
  write: { icon: "✏️", label: "写入文件" },
  edit: { icon: "✏️", label: "编辑文件" },
  apply_patch: { icon: "✏️", label: "修改代码" },
  exec: { icon: "⌨️", label: "执行命令" },
  bash: { icon: "⌨️", label: "执行命令" },
  shell: { icon: "⌨️", label: "执行命令" },
  process: { icon: "⚙️", label: "运行进程" },
  search: { icon: "🔍", label: "搜索" },
  grep: { icon: "🔍", label: "搜索内容" },
  glob: { icon: "🔍", label: "查找文件" },
  ls: { icon: "📂", label: "浏览目录" },
  fetch: { icon: "🌐", label: "抓取网页" },
  web_search: { icon: "🌐", label: "联网搜索" },
  octo_management: { icon: "💬", label: "Octo 操作" },
};

/** 工具名 → 图标 + 标签。MCP 工具(`mcp__server__tool`)解析 server/tool。 */
export function resolveToolMeta(tool: string): { icon: string; label: string } {
  if (tool.startsWith(MCP_TOOL_PREFIX)) {
    const rest = tool.slice(MCP_TOOL_PREFIX.length).replace(/__/g, " / ");
    return { icon: "🔌", label: `MCP ${rest}` };
  }
  return TOOL_META[tool] ?? { icon: "🔧", label: tool };
}

const SUMMARY_MAX = 64;

/**
 * 敏感串守卫模式。群卡片对全体成员可见 —— 摘要一旦命中即整串隐藏(fail-safe:
 * 宁可误伤含 "token" 字样的正常文本,也不泄露 token/密钥/口令)。
 */
const SECRET_RE =
  /token|api[_-]?key|secret|password|passwd|pwd|authorization|bearer|access[_-]?key|client[_-]?secret|credential/i;

/**
 * 工具 → 摘要提取策略(allowlist)。未列出的工具(含 MCP、未知工具)一律**不显示摘要**,
 * 杜绝把任意参数直渲到群卡片的泄露面。
 */
type SummaryStrategy = "path" | "shell" | "url" | "query";
const SUMMARY_STRATEGY: Record<string, SummaryStrategy> = {
  read: "path", write: "path", edit: "path", apply_patch: "path", ls: "path", glob: "path",
  exec: "shell", bash: "shell", shell: "shell", process: "shell",
  fetch: "url",
  web_search: "query", search: "query", grep: "query",
};

/** 取 keys 中首个非空字符串值。 */
function firstString(p: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = p[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}

/**
 * shell:只取程序名。跳过前缀式环境变量赋值(`VAR=value cmd ...`)—— 否则会把密钥值
 * (如 `SLACK_WEBHOOK=https://…`、`MY_CREDS=xxx`)当成程序名原样渲染,且这类变量名多不含
 * token/secret 等关键词,躲过 SECRET_RE。不渲染任何参数。
 *
 * 落定的 program token 再过一层保守形状校验:只接受 `[\w./@:+-]`(程序名/路径的合法字符)。
 * 空白分词无法解析带引号的多词值(`TOKEN="a b" cmd` 会切成 `TOKEN="a`/`b"`/`cmd`,跳过
 * 首个后落在片段 `b"`),含引号/空格/等号等异常字符的 token 一律判为可疑值片段 → 不展示。
 */
const PROGRAM_TOKEN_RE = /^[A-Za-z0-9_./@:+-]+$/;
function summarizeShell(p: Record<string, unknown>): string {
  const cmd = firstString(p, ["command", "cmd"]).trim();
  if (!cmd) return "";
  const tokens = cmd.split(/\s+/);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  const prog = tokens[i] ?? "";
  return PROGRAM_TOKEN_RE.test(prog) ? prog : "";
}

/**
 * url:**只保留 scheme://host**,丢弃 path/query/userinfo。凭据既可能在 query,也常整段
 * 嵌在 path 里(Slack/Discord incoming webhook `/services/T../B../XXXX`),且随机 token
 * 不含关键词、躲过 SECRET_RE —— 故 path 一并不展示,只暴露主机名。
 */
function summarizeUrl(p: Record<string, unknown>): string {
  const raw = firstString(p, ["url"]);
  if (!raw) return "";
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return ""; // 解析失败 → 不显示(原串可能含 token)
  }
}

/**
 * 从工具参数提取一句人可读摘要 —— 按工具 allowlist 策略取值,未知/MCP 工具不显示,
 * 命中敏感串则整串隐藏,最后折叠空白并截断。群卡片对全员可见,安全优先于信息量。
 */
export function summarizeToolParams(toolName: string | undefined, params: unknown): string {
  if (!toolName || !params || typeof params !== "object") return "";
  const strategy = SUMMARY_STRATEGY[toolName];
  if (!strategy) return ""; // MCP / 未知工具:不渲染任意参数
  const p = params as Record<string, unknown>;
  let v: string;
  switch (strategy) {
    case "path": v = firstString(p, ["path", "file_path", "file"]); break;
    case "shell": v = summarizeShell(p); break;
    case "url": v = summarizeUrl(p); break;
    case "query": v = firstString(p, ["query", "pattern"]); break;
  }
  if (!v) return "";
  const s = v.replace(/\s+/g, " ").trim();
  if (!s || SECRET_RE.test(s)) return ""; // 敏感串守卫:命中即隐藏
  return s.length > SUMMARY_MAX ? s.slice(0, SUMMARY_MAX) + "…" : s;
}

/** ms → 友好耗时(<1s 用 ms,否则 x.xs)。 */
export function fmtDuration(ms?: number): string {
  if (typeof ms !== "number") return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** 单步 → 一行文案:图标 + 标签 + 参数摘要 + 状态/耗时。 */
export function stepLine(step: CardStep): string {
  const { icon, label } = resolveToolMeta(step.tool);
  const sum = step.summary ? `：${step.summary}` : "";
  if (step.status === "running") return `⏳ ${label}${sum}`;
  if (step.status === "error") return `❌ ${label}${sum}${step.error ? ` — ${step.error}` : ""}`;
  const dur = fmtDuration(step.durationMs);
  return `${icon} ${label}${sum}${dur ? ` · ${dur}` : ""}`;
}

function headerText(state: CardProgressState): string {
  switch (state.phase) {
    case "thinking":
      return "🤖 思考中…";
    case "tool":
      return "🤖 正在处理…";
    case "error":
      return `⚠️ 已中断${state.errorText ? `：${state.errorText}` : ""}`;
    case "done": {
      const n = state.steps.length;
      const secs = fmtDuration(state.elapsedMs);
      const parts = ["✅ 已完成"];
      if (n > 0) parts.push(`${n} 步`);
      if (secs) parts.push(secs);
      return parts.join(" · ");
    }
  }
}

/**
 * 展示步骤上限。长任务工具调用不断累积,若全量渲染成 TextBlock,卡片体积会持续膨胀,
 * 最终可能超服务端结构上限导致 edit 400、进度冻结。这里用确定性本地上限裁剪(与服务端
 * limits 无关,不依赖其未定义的 key schema):超出只渲染最近 N 步 + 顶部一行省略计数。
 */
const MAX_VISIBLE_STEPS = 12;

/**
 * 渲染进度卡。返回 `{ card, plain }`:
 *   - `card` = Adaptive Cards 1.5 JSON(header + 每步一行,octo/v1 白名单内;不用 color/
 *     markdown 链接,规避白名单/scheme 校验)。
 *   - `plain` = 纯文本兜底(服务端 Finalize 会权威重算,此处保证 never empty)。
 */
export function renderProgressCard(state: CardProgressState): {
  card: Record<string, unknown>;
  plain: string;
} {
  const header = headerText(state);
  const total = state.steps.length;
  // 只展示最近 MAX_VISIBLE_STEPS 步;更早的折叠成一行计数,避免卡片无界膨胀。
  const hidden = Math.max(0, total - MAX_VISIBLE_STEPS);
  const visibleSteps = hidden > 0 ? state.steps.slice(-MAX_VISIBLE_STEPS) : state.steps;
  const lines: string[] = [];
  if (hidden > 0) lines.push(`… 省略前 ${hidden} 步`);
  for (const s of visibleSteps) lines.push(stepLine(s));

  const body: Record<string, unknown>[] = [
    { type: "TextBlock", text: header, weight: "Bolder", size: "Medium", wrap: true },
  ];
  for (const line of lines) {
    body.push({ type: "TextBlock", text: line, wrap: true, spacing: "Small" });
  }

  const card: Record<string, unknown> = {
    type: "AdaptiveCard",
    version: "1.5",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    body,
  };

  const plainText = [header, ...lines].join("\n").trim();
  return { card, plain: plainText || CARD_PLACEHOLDER };
}
