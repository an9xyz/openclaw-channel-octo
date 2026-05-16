# openclaw-channel-octo

[![ClawHub](https://img.shields.io/badge/ClawHub-openclaw--channel--octo-blue?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0Ij48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIxMCIgZmlsbD0id2hpdGUiLz48L3N2Zz4=)](https://clawhub.ai/plugins/openclaw-channel-octo)

OpenClaw channel plugin for **Octo**. Connects via WebSocket for real-time messaging.

## Prerequisites

- Node.js >= 22 (OpenClaw >= 2026.4.15 requires Node 22)
- OpenClaw installed and configured (`npm i -g openclaw`)
- A bot created via BotFather in Octo (send `/newbot` to BotFather)

## Install

This plugin is published exclusively on ClawHub for fresh installs:

```bash
openclaw plugins install clawhub:openclaw-channel-octo
```

> **Note for existing dmwork users:** This repo is the ClawHub-tailored build
> for new installs. If you are upgrading from `openclaw-channel-dmwork`, use
> the migration package instead:
> ```bash
> npx -y openclaw-channel-octo@latest install
> ```
> That command pulls the `octo-adapters` npm release, which runs the
> dmwork → octo channel-config / bindings / workspace-dir migration before
> installing the new plugin.

## Configure a bot account

After installing, use OpenClaw's standard `channels add` flow.

Non-interactive (recommended for scripts and CI):

```bash
openclaw channels add --channel octo \
  --account my_bot \
  --bot-token bf_your_token_here \
  --base-url https://your-server.example/api
```

Interactive (prompts for token and API URL):

```bash
openclaw channels add --channel octo
```

After the account is written, restart the gateway (`openclaw gateway restart`)
or wait for the next auto-reload — the plugin watches `channels.octo` and
reconnects on changes.

## Slash commands inside OpenClaw

| Command | Args | Description |
|---|---|---|
| `/octo_info` | none | Show plugin and OpenClaw versions. |
| `/octo_add_account` | `<account_id> <bot_token> <api_url>` | Add or update a bot account from inside an agent conversation. |
| `/octo_remove_account` | `<account_id>` | Remove a bot account. |

Example:

```
/octo_add_account my_bot bf_xxx https://im.example.com/api
/octo_remove_account my_bot
```

## Configuration

Bot accounts are stored in `~/.openclaw/openclaw.json` under `channels.octo.accounts`:

```json
{
  "channels": {
    "octo": {
      "enabled": true,
      "accounts": {
        "my_bot": {
          "enabled": true,
          "botToken": "bf_your_token_here",
          "apiUrl": "https://your-server.example/api"
        }
      }
    }
  }
}
```

Configuration fields per account:

- `botToken` (required): Bot token from BotFather (`bf_` prefix)
- `apiUrl` (required): Octo server REST API base URL (e.g. `https://your-server/api`). The default `http://localhost:8090/api` only works for a local Octo dev server with the standard `/api` mount.
- `wsUrl` (optional): WebSocket URL. Auto-detected from `apiUrl` if omitted.
- `cdnUrl` (optional): CDN base URL for media files
- `requireMention` (optional): Only respond when @mentioned in groups
- `historyLimit` (optional): Group chat history message limit (default: 20)

## What it does

1. Registers the bot with the Octo server via REST API
2. Connects to WebSocket for real-time message receiving
3. Auto-reconnects on disconnection
4. Sends a greeting to the bot owner on connect
5. Dispatches incoming messages to OpenClaw's message handler
6. Supports typing indicators and read receipts

## Architecture

`index.ts` is a standard OpenClaw plugin entry. When loaded:

- `api.registerChannel(octoPlugin)` registers the Octo channel runtime
- `api.registerCommand()` registers the three `/octo_*` slash commands above
- The bundled `setupEntry` exposes `defineBundledChannelSetupEntry(...)` so
  `openclaw channels add` works without first enabling the plugin
- `setupWizard` + `setup` adapters on `octoPlugin` cover both interactive and
  CLI-flag setup paths
- Configuration is read from `channels.octo` in OpenClaw's config; the plugin
  hot-reloads when that block changes

## Disconnect

To disconnect a bot, send `/disconnect` to BotFather in Octo. This invalidates
the IM token and kicks the WebSocket connection.
