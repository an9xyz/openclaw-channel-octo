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
 * 明确前缀式凭据形状(AKIA/GitHub/Slack/OpenAI/JWT)。这些格式**在任何位置都几乎不可能
 * 是正常内容**,故对所有策略(含 path/shell)都应用 —— 关键词正则只认密钥名字,认不出这些形状。
 */
const SECRET_PREFIX_RES: RegExp[] = [
  /\bAKIA[0-9A-Z]{12,}\b/,                                  // AWS access key id
  /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/,           // GitHub token / fine-grained PAT
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,                         // Slack token
  /\bsk-[A-Za-z0-9_-]{16,}/,                                // OpenAI-style secret key
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/, // JWT
];

/** 长 hex(md5/sha/hex 密钥)。也命中 git object/docker digest 等常见路径,故仅用于 query/url。 */
const LONG_HEX_RE = /\b[0-9a-fA-F]{32,}\b/;

/**
 * 通用高熵串:32+ 位连续 base64url 段且**同时含字母与数字**(随机 token 特征)。会误伤
 * webpack 缓存名/UUID 目录等常见路径,故与长 hex 一样**仅用于 query/url**(裸 token 的场景),
 * 不套用到 path/shell。只按长度会误伤长英文(如 80 个 `x`),故要求字母数字混合。
 */
function hasGenericSecretShape(s: string): boolean {
  if (LONG_HEX_RE.test(s)) return true;
  const runs = s.match(/[A-Za-z0-9_-]{32,}/g);
  return !!runs && runs.some((r) => /[0-9]/.test(r) && /[A-Za-z]/.test(r));
}

/**
 * 是否命中敏感串。`generic` 为 true(query/url 策略)时额外套用长 hex/高熵检测;path/shell
 * 只走关键词 + 明确前缀,避免把 git SHA / docker digest / 缓存哈希等正常路径误伤成空。
 * 群卡片对全员可见,任一命中即隐藏。
 */
function isSensitive(s: string, generic: boolean): boolean {
  if (SECRET_RE.test(s)) return true;
  if (SECRET_PREFIX_RES.some((re) => re.test(s))) return true;
  return generic && hasGenericSecretShape(s);
}

/**
 * 常见多段有效后缀(eTLD),用于计算注册域时多保留一段。非穷举,只覆盖高频场景;
 * 未命中的按「末两段」处理即可(始终丢掉子域 → 不会泄露子域里的密钥)。
 */
const MULTI_PART_TLDS = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk",
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
  "com.au", "com.br", "com.hk", "com.tw", "com.sg", "co.jp", "co.kr",
]);

/**
 * 取注册域(丢掉所有子域):隧道/预签名场景**主机名本身就是密钥**(如 ngrok 随机子域、
 * 预签名 bucket 名),故只保留 eTLD+1。多段后缀(com.cn/co.uk 等)多保留一段。
 * 纯 IPv4 原样返回。
 */
function registrableDomain(host: string): string {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return host; // IPv4 原样
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const last2 = labels.slice(-2).join(".");
  const keep = MULTI_PART_TLDS.has(last2) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

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
 * URL → `scheme://注册域`。丢弃 path/query/userinfo **和所有子域**:凭据既可能在 query,
 * 也常整段嵌在 path 里(Slack/Discord webhook `/services/T../B../XXXX`),更有隧道/预签名
 * 场景**主机名本身即密钥**(ngrok 随机子域、预签名 bucket 名)—— 这些随机串不含关键词、躲过
 * SECRET_RE。故只暴露注册域(eTLD+1)。解析失败返回 null(原串可能含 token,调用方丢弃)。
 */
function originDomain(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    return `${u.protocol}//${registrableDomain(u.hostname)}`;
  } catch {
    return null;
  }
}

/** 把文本里内嵌的 http(s) URL 就地降级为 scheme://注册域(解析失败则整段抹除)。 */
function reduceUrlsInText(s: string): string {
  return s.replace(/\bhttps?:\/\/[^\s]+/gi, (m) => originDomain(m) ?? "");
}

