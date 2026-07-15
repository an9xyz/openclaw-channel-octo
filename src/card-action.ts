import { ChannelType, MessageType, type BotMessage } from "./types.js";

export interface BotEvent {
  event_id: number;
  event_type?: string;
  event_data?: Record<string, unknown>;
  message?: Record<string, unknown>;
}

export interface CardAction {
  eventId: number;
  messageId: string;
  channelId: string;
  channelType: ChannelType;
  actionId: string;
  inputs: Record<string, string>;
  operatorUid: string;
  data?: Record<string, unknown>;
  spaceId?: string;
  clientToken?: string;
  actedAt?: number;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function channelTypeValue(value: unknown): ChannelType | null {
  const numeric = typeof value === "number" ? value : Number(value);
  if (
    numeric !== ChannelType.DM &&
    numeric !== ChannelType.Group &&
    numeric !== ChannelType.CommunityTopic
  ) {
    return null;
  }
  return numeric;
}

/** Parse the server-authoritative card_action envelope without trusting form input values. */
export function parseCardAction(event: BotEvent): CardAction | null {
  if (
    !Number.isSafeInteger(event.event_id) ||
    event.event_id < 0 ||
    event.event_type !== "card_action" ||
    !event.event_data ||
    typeof event.event_data !== "object"
  ) {
    return null;
  }

  const data = event.event_data;
  const messageId = stringValue(data.message_id);
  const channelId = stringValue(data.channel_id);
  const channelType = channelTypeValue(data.channel_type);
  const actionId = stringValue(data.action_id);
  const operatorUid = stringValue(data.operator_uid);
  if (!messageId || !channelId || channelType === null || !actionId || !operatorUid) return null;

  const inputs: Record<string, string> = {};
  if (data.inputs && typeof data.inputs === "object" && !Array.isArray(data.inputs)) {
    for (const [key, value] of Object.entries(data.inputs as Record<string, unknown>)) {
      if (typeof value === "string") inputs[key] = value;
    }
  }

  const action: CardAction = {
    eventId: event.event_id,
    messageId,
    channelId,
    channelType,
    actionId,
    inputs,
    operatorUid,
  };
  if (data.data && typeof data.data === "object" && !Array.isArray(data.data)) {
    action.data = data.data as Record<string, unknown>;
  }
  const spaceId = stringValue(data.space_id);
  if (spaceId) action.spaceId = spaceId;
  const clientToken = stringValue(data.client_token);
  if (clientToken) action.clientToken = clientToken;
  if (typeof data.acted_at === "number" && Number.isFinite(data.acted_at)) {
    action.actedAt = data.acted_at;
  }
  return action;
}

/** Keep user-controlled input inside a JSON value instead of interpolating it as control text. */
export function formatCardActionText(action: CardAction): string {
  const lines = [
    "[Octo card action]",
    `action_id=${action.actionId}`,
    `inputs=${JSON.stringify(action.inputs)}`,
  ];
  if (action.data) lines.push(`data=${JSON.stringify(action.data)}`);
  return lines.join("\n");
}

/** Translate a verified card action into the same message shape used by the normal inbound path. */
export function synthesizeCardActionMessage(action: CardAction, botUid: string): BotMessage {
  return {
    message_id: `card_action:${action.eventId}`,
    message_seq: 0,
    from_uid: action.operatorUid,
    channel_id: action.channelId,
    channel_type: action.channelType,
    timestamp: action.actedAt ?? Math.floor(Date.now() / 1000),
    payload: {
      type: MessageType.Text,
      content: formatCardActionText(action),
      mention: { uids: [botUid] },
    },
  };
}

export function validateCardActionInputs(
  action: CardAction,
  limits?: { maxInputTextBytes?: number; maxInputsBytes?: number },
): { ok: true } | { ok: false; error: string } {
  const maxInputTextBytes = limits?.maxInputTextBytes ?? 4_096;
  const maxInputsBytes = limits?.maxInputsBytes ?? 16_384;
  const encoder = new TextEncoder();
  for (const [key, value] of Object.entries(action.inputs)) {
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(key)) return { ok: false, error: "提交字段非法" };
    if (encoder.encode(value).byteLength > maxInputTextBytes) {
      return { ok: false, error: "提交内容过大" };
    }
  }
  if (encoder.encode(JSON.stringify(action.inputs)).byteLength > maxInputsBytes) {
    return { ok: false, error: "提交内容过大" };
  }
  return { ok: true };
}
