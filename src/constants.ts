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

/** Strip channel namespace prefix from a sessionKey or target string. */
export function stripChannelPrefix(s: string): string {
  return s.replace(/^octo:/, "");
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
