/**
 * openclaw-channel-octo
 *
 * OpenClaw channel plugin for Octo messaging platform.
 * Connects via WebSocket for real-time messaging.
 *
 * Slash commands are registered under both the new `/octo_*` names and the
 * deprecated `/dmwork_*` aliases (one release cycle for backward compat).
 *
 * Entry uses defineBundledChannelEntry — the SDK contract OpenClaw's plugin
 * loader expects (>=2026.5.x). The previous plain `{ id, name, register }`
 * object shape silently failed loader detection ("missing register/activate
 * export") because the loader checks for the bundled-channel-entry contract
 * specifically, not any object that happens to have a `register` field.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { dmworkPlugin } from "./src/channel.js";
import { setDmworkRuntime } from "./src/runtime.js";
import { getGroupMdForPrompt } from "./src/group-md.js";
import { pendingInboundContext } from "./src/inbound.js";
import {
  getOpenClawVersion,
  pluginsInspect,
  configGet,
  configGetJson,
  configSet,
  configUnset,
  gatewayRestart,
} from "./cli/openclaw-cli.js";
import {
  PLUGIN_ID,
  CHANNEL_ID,
  LEGACY_CHANNEL_ID,
  RECOMMENDED_DM_SCOPE,
  validateAccountId,
  channelConfigPath,
} from "./cli/utils.js";

// ---------------------------------------------------------------------------
// Command handlers (reused by /octo_* main and /dmwork_* legacy aliases)
// ---------------------------------------------------------------------------

async function handleInfo() {
  const openclawVersion = getOpenClawVersion() ?? "not found";
  const inspect = pluginsInspect(PLUGIN_ID);
  const installedVersion = inspect?.plugin?.version ?? "not installed";
  return {
    text: [
      `${PLUGIN_ID}: ${installedVersion}`,
      `openclaw: ${openclawVersion}`,
      `plugin package: ${PLUGIN_ID}`,
    ].join("\n"),
  };
}

async function handleAddAccount(ctx: any, primaryCommandName: string) {
  const parts = ctx.args?.trim().split(/\s+/) ?? [];
  if (parts.length < 3) {
    return { text: `Usage: /${primaryCommandName} <account_id> <bot_token> <api_url>`, isError: true };
  }
  const [accountId, botToken, apiUrl] = parts;
  if (!validateAccountId(accountId)) {
    return { text: `Invalid account ID "${accountId}". Only letters, digits, and underscores allowed.`, isError: true };
  }
  if (!botToken.startsWith("bf_")) {
    return { text: "Bot token must start with 'bf_'.", isError: true };
  }
  try {
    const existed = Boolean(configGet(channelConfigPath("accounts", accountId, "botToken")));
    configSet(channelConfigPath("accounts", accountId, "botToken"), botToken);
    configSet(channelConfigPath("accounts", accountId, "apiUrl"), apiUrl);
    const dmScope = configGet("session.dmScope");
    if (!dmScope) {
      configSet("session.dmScope", RECOMMENDED_DM_SCOPE);
    }
    gatewayRestart(true);
    return { text: `${existed ? "Updated" : "Added"} bot account: ${accountId} (API: ${apiUrl}). Gateway restarted.` };
  } catch (e) {
    return { text: `Failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
  }
}

async function handleRemoveAccount(ctx: any, primaryCommandName: string) {
  const accountId = ctx.args?.trim();
  if (!accountId) {
    return { text: `Usage: /${primaryCommandName} <account_id>`, isError: true };
  }
  if (!validateAccountId(accountId)) {
    return { text: `Invalid account ID "${accountId}". Only letters, digits, and underscores allowed.`, isError: true };
  }
  try {
    const token = configGet(channelConfigPath("accounts", accountId, "botToken"));
    if (!token) {
      return { text: `Account "${accountId}" does not exist.`, isError: true };
    }
    configUnset(channelConfigPath("accounts", accountId));
    gatewayRestart(true);
    const remaining = configGetJson(channelConfigPath("accounts"));
    const count = remaining ? Object.keys(remaining).length : 0;
    return { text: `Removed account: ${accountId}. ${count} account(s) remaining. Gateway restarted.` };
  } catch (e) {
    return { text: `Failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
  }
}

// ---------------------------------------------------------------------------
// Plugin entry — uses defineBundledChannelEntry contract (OpenClaw 2026.5.x+).
//
// configSchema is loaded at module-load time from openclaw.plugin.json so we
// keep the static manifest as single source of truth (avoids drift between
// the JSON schema shipped to ClawHub and the runtime schema OpenClaw asks
// for during config validation).
// ---------------------------------------------------------------------------

function loadConfigSchema(): any {
  // openclaw.plugin.json sits at the package root; index.js after build is
  // at <pkg>/dist/index.js, so go up one level.
  //
  // Wrapped in try/catch because the OpenClaw plugin loader runs us in an
  // isolated module context — if readFileSync fails for any reason (path
  // resolution quirk, missing file in a partial install), throwing here
  // would kill the whole entry module, and the loader would report the
  // generic "missing register/activate" error with no clue what actually
  // failed. Returning {} is a safe fallback: validation still runs but
  // with no constraints.
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const manifestPath = join(here, "..", "openclaw.plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    return manifest?.channelConfigs?.octo?.schema ?? {};
  } catch (err) {
    console.warn(`[octo] failed to load configSchema from openclaw.plugin.json: ${(err as Error).message}`);
    return {};
  }
}

export default defineBundledChannelEntry({
  id: "octo",
  name: "Octo",
  description: "OpenClaw Octo channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./src/channel.js",
    exportName: "dmworkPlugin",
  },
  configSchema: loadConfigSchema(),
  registerFull(api: OpenClawPluginApi) {
    setDmworkRuntime(api.runtime);
    api.registerChannel({ plugin: dmworkPlugin });

    // -----------------------------------------------------------------------
    // Slash command registration helper: registers /octo_<name> as the primary
    // command and /dmwork_<name> as a deprecated alias sharing the same handler.
    // -----------------------------------------------------------------------
    const registerCommandWithAlias = (
      name: string,
      description: string,
      acceptsArgs: boolean,
      handler: (ctx: any) => Promise<{ text: string; isError?: boolean }>,
    ) => {
      const octoName = `octo_${name}`;
      const dmworkName = `dmwork_${name}`;

      // Primary command
      api.registerCommand({
        name: octoName,
        description,
        acceptsArgs,
        handler,
      });

      // LEGACY-ALIAS: deprecated /dmwork_* alias kept for one release cycle.
      // Logs a deprecation notice on every invocation so we can observe usage
      // frequency before removing in 1.1.0.
      api.registerCommand({
        name: dmworkName,
        description: `[DEPRECATED] Renamed to /${octoName}. ${description}`,
        acceptsArgs,
        async handler(ctx) {
          console.warn(
            `[deprecation] /${dmworkName} has been renamed to /${octoName}. ` +
            `The old name still works but will be removed in 1.1.0.`,
          );
          return handler(ctx);
        },
      });
    };

    registerCommandWithAlias(
      "info",
      "Show Octo plugin version info",
      false,
      handleInfo as any,
    );
    registerCommandWithAlias(
      "add_account",
      "Add or update an Octo bot account. Args: <account_id> <bot_token> <api_url>",
      true,
      (ctx) => handleAddAccount(ctx, "octo_add_account"),
    );
    registerCommandWithAlias(
      "remove_account",
      "Remove an Octo bot account. Args: <account_id>",
      true,
      (ctx) => handleRemoveAccount(ctx, "octo_remove_account"),
    );

    console.log('[octo] registering before_prompt_build hook');
    api.on('before_prompt_build', (_event, ctx) => {
      const sections: string[] = [];

      // 1. Group/Thread MD — wrapped in [GROUP CONTEXT] block
      const groupMdContent = getGroupMdForPrompt(ctx);
      if (groupMdContent) {
        sections.push(`[GROUP CONTEXT]\n${groupMdContent}\n[/GROUP CONTEXT]`);
      }

      // 2. Inbound context (member list + history) — outside [GROUP CONTEXT], keeps original format
      const sessionKey = ctx.sessionKey;
      if (sessionKey) {
        const pending = pendingInboundContext.get(sessionKey);
        if (pending) {
          pendingInboundContext.delete(sessionKey);
          if (pending.memberListPrefix) sections.push(pending.memberListPrefix);
          if (pending.historyPrefix) sections.push(pending.historyPrefix);
        }
      }

      if (sections.length === 0) return;
      return { prependContext: sections.join('\n\n') };
    });
  },
});
