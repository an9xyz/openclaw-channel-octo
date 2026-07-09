/**
 * agent 展示卡工具 —— `octo_send_display_card`
 *
 * 让 agent 在一次 turn 内主动发一张**展示型** InteractiveCard(17)到当前会话:
 * 标题 + 富展示 block(TextBlock/RichTextBlock/FactSet/Container/collapsible …)。
 *
 * 与 P2 的 `octo_send_card`(带 Action.Submit 按钮、点击回流 card_action 触发新 turn)
 * 严格区分:本工具**顶层无 actions、不产生回流事件** —— agent 无需处理点击回调,
 * 结果类展示、通知、审批汇总、结构化答复的自然承载。
 *
 * 安全:
 *   - 入参 `blocks` 是 agent 可控输入,经 `validateDisplayBlocks` 白名单结构校验;
 *   - 内容再由 `buildDisplayCard` 逐 block 脱敏(URL 降级、命中 secret 抹除);
 *   - 出站前 D12 gate:manifest disabled / profile 不含 `octo/v1` / card_version 不兼容
 *     → 拒绝(fail-closed),避免服务端 400。
 *   - caps.elements 未 advertise 的元素自动降级,agent 无需自己判断白名单。
 *   - **身份不接受 agent 入参**:展示卡始终以 bot 自身身份发出,OBO(persona-clone)绝不由
 *     不可信模型输入指定(与进度卡路径一致,OBO 一律跳过),避免群可见卡片成为 persona 冒充 sink。
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { listOctoAccountIds, resolveOctoAccount } from "./accounts.js";
import { sendCardMessage, getCardProfile, type CardProfileManifest } from "./api-fetch.js";
import { buildDisplayCard, validateDisplayBlocks } from "./card-blocks.js";
import { resolveOutboundOctoTarget } from "./actions.js";
import type { CardCaps } from "./card-render.js";
import { ChannelType, CARD_PROFILE, CARD_VERSION } from "./types.js";
import { DISPLAY_CARD_TOOL_NAME } from "./constants.js";

/** 展示卡发送超时(postJson 无默认超时,防挂起的 POST 拖死 tool 调用)。 */
const SEND_TIMEOUT_MS = 15_000;

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: unknown; // SDK ErasedAgentToolExecute requires this key present(可为 null)
}

function ok(msg: string, details?: unknown): ToolResult {
  return { content: [{ type: "text", text: msg }], details: details ?? null };
}

