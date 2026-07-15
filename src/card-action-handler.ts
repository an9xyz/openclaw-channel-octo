import { normalizeAccountId } from "./account-id.js";
import { editCardMessage } from "./api-fetch.js";
import { renderCardActionStatus, type CardActionStatus } from "./card-action-status.js";
import { validateCardActionInputs, type CardAction } from "./card-action.js";
import {
  claimCardSession,
  completeCardSession,
  lookupCardSession,
  nextCardSessionSeq,
  releaseCardSessionClaim,
  type CardSession,
} from "./card-session.js";
import { CARD_INTERACTIVE_PROFILE } from "./types.js";

export type CardActionHandleResult = "completed" | "duplicate" | "ignored" | "rejected";

interface Params {
  action: CardAction;
  accountId: string;
  apiUrl: string;
  botToken: string;
  operatorName?: string;
  dispatch: () => Promise<void>;
  log?: { warn?: (message: string) => void };
}

async function updateStatus(params: {
  action: CardAction;
  session: CardSession;
  apiUrl: string;
  botToken: string;
  operator: string;
  status: CardActionStatus;
  errorText?: string;
  transient?: boolean;
  log?: { warn?: (message: string) => void };
}): Promise<void> {
  const rendered = renderCardActionStatus({
    title: params.session.title,
    operator: params.operator,
    actionLabel: params.session.actionLabels[params.action.actionId] ?? params.action.actionId,
    status: params.status,
    ...(params.errorText ? { errorText: params.errorText } : {}),
  });
  const cardSeq = nextCardSessionSeq(params.action.messageId);
  if (cardSeq === undefined) return;
  try {
    await editCardMessage({
      apiUrl: params.apiUrl,
      botToken: params.botToken,
      messageId: params.action.messageId,
      channelId: params.session.channelId,
      channelType: params.session.channelType,
      card: rendered.card,
      plain: rendered.plain,
      profile: CARD_INTERACTIVE_PROFILE,
      cardSeq,
      ...(params.transient ? { transient: true } : {}),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    params.log?.warn?.(
      `octo: card status edit failed message=${params.action.messageId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function handleCardAction(params: Params): Promise<CardActionHandleResult> {
  const { action } = params;
  const pendingSession = lookupCardSession(action.messageId);
  if (!pendingSession) {
    params.log?.warn?.(`octo: ignoring card_action for unknown/expired message=${action.messageId}`);
    return "ignored";
  }
  const identityMatches =
    normalizeAccountId(pendingSession.accountId) === normalizeAccountId(params.accountId) &&
    pendingSession.channelId === action.channelId &&
    pendingSession.channelType === action.channelType;
  const actionKnown = Object.hasOwn(pendingSession.actionLabels, action.actionId);
  if (!identityMatches || !actionKnown) {
    params.log?.warn?.(`octo: ignoring mismatched card_action message=${action.messageId}`);
    return "ignored";
  }

  const claim = claimCardSession(action.messageId, action.eventId);
  if (claim.status === "missing") return "ignored";
  if (claim.status === "duplicate") return "duplicate";
  const session = claim.session;

  const inputs = validateCardActionInputs(action, session);
  if (!inputs.ok) {
    completeCardSession(action.messageId, action.eventId);
    await updateStatus({
      action,
      session,
      apiUrl: params.apiUrl,
      botToken: params.botToken,
      operator: params.operatorName ?? action.operatorUid,
      status: "error",
      errorText: inputs.error,
      log: params.log,
    });
    return "rejected";
  }

  await updateStatus({
    action,
    session,
    apiUrl: params.apiUrl,
    botToken: params.botToken,
    operator: params.operatorName ?? action.operatorUid,
    status: "processing",
    transient: true,
    log: params.log,
  });
  try {
    await params.dispatch();
    completeCardSession(action.messageId, action.eventId);
    await updateStatus({
      action,
      session,
      apiUrl: params.apiUrl,
      botToken: params.botToken,
      operator: params.operatorName ?? action.operatorUid,
      status: "completed",
      log: params.log,
    });
    return "completed";
  } catch (error) {
    releaseCardSessionClaim(action.messageId, action.eventId);
    await updateStatus({
      action,
      session,
      apiUrl: params.apiUrl,
      botToken: params.botToken,
      operator: params.operatorName ?? action.operatorUid,
      status: "error",
      errorText: "处理失败，正在重试",
      log: params.log,
    });
    throw error;
  }
}
