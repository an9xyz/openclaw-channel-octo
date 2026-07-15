import { requestCardEventPolling } from "./events-poll.js";
import { ChannelType } from "./types.js";

export interface CardSession {
  sessionKey: string;
  accountId: string;
  channelId: string;
  channelType: ChannelType;
  title: string;
  actionLabels: Record<string, string>;
  maxInputTextBytes?: number;
  maxInputsBytes?: number;
}

interface CardSessionEntry {
  session: CardSession;
  expiresAt: number;
  state: "pending" | "processing" | "completed";
  claimedEventId?: number;
  cardSeq: number;
}

export type CardClaimResult =
  | { status: "claimed"; session: CardSession }
  | { status: "duplicate"; session: CardSession }
  | { status: "missing" };

const CARD_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_CARD_SESSIONS = 1_000;
const sessions = new Map<string, CardSessionEntry>();

function pruneExpired(now = Date.now()): void {
  for (const [messageId, entry] of sessions) {
    if (entry.expiresAt <= now) sessions.delete(messageId);
  }
}

function entryFor(messageId: string): CardSessionEntry | null {
  const entry = sessions.get(messageId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    sessions.delete(messageId);
    return null;
  }
  return entry;
}

export function registerCardSession(messageId: string, session: CardSession): void {
  if (!messageId.trim()) return;
  pruneExpired();
  if (sessions.has(messageId)) sessions.delete(messageId);
  while (sessions.size >= MAX_CARD_SESSIONS) {
    const oldest = sessions.keys().next().value as string | undefined;
    if (!oldest) break;
    sessions.delete(oldest);
  }
  sessions.set(messageId, {
    session,
    expiresAt: Date.now() + CARD_SESSION_TTL_MS,
    state: "pending",
    cardSeq: 0,
  });
  requestCardEventPolling(session.accountId);
}

export function lookupCardSession(messageId: string): CardSession | null {
  return entryFor(messageId)?.session ?? null;
}

export function claimCardSession(messageId: string, eventId: number): CardClaimResult {
  const entry = entryFor(messageId);
  if (!entry) return { status: "missing" };
  if (entry.state !== "pending") return { status: "duplicate", session: entry.session };
  entry.state = "processing";
  entry.claimedEventId = eventId;
  return { status: "claimed", session: entry.session };
}

export function releaseCardSessionClaim(messageId: string, eventId: number): void {
  const entry = entryFor(messageId);
  if (!entry || entry.state !== "processing" || entry.claimedEventId !== eventId) return;
  entry.state = "pending";
  entry.claimedEventId = undefined;
}

export function completeCardSession(messageId: string, eventId: number): void {
  const entry = entryFor(messageId);
  if (!entry || entry.state !== "processing" || entry.claimedEventId !== eventId) return;
  entry.state = "completed";
}

export function nextCardSessionSeq(messageId: string): number | undefined {
  const entry = entryFor(messageId);
  if (!entry) return undefined;
  entry.cardSeq += 1;
  return entry.cardSeq;
}

export function forgetCardSession(messageId: string): void {
  sessions.delete(messageId);
}

export function _resetCardSessionsForTests(): void {
  sessions.clear();
}
