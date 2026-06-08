// Single source of truth for accountId normalization.
//
// OpenClaw routing/session-binding normalizes accountId to lowercase before
// lookup (via normalizeOptionalLowercaseString in the SDK). Any plugin code
// that uses accountId as a Map/Set key, composite key segment, or disk path
// segment MUST go through this helper, or it silently misses the SDK-
// normalized form for mixed-case IDs created by octo-server BotFather.
//
// Contract for callers: every exported function (including exported
// test-only `_xxx` helpers) that takes `accountId: string` as a parameter,
// or accepts an object with an accountId field, normalizes at entry. We do
// NOT trust callers to pre-normalize.
//
// See: issues openclaw-channel-octo#33 and octo-server#302.
export function normalizeAccountId(accountId: string): string {
  return accountId.toLowerCase();
}
