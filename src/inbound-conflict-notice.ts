/**
 * 「会话初始化冲突重试耗尽」的用户可见回执 + 独立告警打点。
 *
 * 背景:core 用乐观锁初始化 reply session(revision = 整条 entry 的 JSON),已知在受影响
 * 版本上 `skillsSnapshot` 字段会在 snapshot↔commit 之间被非确定性重算 → CAS 恒失配 →
 * 抛 `reply session initialization conflicted`(upstream openclaw#101848,已在 core 侧
 * 收窄 revision 到身份字段修复,进 2026.7.1-beta.2+;我们线上更低版本仍会撞)。
 *
 * `session-retry.ts` 的线性退避只能救「真瞬态」冲突;上述持久翻转加多少重试都救不了。当重试
 * 彻底耗尽时,历史行为是把入站 handler 的错误吞进 `enqueueInbound` 的通用 catch —— 用户端
 * 完全没反应、像离线(对齐 upstream openclaw#102400 描述的 silent-drop 缺口)。
 *
 * 本模块把「丢消息」变成「一条明确回执 + 一行可告警的独立日志」:回执是直接走 `sendMessage`
 * 的普通文本 POST(不经 core reply pipeline / session init,故不会再次触发同一冲突)。
 */
import { ChannelType, type BotMessage } from "./types.js";
import { sendMessage } from "./api-fetch.js";

/** 用户可见回执文案。保持简短、可操作(与 inbound.ts 的超时/异常回执同款语气)。 */
export const SESSION_CONFLICT_RECEIPT = "⚠️ 系统繁忙，本条消息暂时无法处理，请稍后重发。";

/**
 * 回执发送的兜底超时。若 core 与 Octo API 同时不健康,这条回执 POST 绝不能无限挂住
 * per-group 入站队列(否则又把「丢一条」放大成「卡死整群」)。
 */
export const RECEIPT_SEND_TIMEOUT_MS = 10_000;

/** 与 `sendMessage` 同签名的可注入发送函数(测试用)。 */
type SendFn = typeof sendMessage;

/**
 * 从原始入站消息解析回执目标。仅覆盖常规 group / 社区话题 / DM 三种,与 inbound.ts 非 obo-v2
 * 路径的 reply-target 解析一致(group → channel_id;DM → from_uid)。obo-v2 合成消息等边缘
 * 来源无法从原始 msg 稳妥定位,返回 null —— 那种情况只打点、不发回执。
 */
export function resolveConflictReceiptTarget(
  msg: BotMessage,
): { channelId: string; channelType: ChannelType } | null {
  const isGroup =
    typeof msg.channel_id === "string" &&
    msg.channel_id.length > 0 &&
    (msg.channel_type === ChannelType.Group ||
      msg.channel_type === ChannelType.CommunityTopic);

  if (isGroup) {
    return { channelId: msg.channel_id as string, channelType: msg.channel_type as ChannelType };
  }

  if (typeof msg.from_uid === "string" && msg.from_uid.length > 0) {
    return { channelId: msg.from_uid, channelType: ChannelType.DM };
  }

  return null;
}

/**
 * 重试耗尽仍撞 core 会话初始化冲突时调用:发一条用户可见回执,并打一行与通用
 * 「inbound handler failed」区分开的独立告警日志(便于按此串单独检索/告警)。
 *
 * 永不抛错 —— 它本身就是失败兜底,任何内部异常都只落日志,不得再向上冒泡。
 */
export async function notifyInboundConflictDropped(params: {
  err: unknown;
  msg: BotMessage;
  accountId: string;
  apiUrl?: string;
  botToken?: string;
  log?: { warn?: (msg: string) => void; error?: (msg: string) => void };
  /** 测试注入;缺省真实 `sendMessage`。 */
  send?: SendFn;
  /** 测试注入;缺省 {@link RECEIPT_SEND_TIMEOUT_MS}。 */
  timeoutMs?: number;
}): Promise<void> {
  const { err, msg, accountId, apiUrl, botToken, log } = params;
  const send = params.send ?? sendMessage;
  const timeoutMs = params.timeoutMs ?? RECEIPT_SEND_TIMEOUT_MS;
  const detail = err instanceof Error ? err.message : String(err);

  // 独立告警打点:与 enqueueInbound 的通用失败日志区分,方便按 "inbound DROPPED" 单独监控。
  log?.warn?.(
    `octo: [${accountId}] inbound DROPPED after session-init retries exhausted (core CAS conflict; ` +
      `upstream openclaw#101848) from=${msg.from_uid} channel=${msg.channel_id ?? "DM"} ` +
      `msg=${msg.message_id}: ${detail}`,
  );

  // 无凭据无法回执(理论上不会发生,防御式处理):已打点即可。
  if (!apiUrl || !botToken) return;

  const target = resolveConflictReceiptTarget(msg);
  if (!target) return;

  try {
    await send({
      apiUrl,
      botToken,
      channelId: target.channelId,
      channelType: target.channelType,
      content: SESSION_CONFLICT_RECEIPT,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (sendErr) {
    log?.error?.(`octo: [${accountId}] failed to send conflict receipt: ${String(sendErr)}`);
  }
}
