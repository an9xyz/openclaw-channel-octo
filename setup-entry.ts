/**
 * ClawHub setup entry for openclaw-channel-octo.
 *
 * The openclaw plugin-sdk does not yet export `defineSetupPluginEntry` or
 * `createOptionalChannelSetupSurface`. This stub satisfies the
 * `openclaw.setupEntry` contract and will be replaced once the SDK ships
 * the official setup API.
 */

// TODO: Replace with `defineSetupPluginEntry` when available in openclaw/plugin-sdk.
export default {
  id: "openclaw-channel-octo",
  name: "Octo",
  description: "Connect OpenClaw to Octo (WuKongIM-based team collaboration platform)",

  configKeys: [
    { key: "botToken", label: "Bot Token", required: true, sensitive: true },
    { key: "apiUrl", label: "API URL", required: true },
    { key: "wsUrl", label: "WebSocket URL", required: false },
  ],

  validate(config: Record<string, string>): string | null {
    if (!config.botToken?.startsWith("bf_")) {
      return "Bot token must start with 'bf_'. Create one via /newbot in Octo BotFather.";
    }
    if (!config.apiUrl) {
      return "API URL is required.";
    }
    return null;
  },
};
