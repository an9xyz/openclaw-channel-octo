/**
 * ClawHub setup entry for openclaw-channel-octo.
 *
 * Uses defineBundledChannelSetupEntry — OpenClaw's plugin loader requires
 * this when registrationPlan.loadSetupEntry is true (the path taken by
 * `openclaw channels add` for not-yet-enabled channel plugins). The loader
 * imports this entry (NOT main index.js) and calls loadSetupPlugin() to
 * obtain the channel plugin object for registration.
 *
 * runtime is wired so the loader will call setOctoRuntime(api.runtime)
 * during setup-only registration. Without it, the plugin loads via this
 * path but never gets a runtime injected, and the first inbound message
 * crashes with "Octo runtime not initialized".
 */
import { defineBundledChannelSetupEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelSetupEntry({
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./src/channel.js",
    exportName: "octoPlugin",
  },
  runtime: {
    specifier: "./src/runtime.js",
    exportName: "setOctoRuntime",
  },
});
