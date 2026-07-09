/**
 * 波 B —— InteractiveCard(=17) 进度卡状态机 + hook 驱动 + 节流。
 *
 * 架构(见 .context 计划):
 *   - dispatch(`inbound.ts`)在 run 开始 `setCardContext(sessionKey, ctx)` 存发送上下文
 *     (apiUrl/botToken/channel/onBehalfOf),`finally` 里 `finalizeCard(sessionKey, success)`。
 *   - 本模块订阅 hook(before/after_tool_call、model_call_started),用 `ctx.sessionKey`
 *     查 Map:首个工具事件懒发占位卡 → 后续就地 `editCardMessage`,节流合帧。
 *   - `sessionKey` 桥接 dispatch 与 hook(H1 实证一致)。Map 只含 octo dispatch 登记的
 *     session → hook 查不到即 return,**天然过滤**非 octo run,无需 messageProvider 判断。
 *
 * 决策:关联键 sessionKey;单写者(dispatch per-group 串行)→ 不传 card_seq;卡仅进度/
 * 状态(C2,答案走文本);OBO(persona-clone)场景跳过(服务端拒 type-17 OBO,Decision 2b)。
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { ChannelType, CARD_PROFILE, CARD_VERSION } from "./types.js";
import { sendCardMessage, editCardMessage, getCardProfile, httpStatusFromApiFetchError, type CardProfileManifest } from "./api-fetch.js";
import { renderProgressCard, summarizeToolParams, type CardStep, type CardProgressState, type CardCaps } from "./card-render.js";

/** dispatch 侧登记的发送上下文。 */
export interface CardContext {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  /** persona-clone 身份;存在则跳过卡片(服务端拒 type-17 OBO)。 */
  onBehalfOf?: string;
}

interface CardEntry {
  ctx: CardContext;
  /**
   * 发送目标身份指纹 = `apiUrl\0channelId\0onBehalfOf`。hook ctx 只带 sessionKey、
   * 不带 accountId,无法区分账号;仓库已文档化两个 bot 账号可能共享同一 sessionKey
   * (见 inbound.ts 的 sessionAccountMap 复合键)。setCardContext 用它检测跨身份碰撞,
   * 命中则 fail closed,避免把进度卡发到错误频道。
   */
  identity: string;
  messageId?: string;
  phase: CardProgressState["phase"];
  steps: CardStep[];
  startedAt: number;
  dirty: boolean;
  inFlight: boolean;
  skip: boolean;
  flushTimer?: ReturnType<typeof setTimeout>;
  /** 当前 in-flight flush 的 promise;finalizeCard 据此等待首帧 send/中间帧 edit 落定。 */
  flushPromise?: Promise<void>;
}

/** key = sessionKey(H1 实证:全 hook 一致)。跨账号碰撞由 entry.identity + fail-closed 兜底。 */
const cards = new Map<string, CardEntry>();

/** D12 gate 结果缓存,key = apiUrl(同部署同结果),避免每 session 重复探测。 */
const gateCache = new Map<string, boolean>();

/**
 * D12 能力(elements/limits 派生的渲染 caps)缓存,key = apiUrl(部署级,同 gate)。gateEnabled
 * 探测 manifest 时一并填充;渲染时按此按元素/节点上限裁剪。旧部署无这些字段 → caps 为空 → 渲染
 * 走保守默认(等同今天行为)。
 */
const capsCache = new Map<string, CardCaps>();

/** manifest → 渲染 caps。只取当前渲染用得上的:元素白名单 + max_nodes(其余 limits 结构浅、天然满足)。 */
function deriveCaps(m: CardProfileManifest): CardCaps {
  const caps: CardCaps = {};
  if (Array.isArray(m.elements) && m.elements.length > 0) caps.elements = new Set(m.elements);
  const maxNodes = m.limits?.max_nodes;
  if (typeof maxNodes === "number" && maxNodes > 0) caps.maxNodes = maxNodes;
  return caps;
}

