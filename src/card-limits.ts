import { CARD_PROFILE, CARD_VERSION, MessageType } from "./types.js";

/** Manifest-derived structural and payload limits shared by all card producers. */
export interface CardLimits {
  maxNodes?: number;
  maxDepth?: number;
  maxPayloadBytes?: number;
}

function positiveLimit(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/**
 * Conservative recursive node count: every nested schema object counts, while arrays and
 * the root AdaptiveCard envelope do not. This includes columns, rows, cells, facts, actions,
 * target descriptors, and rich-text inlines.
 */
export function countCardNodes(value: unknown, root = true): number {
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + countCardNodes(item, false), 0);
  }
  if (!value || typeof value !== "object") return 0;
  return (root ? 0 : 1) + Object.values(value as Record<string, unknown>)
    .reduce<number>((sum, item) => sum + countCardNodes(item, false), 0);
}

/** Object nesting depth; arrays are transparent containers, matching the recursive walker. */
export function cardMaxDepth(value: unknown, depth = 0): number {
  if (Array.isArray(value)) {
    return value.reduce((max, item) => Math.max(max, cardMaxDepth(item, depth)), depth);
  }
  if (!value || typeof value !== "object") return depth;
  return Object.values(value as Record<string, unknown>)
    .reduce<number>((max, item) => Math.max(max, cardMaxDepth(item, depth + 1)), depth);
}

/** UTF-8 size of the complete type-17 payload envelope, not just card JSON. */
export function cardPayloadBytes(card: Record<string, unknown>, plain: string): number {
  return new TextEncoder().encode(JSON.stringify({
    type: MessageType.InteractiveCard,
    profile: CARD_PROFILE,
    card_version: CARD_VERSION,
    card,
    plain,
  })).byteLength;
}

export function cardFitsLimits(
  card: Record<string, unknown>,
  plain: string,
  limits: CardLimits | undefined,
): boolean {
  const maxNodes = positiveLimit(limits?.maxNodes);
  if (maxNodes !== undefined && countCardNodes(card) > maxNodes) return false;
  const maxDepth = positiveLimit(limits?.maxDepth);
  if (maxDepth !== undefined && cardMaxDepth(card) > maxDepth) return false;
  const maxPayloadBytes = positiveLimit(limits?.maxPayloadBytes);
  if (maxPayloadBytes !== undefined && cardPayloadBytes(card, plain) > maxPayloadBytes) return false;
  return true;
}
