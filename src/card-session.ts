import { requestCardEventPolling } from "./events-poll.js";
import { ChannelType } from "./types.js";

export interface CardSession {
  sessionKey: string;
  accountId: string;
  channelId: string;
  channelType: ChannelType;
  title: string;
  actionLabels: Record<string, string>;
}

const sessions = new Map<string, CardSession>();

export function registerCardSession(messageId: string, session: CardSession): void {
  if (!messageId.trim()) return;
  sessions.set(messageId, session);
  requestCardEventPolling(session.accountId);
}

export function lookupCardSession(messageId: string): CardSession | null {
  return sessions.get(messageId) ?? null;
}

export function forgetCardSession(messageId: string): void {
  sessions.delete(messageId);
}

export function _resetCardSessionsForTests(): void {
  sessions.clear();
}