/** url 策略:取 url 参数并降级为注册域。 */
function summarizeUrl(p: Record<string, unknown>): string {
  const raw = firstString(p, ["url"]);
  if (!raw) return "";
  return originDomain(raw) ?? "";
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
  let s = v.replace(/\s+/g, " ").trim();
  // 单一 choke point:所有策略统一把内嵌 URL 降级为 scheme://注册域。避免逐 sink 加降级时
  // 漏掉某个策略(query 的 pattern、shell 的 URL-as-program 都会原样渲染 webhook/userinfo/内网主机)。
  s = reduceUrlsInText(s).replace(/\s+/g, " ").trim();
  // query/url 是「裸 token」易出没处 → 额外套用通用高熵/长 hex 检测;path/shell 只走关键词
  // + 明确前缀,避免把 git SHA / docker digest / 缓存哈希等正常路径误伤成空。
  const generic = strategy === "query" || strategy === "url";
  if (!s || isSensitive(s, generic)) return "";
  return s.length > SUMMARY_MAX ? s.slice(0, SUMMARY_MAX) + "…" : s;
}

/** ms → 友好耗时(<1s 用 ms,否则 x.xs)。 */
export function fmtDuration(ms?: number): string {
  if (typeof ms !== "number") return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** 错误文本展示上限(比参数摘要略宽,但仍防多 KB 堆栈撑爆卡片)。 */
const ERROR_MAX = 120;

/**
 * 清洗工具错误文本后再渲染 —— 错误串是与参数摘要**同等**的泄露 sink:常含 stderr、
 * 失败命令输出、请求 URL/header、webhook 路径、token、文件片段,且长度不可控。清洗顺序:
 *   1. 折叠空白;
 *   2. **内嵌 URL 降级为 scheme://注册域**(与参数路径 summarizeUrl 对称)—— 否则 webhook
 *      路径/隧道主机等短、无关键词的密钥会绕过下面的 isSensitive 直接泄露;
 *   3. 关键词/明确前缀命中则整串隐藏(generic=false:**不**套用长 hex/高熵,否则会把含 git SHA/
 *      docker digest/UUID 的普通运维错误整条吞掉 —— webhook 类已由步骤 2 兜住);
 *   4. 截断到 ERROR_MAX。
 */
export function sanitizeErrorText(err?: string): string {
  if (!err) return "";
  let s = err.replace(/\s+/g, " ").trim();
  if (!s) return "";
  s = reduceUrlsInText(s).replace(/\s+/g, " ").trim(); // URL 降级可能留下空隙
  if (!s || isSensitive(s, false)) return ""; // 关键词/明确前缀命中 → 不展示错误详情
  return s.length > ERROR_MAX ? s.slice(0, ERROR_MAX) + "…" : s;
}

/** 单步 → 一行文案:图标 + 标签 + 参数摘要 + 状态/耗时。错误详情经脱敏+截断。 */
export function stepLine(step: CardStep): string {
  const { icon, label } = resolveToolMeta(step.tool);
  const sum = step.summary ? `：${step.summary}` : "";
  if (step.status === "running") return `⏳ ${label}${sum}`;
  if (step.status === "error") {
    const detail = sanitizeErrorText(step.error);
    return `❌ ${label}${sum}${detail ? ` — ${detail}` : ""}`;
  }
  const dur = fmtDuration(step.durationMs);
  return `${icon} ${label}${sum}${dur ? ` · ${dur}` : ""}`;
}

function headerText(state: CardProgressState): string {
  switch (state.phase) {
    case "thinking":
      return "🤖 思考中…";
    case "tool":
      return "🤖 正在处理…";
    case "error": {
      const detail = sanitizeErrorText(state.errorText);
      return `⚠️ 已中断${detail ? `：${detail}` : ""}`;
    }
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
