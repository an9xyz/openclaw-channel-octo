/**
 * Pure constants and pure functions for plugin/channel identifiers.
 *
 * **Layering rule**:
 * This file is `src/`-only and has no fs/child_process dependencies, so it can
 * be safely imported from both runtime code (`src/*.ts`) and CLI code
 * (`cli/*.ts`). Runtime code MUST NOT import from `cli/`.
 */

/**
 * OpenClaw runtime/install/config/inspect identifier for this plugin.
 * Must match `openclaw.plugin.json#id` and `package.json#openclaw.id`.
 */
export const PLUGIN_ID = "octo";


export const CHANNEL_ID = "octo";

/**
 * Separator between parent group_no and thread short_id in Octo's CommunityTopic
 * channel ID format (`<groupNo>____<shortId>`, 4 underscores). Centralized here
 * to avoid drift across modules that need to split or compose thread refs.
 */
export const THREAD_ID_SEPARATOR = "____";

/**
 * Maximum payload size for outbound bot uploads, in bytes (100 MB).
 *
 * This is the local-side cap enforced by both the outbound action handler
 * (channel.ts) and the inbound `uploadMedia` helper. It is intentionally aligned
 * to the server's `file.MaxFileSize` (octo-server `modules/file/const.go:128`):
 * `GET /v1/bot/upload/presigned` rejects any `fileSize > MaxFileSize` before
 * signing the PUT URL, so a higher local cap would just produce a clear local
 * error to a less clear remote 4xx.
 *
 * Centralized here so future bumps (when server `file.MaxFileSize` is raised)
 * change one number, not three.
 */
export const MAX_UPLOAD_SIZE = 100 * 1024 * 1024;


/**
 * Strip any of the known channel namespace prefixes (`octo:`, `channel:`,
 * `group:`) from a channelId / sessionKey / target string. Strips
 * **recursively** — stacked prefixes such as `"octo:group:grp1"` or
 * `"channel:octo:grp1"` are stripped down to `"grp1"` in one call.
 * Fully idempotent for any input.
 *
 * Why three prefixes: the OpenClaw runtime passes channel ids through several
 * layers (gateway, plugin SDK, agent tool context) and different layers
 * historically attach different namespace prefixes. Comparisons between
 * channel ids therefore need a single normalization step that strips
 * whichever prefix is present, so two callers do not silently miscompare
 * `"octo:grp1"` against `"grp1"` or `"channel:grp1"` against `"group:grp1"`.
 *
 * Recursive vs. the old chained-replace site: the previous threadId-parsing
 * site at src/actions.ts ran `replace(/^octo:/)` then `replace(/^group:/)`
 * then `replace(/^channel:/)`, which collapsed some stacked forms (e.g.
 * `"octo:group:topicA"` → `"topicA"`) but NOT all (e.g.
 * `"channel:octo:grp1"` → `"octo:grp1"`, because only the final
 * `channel:` replace stripped the outer layer and the chain never re-ran
 * `octo:` against the now-exposed inner prefix). The recursive helper is
 * **intentionally broader** than the old chain: it canonicalizes any order
 * of stacked runtime prefixes. Net effect is strictly safer for downstream
 * comparisons and matches the helper's "all channel prefixes" name.
 *
 * Note: this is a prefix-strip, not a prefix-rewrite. `normalizeOutboundChannelPrefix`
 * in src/actions.ts is a different operation that canonicalises outbound
 * channel-group targets to a single leading `group:` (and shares this
 * recursive collapse internally to handle stacked outbound forms safely).
 */
export function stripAllChannelPrefixes(s: string): string {
  let out = s;
  // Loop bounded by the number of leading runtime prefixes (at most a
  // handful in any realistic input). Each iteration strictly shortens
  // `out`, so termination is guaranteed regardless of order.
  while (true) {
    const next = out.replace(/^(octo:|channel:|group:)/, "");
    if (next === out) return out;
    out = next;
  }
}

/** Return the per-channel sub-config for the current channel id (runtime read). */
export function getChannelConfig<T = unknown>(cfg: any): T {
  return (cfg?.channels?.[CHANNEL_ID] ?? {}) as T;
}

/**
 * Lazily ensure `cfg.channels.<CHANNEL_ID>` exists and return the mutable
 * reference. Used to write account configuration.
 */
export function ensureChannelConfigObject(cfg: any): any {
  cfg.channels ??= {};
  cfg.channels[CHANNEL_ID] ??= {};
  cfg.channels[CHANNEL_ID].accounts ??= {};
  return cfg.channels[CHANNEL_ID];
}

/** Conversation kind used by routing / session helpers. */
export type ConversationKind = "user" | "group";

/**
 * Strip ONLY the provider namespace `octo:` (incl. stacked `octo:octo:`).
 * Unlike stripAllChannelPrefixes this deliberately does NOT strip kind
 * prefixes (`user:`/`group:`/`channel:`), so kind-aware parsing can read the
 * kind afterwards instead of losing it.
 */
export function stripOctoNamespacePrefix(s: string): string {
  let out = (s ?? "").trim();
  while (true) {
    const next = out.replace(/^octo:/i, "");
    if (next === out) return out;
    out = next;
  }
}

/**
 * Parse a channelId / target into its conversation kind + bare id.
 *
 * Loop-peels leading recognised tokens to canonicalise stacked runtime forms
 * (multi-bot / agent-tool routing can produce `group:octo:grp1`,
 * `octo:channel:group:grp1____x`): each iteration drops a leading `octo:`
 * (namespace) or consumes a kind prefix. The FIRST kind seen wins (the
 * outermost prefix expresses intent); `channel` is a group-class alias and
 * normalises to `group`. `id` is the remaining tail kept verbatim — for a DM
 * that is the space-scoped `<space>:<uid>` session identity, for a thread the
 * `<groupNo>____<shortId>`. Bare uid extraction is a separate step (dmPeerUid).
 */
export function parseConversationRef(s: string): { kind: ConversationKind | undefined; id: string } {
  let rest = (s ?? "").trim();
  let kind: ConversationKind | undefined;
  while (true) {
    const m = /^(octo|user|group|channel):/i.exec(rest);
    if (!m) break;
    const tok = m[1].toLowerCase();
    rest = rest.slice(m[0].length);
    if (tok !== "octo" && kind === undefined) {
      kind = tok === "user" ? "user" : "group"; // channel → group alias
    }
  }
  return { kind, id: rest };
}

/**
 * Extract the bare delivery uid from a DM id. Octo uids are colon-free
 * (32-hex user uids, `<prefix>_bot` bot uids, fixed system uids like
 * `botfather`); the only colon in a DM id comes from the `${spaceId}:${uid}`
 * session joiner (src/inbound.ts), so the peer uid is the last colon segment.
 * Used for the server delivery target + same-channel comparison ONLY — NOT for
 * the WS2 session peer.id, which must keep the space-scoped identity.
 */
export function dmPeerUid(id: string): string {
  const i = id.lastIndexOf(":");
  return i >= 0 ? id.slice(i + 1) : id;
}
