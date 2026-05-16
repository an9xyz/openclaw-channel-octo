/**
 * ClawHub setup entry for openclaw-channel-octo.
 *
 * Uses defineBundledChannelSetupEntry — OpenClaw's plugin loader requires
 * this when registrationPlan.loadSetupEntry is true (the path taken by
 * `openclaw channels add` for not-yet-enabled channel plugins). The loader
 * imports this entry (NOT main index.js) and calls loadSetupPlugin() to
 * obtain the channel plugin object for registration.
 */
import { defineBundledChannelSetupEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelSetupEntry({
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./src/channel.js",
    exportName: "dmworkPlugin",
  },
});
