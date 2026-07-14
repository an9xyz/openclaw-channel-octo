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
import { sendCardMessage, editCardMessage, getCardProfile, httpStatusFromApiFetchError } from "./api-fetch.js";
import { deriveCardCaps } from "./card-caps.js";
import { renderProgressCard, summarizeToolParams, type CardStep, type CardProgressState, type CardCaps } from "./card-render.js";
import { DISPLAY_CARD_TOOL_NAME } from "./constants.js";

/** dispatch 侧登记的发送上下文。 */
export interface CardContext {
  apiUrl: string;
  botToken: string;
  channelId: string;
  channelType: ChannelType;
  /** false force-disables automatic progress cards for this account/session. */
  cardProgress?: boolean;
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
  /**
   * 属主 run 的 SDK runId。由 before_agent_run 在任何 model/tool 事件前预绑定;普通 hook
   * 只能校验、不能认领,避免旧 run 的迟到 hook first-hook-wins 抢占新 entry。
   */
  runId?: string;
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
  /** replacement/clear 时主动取消 profile/send/edit,缩小 stale side-effect 窗口。 */
  flushAbort?: AbortController;
}

/** key = sessionKey(H1 实证:全 hook 一致)。跨账号碰撞由 entry.identity + fail-closed 兜底。 */
const cards = new Map<string, CardEntry>();

/** D12 gate 结果缓存,key = apiUrl(同部署同结果),避免每 session 重复探测。 */
const gateCache = new Map<string, boolean>();

/**
 * D12 能力(elements/limits 派生的渲染 caps)缓存,key = apiUrl(部署级,同 gate)。gateEnabled
 * 探测 manifest 时一并填充;渲染时按元素以及节点/深度/字节上限裁剪。旧部署无这些字段 → caps 为空 → 渲染
 * 走保守默认(等同今天行为)。
 */
const capsCache = new Map<string, CardCaps>();

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
  return JSON.stringify([ctx.apiUrl, ctx.channelId, ctx.channelType, ctx.onBehalfOf ?? "", ctx.botToken]);
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
  // 任何 replacement 都清掉旧 entry 的 debounce timer。旧 entry 若已有 messageId,其
  // fire-and-forget finalize 仍可收尾;但定时中间帧不得跨 generation 泄漏到新 run。
  if (existing?.flushTimer) {
    clearTimeout(existing.flushTimer);
    existing.flushTimer = undefined;
  }
  existing?.flushAbort?.abort(new Error("card entry replaced"));
  if (collision) {
    existing!.skip = true; // 冻结旧 run 的卡:后续 flush/finalize 不再发送
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
    // Account config is a per-session narrowing decision. Keep it out of the
    // apiUrl-keyed gate/caps caches, which contain deployment capability facts
    // shared by multiple accounts.
    skip: collision || !!ctx.onBehalfOf || ctx.cardProgress === false,
  });
  dbg(`context set session=${sessionKey} channel=${ctx.channelId} obo=${!!ctx.onBehalfOf} collision=${collision}`);
}

/**
 * 是否允许发卡:D12 manifest 优先,端点未部署(available:false)则回退 env 开关。
 * 返回值三态:`true`=启用,`false`=**明确禁用**(可永久 skip 本 session),
 * `null`=**瞬时探测失败**(5xx/网络,不缓存、不 skip,下次 flush 重探)。
 */