function err(msg: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${msg}` }], details: null };
}

/** manifest → CardCaps(限于本工具消费:elements + maxNodes)。 */
function deriveCaps(m: CardProfileManifest): CardCaps {
  return {
    ...(m.elements ? { elements: new Set(m.elements) } : {}),
    ...(m.inputs ? { inputs: new Set(m.inputs) } : {}),
    ...(m.actions ? { actions: new Set(m.actions) } : {}),
    ...(m.limits && typeof (m.limits as Record<string, unknown>).max_nodes === "number"
      ? { maxNodes: (m.limits as Record<string, unknown>).max_nodes as number }
      : {}),
  };
}

/**
 * gate 校验:manifest 明确 disabled / profile 不含 octo/v1 / card_version 不匹配 → 拒绝。
 * `available:false`(端点未部署)时回退 env `OCTO_CARD_MESSAGE_ENABLED === "1"` —— 与 hook
 * 进度卡的 gate 语义对齐,单一权威。
 */
function gateReason(m: CardProfileManifest): string | null {
  if (!m.available) {
    return process.env.OCTO_CARD_MESSAGE_ENABLED === "1"
      ? null
      : "card manifest endpoint not available and OCTO_CARD_MESSAGE_ENABLED is not set";
  }
  if (!m.enabled) return "card sending is disabled on this deployment (manifest.enabled=false)";
  if (Array.isArray(m.profiles) && m.profiles.length > 0 && !m.profiles.includes(CARD_PROFILE)) {
    return `profile ${CARD_PROFILE} not advertised by server (got: ${m.profiles.join(",")})`;
  }
  if (typeof m.card_version === "string" && m.card_version !== CARD_VERSION) {
    return `card_version ${m.card_version} not compatible (need ${CARD_VERSION})`;
  }
  return null;
}

interface Params {
  cfg?: OpenClawConfig;
  agentAccountId?: string;
  agentId?: string;
}

/**
 * 创建 agent 展示卡工具。无 configured account → 返回空数组(tool-discovery 阶段安全)。
 */
export function createDisplayCardTool(params: Params): Array<{
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (toolCallId: string, args: Record<string, unknown>) => Promise<ToolResult>;
}> {
  const { cfg, agentAccountId } = params;
  if (!cfg) return [];
  try {
    const ids = listOctoAccountIds(cfg);
    const hasConfigured = ids.some((id) => {
      const acct = resolveOctoAccount({ cfg, accountId: id });
      return acct.enabled && acct.configured && !!acct.config.botToken;
    });
    if (!hasConfigured) return [];
  } catch {
    return [];
  }

  const tool = {
    name: DISPLAY_CARD_TOOL_NAME,
    label: "Octo Send Display Card",
    description:
      "Send a DISPLAY card (Adaptive Card 1.5) to an Octo conversation. Use this for rich, " +
      "structured, NON-INTERACTIVE output — status reports, structured answers, key-value " +
      "summaries, collapsible detail sections. The card does NOT have clickable " +
      "action buttons and will NOT trigger any callback event; if you need clickable buttons " +
      "that call back to you, do not use this tool. " +
      "Provide `blocks`, an ordered list of typed display blocks (heading / text / rich / " +
      "facts / group / collapsible); the server's advertised element set is negotiated " +
      "automatically and unsupported types degrade to plain text — you never need to check " +
      "compatibility yourself. " +
      "For visual emphasis, wrap key sections in a `group` block with `style: 'good' | " +
      "'warning' | 'attention'` (tinted background — the client renders them as green / " +
      "amber / pink zones); highlight important tokens with `rich` segment colors instead " +
      "of recoloring whole lines. Prefer ONE heading + at most 2-3 tinted groups + a " +
      "closing `rich` summary line. See SKILL.md \"Visual styling recipes\" for full " +
      "examples. " +
      "Content is fully visible to all group members: never put secrets or tokens into any " +
      "field.",
    parameters: {
      type: "object",
      properties: {
        channelId: {
          type: "string",
          description:
            "Target channel (REQUIRED): 'group:<groupId>', 'user:<uid>', or an existing channelId. " +
            "Use the channel_id from the event you are replying to.",
        },
        threadId: {
          type: "string",
          description: "Optional thread short_id when targeting a group topic.",
        },
        title: {
          type: "string",
          description: "Optional bold title rendered at the top of the card.",
        },
        blocks: {
          type: "array",
          description:
            "Ordered list of DisplayBlock. Each block is one of: " +
            "{type:'heading', text, size?:'medium'|'large'} · " +
            "{type:'text', text} · " +
            "{type:'rich', segments:[{text, bold?, color?:'good'|'warning'|'attention'|'accent'}]} · " +
            "{type:'facts', items:[{label, value}]} · " +
            "{type:'group', style?:'good'|'warning'|'attention', blocks:[…]} · " +
            "{type:'collapsible', summary, blocks:[…]}. " +
            "Unknown block types or missing fields are silently dropped.",
          items: { type: "object" },
        },
      },
      required: ["blocks", "channelId"],
    },
    execute: async (
      _toolCallId: string,
      args: Record<string, unknown>,
    ): Promise<ToolResult> => {
      try {
        const validated = validateDisplayBlocks(args.blocks);
        const rawTitle = typeof args.title === "string" ? args.title : "";

        // Account 解析 —— 复用 octo_management 的选择路径:agentAccountId 优先,单账号回退。
        const requestedAccountId = agentAccountId
          ?? (listOctoAccountIds(cfg).length === 1 ? listOctoAccountIds(cfg)[0] : undefined);
        if (!requestedAccountId) return err("no configured Octo account available");
        const acct = resolveOctoAccount({ cfg, accountId: requestedAccountId });
        if (!acct.enabled || !acct.configured || !acct.config.botToken) {
          return err("Octo account is not fully configured");
        }
        const apiUrl = acct.config.apiUrl;
        const botToken = acct.config.botToken;
        if (!apiUrl) return err("apiUrl not configured");

        // D12 能力探测(gate + caps)。
        let manifest: CardProfileManifest;
        try {
          manifest = await getCardProfile({ apiUrl, botToken });
        } catch (e) {
          return err(`card profile probe failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        const rejection = gateReason(manifest);
        if (rejection) return err(`${rejection}. Send your reply as a plain text message instead.`);

        // 构建 + 协商降级 + 脱敏 —— buildDisplayCard 单点权威。
        const { card, plain } = buildDisplayCard({
          title: rawTitle,
          blocks: validated,
          caps: deriveCaps(manifest),
        });
        // body 空 = 校验后无合法 block 且无有效 title → 空卡无意义。
        const body = (card.body as unknown[]) ?? [];
        if (body.length === 0) return err("card is empty (no valid blocks after validation)");

        // 解析目标 channel。channelId 缺省时 agent 依赖 runtime 注入(此工具签名保留 channelId,
        // 让 agent 显式给出;默认路由到当前会话由 channel.ts 侧的 outbound 完成,不在此层猜)。
        const rawChannelId = typeof args.channelId === "string" ? args.channelId : "";
        if (!rawChannelId.trim()) return err("channelId is required (use 'group:<id>' or 'user:<uid>')");
        const rawThread = typeof args.threadId === "string" ? args.threadId : undefined;
        const target = resolveOutboundOctoTarget(rawChannelId, rawThread);

        // 身份**不**接受 agent 入参:OBO(persona-clone)是可信运行时/服务端授权语义,绝不能由不可信的
        // 模型输入指定,否则群可见卡片就成了 persona 冒充的 sink。与进度卡路径一致(OBO 一律跳过);
        // 展示卡始终以 bot 自身身份发出。若日后需要 persona 展示卡,应从 inbound 的可信 effectiveOnBehalfOf
        // 注入,而非工具参数,且需服务端确实支持 OBO + type-17。
        const result = await sendCardMessage({
          apiUrl,
          botToken,
          channelId: target.channelId,
          channelType: target.channelType as ChannelType,
          card,
          plain,
          // postJson 无默认超时 —— 显式设超时,避免挂起的 POST 无限期占住这次 tool 调用。
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });

        const messageId = result?.message_id ?? "";
        return ok(
          `sent display card message_id=${messageId} channel=${target.channelId} elements=${body.length}`,
          { message_id: messageId, channel_id: target.channelId },
        );
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  };

  return [tool];
}
