/**
 * CLI utilities re-exported for the IM-side slash command handlers in
 * index.ts. Pure constants and runtime-safe helpers live in `src/constants.ts`
 * and are re-exported from here for convenience. Runtime code (`src/*`) should
 * import directly from `src/constants.ts` and never from this file.
 */

import {
  PLUGIN_ID, PACKAGE_NAME, CHANNEL_ID,
  stripChannelPrefix,
  getChannelConfig,
  ensureChannelConfigObject,
} from "../src/constants.js";

export {
  PLUGIN_ID, PACKAGE_NAME, CHANNEL_ID,
  stripChannelPrefix,
  getChannelConfig,
  ensureChannelConfigObject,
};

// ---------------------------------------------------------------------------
// CLI-only constants
// ---------------------------------------------------------------------------

export const RECOMMENDED_DM_SCOPE = "per-account-channel-peer";

// ---------------------------------------------------------------------------
// Channel config-path helpers (string form, for configGet/configSet)
// ---------------------------------------------------------------------------

/** Build `channels.<CHANNEL_ID>.<...parts>` (current channel, default). */
export function channelConfigPath(...parts: string[]): string {
  return ["channels", CHANNEL_ID, ...parts].join(".");
}

// ---------------------------------------------------------------------------
// accountId validation
// ---------------------------------------------------------------------------

const ACCOUNT_ID_RE = /^[A-Za-z0-9_]+$/;

export function validateAccountId(id: string): boolean {
  return ACCOUNT_ID_RE.test(id);
}