async function gateEnabled(ctx: CardContext, signal?: AbortSignal): Promise<boolean | null> {
  const cached = gateCache.get(ctx.apiUrl);
  if (cached !== undefined) return cached;
  try {
    const m = await getCardProfile({ apiUrl: ctx.apiUrl, botToken: ctx.botToken, signal });
    // 能力清单是部署级事实(与 enabled 无关),探到就缓存供渲染裁剪。
    capsCache.set(ctx.apiUrl, deriveCardCaps(m));
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
      } else if (Array.isArray(m.elements) && !m.elements.includes("TextBlock")) {
        // 所有安全降级最终都依赖 TextBlock。显式空数组或缺 TextBlock 是权威不支持,
        // 不能退回旧部署 baseline,否则会稳定撞 server 400。
        dbg("gate: TextBlock not advertised → disabled");
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
  const abort = new AbortController();
  entry.flushAbort = abort;
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(EDIT_TIMEOUT_MS)]);
  try {
    // 首帧前做一次 D12 gate。明确禁用 → 永久跳过本 session;瞬时失败 → 本轮不发,
    // 下次 flush(下个工具事件触发)重探,避免一次抖动永久关闭本 session。
    if (!entry.messageId) {
      const gate = await gateEnabled(entry.ctx, signal);
      // gate await 期间 entry 可能已被同 sessionKey 的下一 run 或跨身份上下文替换。
      // Map 对象身份就是 generation fence;stale entry 绝不能继续网络副作用。
      if (!isCurrentEntry(sessionKey, entry)) return;
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
    if (!Array.isArray(card.body) || card.body.length === 0) {
      warn("rendered card cannot fit negotiated capabilities/limits; disabling for session");
      entry.skip = true;
      return;
    }
    if (!entry.messageId) {
      if (!isCurrentEntry(sessionKey, entry)) return;
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
      if (!isCurrentEntry(sessionKey, entry)) return;
      if (!entry.messageId) {
        warn("placeholder card send returned no message_id; disabling for session");
        entry.skip = true;
        return;
      }
      dbg(`placeholder sent messageId=${entry.messageId} steps=${entry.steps.length}`);
    } else {
      if (!isCurrentEntry(sessionKey, entry)) return;
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
      if (!isCurrentEntry(sessionKey, entry)) return;
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
    if (entry.flushAbort === abort) entry.flushAbort = undefined;
    entry.inFlight = false;
    // 期间有新帧 → 再刷。entry 已被 finalize/clear 删除时不再重排,避免悬挂定时器。
    if (entry.dirty && !entry.skip && cards.get(sessionKey) === entry) scheduleFlush(sessionKey, entry);
  }
}

/** entry 是否仍是该 session 的当前 generation 且允许副作用。 */
function isCurrentEntry(sessionKey: string, entry: CardEntry): boolean {
  return cards.get(sessionKey) === entry && !entry.skip;
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
  // P1-g:若仍有 running thinking(agent 收尾时最后一次 model_call 之后未再调工具),
  // 用当前时间把它标 done + 算 duration —— 终态帧不留 ⏳。
  endRunningThinking(entry, Date.now());
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
    if (!Array.isArray(card.body) || card.body.length === 0) {
      warn("terminal card cannot fit negotiated capabilities/limits; leaving last valid frame");
      return;
    }
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
  entry.flushAbort?.abort(new Error("card entry cleared"));
  cards.delete(sessionKey);
}

/** 测试辅助:清空全部状态。 */
export function _resetCardProgressForTests(): void {
  for (const e of cards.values()) {
    if (e.flushTimer) clearTimeout(e.flushTimer);
    e.flushAbort?.abort(new Error("card progress reset"));
  }
  cards.clear();
  gateCache.clear();
  capsCache.clear();
}

/**
 * 注册 hook。经 `index.ts` registerFull 调用(仅 full mode)。
 * hook 全局触发,但仅处理 Map 中已登记(octo dispatch)的 sessionKey。
 */
/**
 * 关闭最后一步 running 的 thinking(若存在),用 now 算 durationMs。P1-g:SDK 无
 * model_call_ended,thinking 结束时机由外部信号(before_tool_call / finalize)驱动。
 */
function endRunningThinking(entry: CardEntry, now: number): void {
  const last = entry.steps[entry.steps.length - 1];
  if (!last || last.tool !== "__thinking__" || last.status !== "running") return;
  last.status = "done";
  if (typeof last.startedAt === "number") last.durationMs = Math.max(0, now - last.startedAt);
}

/**
 * runId 归属守卫。before_agent_run 是唯一绑定点;普通 hook 永不认领 entry。
 * 旧 host 完全不提供 runId 时保留 sessionKey-only 兼容;一旦 entry 已绑定 runId,
 * 缺失或不匹配 runId 的 hook 均 fail closed。
 */
function claimRun(entry: CardEntry, ctx: unknown): boolean {
  const rid = (ctx as { runId?: string })?.runId;
  if (!rid) return entry.runId === undefined;
  if (entry.runId === undefined) return false;
  return entry.runId === rid;
}

/**
 * 从可信 agent 生命周期 hook 预绑定 run owner。before_prompt_build 与 before_agent_run
 * 都早于 model/tool 事件;重复绑定相同 runId 幂等,不同 runId 不能覆盖已有 owner。
 */
export function bindCardRun(sessionKey: string | undefined, runId: string | undefined): void {
  if (!sessionKey || !runId) return;
  const entry = cards.get(sessionKey);
  if (!entry || entry.skip) return;
  if (entry.runId === undefined) entry.runId = runId;
}

export function registerCardProgress(api: OpenClawPluginApi): void {
  api.on("before_agent_run", (_event: unknown, ctx: unknown) => {
    const { sessionKey, runId } = (ctx ?? {}) as { sessionKey?: string; runId?: string };
    bindCardRun(sessionKey, runId);
    // before_agent_run 是 fail-closed gate。必须显式 pass,不能依赖不同 host 对 void 的解释。
    return { outcome: "pass" } as const;
  });

  api.on("before_tool_call", (event: unknown, ctx: unknown) => {
    const e = (event ?? {}) as { toolName?: string; params?: unknown; toolCallId?: string };
    const sk = (ctx as { sessionKey?: string })?.sessionKey;
    const entry = sk ? cards.get(sk) : undefined;
    if (!entry || entry.skip || !e.toolName) return;
    if (!claimRun(entry, ctx)) return; // 超时 run 的迟到 hook 落到新 run 的卡 → 丢弃
    // P1-h:agent 展示卡工具的产出**就是那张卡本身**,不该再有旁边的"正在处理/已中断"进度卡噪音。
    // 该工具不计入进度、不触发发卡。混合 turn 里其它真实工具照常显示,仅不含这步。
    if (e.toolName === DISPLAY_CARD_TOOL_NAME) {
      // 仍要收尾上一轮 running thinking —— 否则思考步 duration 会把 display-card 的执行时长吞进去。
      endRunningThinking(entry, Date.now());
      return;
    }
    dbg(`before_tool_call tool=${e.toolName} session=${sk}`);
    endRunningThinking(entry, Date.now()); // P1-g:上一轮 thinking 收尾
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
    if (!claimRun(entry, ctx)) return; // 同 §before_tool_call:外来 run 的迟到 after 事件 → 丢弃
    // P1-h:与 before_tool_call 对称,避免 display-card 触发 scheduleFlush 而误发进度卡。
    if (e.toolName === DISPLAY_CARD_TOOL_NAME) return;
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
    if (!claimRun(entry, ctx)) return; // 外来 run 的迟到 model_call → 丢弃
    // P1-g:每次 model_call 产一步"思考"。若上一步就是 running thinking(model_call_started
    // 被连续投递),忽略(去重)。
    const last = entry.steps[entry.steps.length - 1];
    if (last && last.tool === "__thinking__" && last.status === "running") return;
    // 首段思考(尚无真实工具步)→ header 显示"🤖 思考中…";真实工具跑过后保持"正在处理…"。
    const hadRealStep = entry.steps.some((s) => s.tool !== "__thinking__");
    if (!hadRealStep) entry.phase = "thinking";
    entry.steps.push({ tool: "__thinking__", status: "running", startedAt: Date.now() });
    // 懒发契约(模块头:"首个工具事件懒发占位卡"):**纯思考不发首帧卡**。仅当卡已存在(messageId)
    // 或已有真实工具步时才刷新 —— 否则纯文本 / 纯 display-card turn 的思考步会误发一张占位卡,
    // 并在收尾时 finalize 成误导性的"⚠️ 已中断",正是 P1-h 想消除的噪音。
    if (entry.messageId || hadRealStep) scheduleFlush(sk!, entry);
  });
}
