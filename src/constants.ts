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
 * P1-e agent 展示卡工具名(见 `card-display-tool.ts`)。card-progress 侧据此把它排除
 * 出进度追踪:展示卡 turn 的产出**就是那张卡本身**,不该再有旁边的"正在处理/已中断"
 * 进度卡噪音。集中定义避免字面量漂移。
 */
export const DISPLAY_CARD_TOOL_NAME = "octo_send_display_card";

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