const FLUSH_DEBOUNCE_MS = 800;
const EDIT_TIMEOUT_MS = 10_000;

// 进度卡失败不影响主回复流程 —— 仅告警,不抛。
// eslint-disable-next-line no-console -- 波 B 进度卡诊断,失败降级不阻断主流程
const warn = (msg: string): void => console.warn(`[octo:card-progress] ${msg}`);
// eslint-disable-next-line no-console -- env-gated 端到端联调观测(OCTO_CARD_DEBUG),默认关
const dbg: (msg: string) => void = process.env.OCTO_CARD_DEBUG
  ? (msg) => console.log(`[octo:card-progress] ${msg}`)
  : () => {};

/**
 * 发送目标身份指纹。含 botToken —— 它才是账号的真正区分符:两个不同的非 OBO 账号即便
 * 同 apiUrl+同 channelId(都在同一群回复)也应视为不同身份、触发 fail-closed。仅在内存里
 * 做等值比较,不落日志。
 */
function contextIdentity(ctx: CardContext): string {
  return JSON.stringify([ctx.apiUrl, ctx.channelId, ctx.onBehalfOf ?? "", ctx.botToken]);
}

/**
 * dispatch run 开始时登记发送上下文。onBehalfOf 存在 → 标记跳过。
 *
 * 跨账号 fail-closed:若同 sessionKey 上已有**不同身份**的活跃 entry(两个 bot 账号
 * 共享了 sessionKey),hook 侧无法凭 sessionKey 区分账号,两边都置 skip —— 宁可都不发,
 * 也绝不把进度卡 send/edit 到错误频道。persona-clone/OBO 本就 skip,此处再兜住
 * non-OBO 跨账号碰撞,以及「OBO 克隆覆盖冻结同 key 上普通 bot 卡」的情形。
 */
export function setCardContext(sessionKey: string, ctx: CardContext): void {
  if (!sessionKey) return;
  const identity = contextIdentity(ctx);
  const existing = cards.get(sessionKey);
  const collision = !!existing && existing.identity !== identity;
  if (collision) {
    existing!.skip = true; // 冻结旧 run 的卡:后续 flush/finalize 不再发送
    if (existing!.flushTimer) {
      clearTimeout(existing!.flushTimer);
      existing!.flushTimer = undefined;
    }
    warn(`sessionKey collision across identities; failing closed for session=${sessionKey}`);
  }
  cards.set(sessionKey, {
    ctx,
    identity,
    phase: "thinking",
    steps: [],
    startedAt: Date.now(),
    dirty: false,
    inFlight: false,
    skip: collision || !!ctx.onBehalfOf,
  });
  dbg(`context set session=${sessionKey} channel=${ctx.channelId} obo=${!!ctx.onBehalfOf} collision=${collision}`);
}

/**
 * 是否允许发卡:D12 manifest 优先,端点未部署(available:false)则回退 env 开关。
 * 返回值三态:`true`=启用,`false`=**明确禁用**(可永久 skip 本 session),
 * `null`=**瞬时探测失败**(5xx/网络,不缓存、不 skip,下次 flush 重探)。
 */
async function gateEnabled(ctx: CardContext): Promise<boolean | null> {
  const cached = gateCache.get(ctx.apiUrl);
  if (cached !== undefined) return cached;
  try {
    const m = await getCardProfile({ apiUrl: ctx.apiUrl, botToken: ctx.botToken });
    // 能力清单是部署级事实(与 enabled 无关),探到就缓存供渲染裁剪。
    capsCache.set(ctx.apiUrl, deriveCaps(m));
    let enabled = m.available ? m.enabled : process.env.OCTO_CARD_MESSAGE_ENABLED === "1";
    // 版本协商:manifest **明确 advertise** 了 profiles/card_version 却不含我们出站发送的
    // octo/v1 + 1.5 时,判定不兼容 → 关闭,避免协议演进后 send/edit 撞 400(字段缺省则不设限,
    // 与当前 server 行为一致)。
    if (enabled && m.available) {
      if (Array.isArray(m.profiles) && m.profiles.length > 0 && !m.profiles.includes(CARD_PROFILE)) {
        dbg(`gate: profile ${CARD_PROFILE} not advertised (${m.profiles.join(",")}) → disabled`);
        enabled = false;
      } else if (typeof m.card_version === "string" && m.card_version !== CARD_VERSION) {
        dbg(`gate: card_version ${m.card_version} != ${CARD_VERSION} → disabled`);
        enabled = false;
      }
    }
    // 只缓存**确定结果**(manifest 明确 enabled/disabled/不兼容,或 available:false 回退 env)。
    gateCache.set(ctx.apiUrl, enabled);
    return enabled;
  } catch (err: unknown) {
    // 瞬时失败(5xx/网络抖动)不缓存、不 skip —— 否则一次抖动会让该 apiUrl(缓存)或
    // 该 session(skip)的卡片进度永久关闭。返回 null,下次 flush(仍在 !messageId 期间)重探。
    warn(`card gate probe failed (not caching): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function scheduleFlush(sessionKey: string, entry: CardEntry): void {
  entry.dirty = true;
  if (entry.flushTimer) return;
  entry.flushTimer = setTimeout(() => {
    entry.flushTimer = undefined;
    void flush(sessionKey);
  }, FLUSH_DEBOUNCE_MS);
}

async function flush(sessionKey: string): Promise<void> {
  const entry = cards.get(sessionKey);
  if (!entry || entry.skip) return;
  // 已有 flush 在执行 → 直接返回。不在这里补排:执行中的那次会在 finally 里按 dirty 重排,
  // 且**不**覆盖 entry.flushPromise(否则 finalizeCard await 到的会是这次空转、而非真实 send)。
  if (entry.inFlight) return;
  if (!entry.dirty) return;

  // 置 inFlight 于任何 await **之前**:gate 探测/send 往返期间挡住并发 flush,否则首帧未落
  // messageId 前的 gate await 窗口里,新定时器可穿过检查并发起第二次 send(重复发卡)。
  entry.inFlight = true;
  const work = runFlush(sessionKey, entry);
  entry.flushPromise = work;
  try {
    await work;
  } finally {
    if (entry.flushPromise === work) entry.flushPromise = undefined;
  }
}

/** 实际执行 gate + send/edit。调用方已置 inFlight=true 并接管 flushPromise。 */
async function runFlush(sessionKey: string, entry: CardEntry): Promise<void> {
  try {
    // 首帧前做一次 D12 gate。明确禁用 → 永久跳过本 session;瞬时失败 → 本轮不发,
    // 下次 flush(下个工具事件触发)重探,避免一次抖动永久关闭本 session。
    if (!entry.messageId) {
      const gate = await gateEnabled(entry.ctx);
      if (gate === false) {
        entry.skip = true;
        return;
      }
      if (gate === null) {
        // 瞬时探测失败:清 dirty 且不自动重排,避免端点故障期每 ~800ms 一次探测风暴。
        // 累积的 steps 仍在 entry 上,下个工具事件会重新 scheduleFlush 并重探。
        entry.dirty = false;
        return;
      }
    }

    entry.dirty = false;
    const { card, plain } = renderProgressCard({ phase: entry.phase, steps: entry.steps }, capsCache.get(entry.ctx.apiUrl));
    const signal = AbortSignal.timeout(EDIT_TIMEOUT_MS);
    if (!entry.messageId) {
      const res = await sendCardMessage({
        apiUrl: entry.ctx.apiUrl,
        botToken: entry.ctx.botToken,
        channelId: entry.ctx.channelId,
        channelType: entry.ctx.channelType,
        card,
        plain,
        ...(entry.ctx.onBehalfOf ? { onBehalfOf: entry.ctx.onBehalfOf } : {}),
        signal,
      });
      entry.messageId = res?.message_id;
      if (!entry.messageId) {
        warn("placeholder card send returned no message_id; disabling for session");
        entry.skip = true;
        return;
      }
      dbg(`placeholder sent messageId=${entry.messageId} steps=${entry.steps.length}`);
    } else {
      await editCardMessage({
        apiUrl: entry.ctx.apiUrl,
        botToken: entry.ctx.botToken,
        messageId: entry.messageId,
        channelId: entry.ctx.channelId,
        channelType: entry.ctx.channelType,
        card,
        plain,
        transient: true, // 进度中间帧不进修订历史(D10);终态帧由 finalizeCard 不带 transient
        ...(entry.ctx.onBehalfOf ? { onBehalfOf: entry.ctx.onBehalfOf } : {}),
        signal,
      });
      dbg(`edited steps=${entry.steps.length} phase=${entry.phase}`);
    }
  } catch (err: unknown) {
    warn(`flush failed: ${err instanceof Error ? err.message : String(err)}`);
    // 确定性拒绝(4xx,除可重试的 429)→ fail-closed,别对着必然失败的 server 逐事件重试。
    // 5xx / 网络 / 429 保持可重试(与 gate 的瞬时失败处理一致)。
    const status = httpStatusFromApiFetchError(err);
    if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
      entry.skip = true;
    }
  } finally {
    entry.inFlight = false;
    // 期间有新帧 → 再刷。entry 已被 finalize/clear 删除时不再重排,避免悬挂定时器。
    if (entry.dirty && !entry.skip && cards.get(sessionKey) === entry) scheduleFlush(sessionKey, entry);
  }
}

/**
 * dispatch `finally` 收尾:渲染终态帧(✅ 已完成 / ⚠️ 中断),清理 Map。
 * 幂等:未登记或没发过占位卡则仅清理。
 */
export async function finalizeCard(
  sessionKey: string,
  opts: { success: boolean; errorText?: string } = { success: true },
): Promise<void> {
  const entry = cards.get(sessionKey);
  if (!entry) return;
  // 等待 in-flight flush 落定后再接管。否则:首帧 send 尚未 return 时 messageId 未就绪,
  // 直接删 entry 会跳过终态帧,占位卡「正在处理…」永久冻结;若有 in-flight 中间帧
  // (transient)edit,还可能后于终态帧落库、把「✅ 已完成」覆盖回「正在处理」。await 后
  // messageId 必已就绪、edit 顺序也串好。flush 内部已 catch+告警,这里吞掉即可。
  if (entry.flushPromise) {
    try { await entry.flushPromise; } catch { /* flush 内部已告警 */ }
  }
  if (entry.flushTimer) clearTimeout(entry.flushTimer);
  // 只在 entry 仍是当前登记项时删除。finalize 是 fire-and-forget 且上面 await 了 in-flight
  // flush;await 期间 per-group 队列可能推进,同 sessionKey 的下一 run setCardContext 已把
  // Map 换成新 entry —— 那时删 key 会误删新 run 的状态,使其全程无卡。终态帧仍发本 run。
  if (cards.get(sessionKey) === entry) cards.delete(sessionKey);

  // 从没发过卡(skip / 无工具调用)→ 无需收尾帧。
  if (entry.skip || !entry.messageId) return;

  const state: CardProgressState = {
    phase: opts.success ? "done" : "error",
    steps: entry.steps,
    elapsedMs: Date.now() - entry.startedAt,
    ...(opts.errorText ? { errorText: opts.errorText } : {}),
  };
  try {
    const { card, plain } = renderProgressCard(state, capsCache.get(entry.ctx.apiUrl));
    await editCardMessage({
      apiUrl: entry.ctx.apiUrl,
      botToken: entry.ctx.botToken,
      messageId: entry.messageId,
      channelId: entry.ctx.channelId,
      channelType: entry.ctx.channelType,
      card,
      plain,
      ...(entry.ctx.onBehalfOf ? { onBehalfOf: entry.ctx.onBehalfOf } : {}),
      signal: AbortSignal.timeout(EDIT_TIMEOUT_MS),
    });
    dbg(`finalized session=${sessionKey} phase=${state.phase} steps=${entry.steps.length}`);
  } catch (err: unknown) {
    warn(`finalize failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 硬清理(不发收尾帧),用于异常兜底。 */
export function clearCard(sessionKey: string): void {
  const entry = cards.get(sessionKey);
  if (!entry) return;
  if (entry.flushTimer) clearTimeout(entry.flushTimer);
  cards.delete(sessionKey);
}

/** 测试辅助:清空全部状态。 */
export function _resetCardProgressForTests(): void {
  for (const e of cards.values()) if (e.flushTimer) clearTimeout(e.flushTimer);
  cards.clear();
  gateCache.clear();
  capsCache.clear();
}

/**
 * 注册 hook。经 `index.ts` registerFull 调用(仅 full mode)。
 * hook 全局触发,但仅处理 Map 中已登记(octo dispatch)的 sessionKey。
 */
export function registerCardProgress(api: OpenClawPluginApi): void {
  api.on("before_tool_call", (event: unknown, ctx: unknown) => {
    const e = (event ?? {}) as { toolName?: string; params?: unknown; toolCallId?: string };
    const sk = (ctx as { sessionKey?: string })?.sessionKey;
    const entry = sk ? cards.get(sk) : undefined;
    if (!entry || entry.skip || !e.toolName) return;
    dbg(`before_tool_call tool=${e.toolName} session=${sk}`);
    entry.phase = "tool";
    entry.steps.push({
      tool: e.toolName,
      status: "running",
      summary: summarizeToolParams(e.toolName, e.params),
      ...(e.toolCallId ? { toolCallId: e.toolCallId } : {}),
    });
    scheduleFlush(sk!, entry);
  });

  api.on("after_tool_call", (event: unknown, ctx: unknown) => {
    const e = (event ?? {}) as { toolName?: string; error?: string; durationMs?: number; toolCallId?: string };
    const sk = (ctx as { sessionKey?: string })?.sessionKey;
    const entry = sk ? cards.get(sk) : undefined;
    if (!entry || entry.skip) return;
    // 回填终态。优先按 toolCallId 精确匹配 running 步骤;若 toolCallId 存在但没命中
    // running(过期/重复投递的 after 事件),直接丢弃,**不**回退按名匹配 —— 否则会把仍
    // 在跑的并发同名步骤误标为终态。仅当 toolCallId 缺失(旧 host)才回退「最后一个同名 running」。
    let target: CardStep | undefined;
    if (e.toolCallId) {
      target = entry.steps.find((s) => s.toolCallId === e.toolCallId && s.status === "running");
    } else {
      for (let i = entry.steps.length - 1; i >= 0; i--) {
        const s = entry.steps[i];
        if (s.tool === e.toolName && s.status === "running") { target = s; break; }
      }
    }
    if (target) {
      target.status = e.error ? "error" : "done";
      if (typeof e.durationMs === "number") target.durationMs = e.durationMs;
      if (e.error) target.error = e.error;
    }
    scheduleFlush(sk!, entry);
  });

  api.on("model_call_started", (_event: unknown, ctx: unknown) => {
    const sk = (ctx as { sessionKey?: string })?.sessionKey;
    const entry = sk ? cards.get(sk) : undefined;
    if (!entry || entry.skip) return;
    // 仅在还没有工具步骤时展示「思考中」,避免工具间的模型调用刷屏。
    if (entry.steps.length === 0 && entry.phase !== "thinking") {
      entry.phase = "thinking";
      scheduleFlush(sk!, entry);
    }
  });
}
