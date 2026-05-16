# openclaw-channel-octo

[![ClawHub](https://img.shields.io/badge/ClawHub-openclaw--channel--octo-blue?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0Ij48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIxMCIgZmlsbD0id2hpdGUiLz48L3N2Zz4=)](https://clawhub.ai/plugins/openclaw-channel-octo)

OpenClaw channel plugin for **Octo**. Connects via WebSocket for real-time messaging.

## Prerequisites

- Node.js >= 22
  (OpenClaw >= 2026.4.15 requires Node 22; this is a platform constraint, not a plugin-level requirement.)
- OpenClaw installed and configured (`npm i -g openclaw`)
- A bot created via BotFather in Octo (send `/newbot` to BotFather)

## Install

Install from ClawHub:

```bash
openclaw plugins install clawhub:openclaw-channel-octo
```

Or install via npm:

```bash
npx -y openclaw-channel-octo install
```

After installing, bind a bot account:

```bash
npx -y openclaw-channel-octo bind \
  --bot-token bf_your_token_here \
  --api-url https://your-server.example/api \
  --account-id my_bot \
  --agent your_agent_id
```

`install` flags:

- `--force`: reinstall even if already installed
- `--dev`: install the `@dev` dist-tag instead of `@latest`

## CLI Commands

```bash
# Install/update the plugin (no bot config)
npx -y openclaw-channel-octo install

# Bind a bot to an agent (writes channels.octo + bindings(channel=octo))
npx -y openclaw-channel-octo bind --bot-token <T> --api-url <U> --account-id <ID> --agent <agent>

# Batch-create one bot per agent and bind them all
npx -y openclaw-channel-octo quickstart --api-key <user-api-key> --api-url <U>

# Update the plugin to the latest version
npx -y openclaw-channel-octo update

# Diagnose plugin health
npx -y openclaw-channel-octo doctor

# Uninstall (removes plugin + all bot configs under channels.octo)
npx -y openclaw-channel-octo uninstall

# Remove a single bot account (only touches channels.octo)
npx -y openclaw-channel-octo remove-account --account-id my_bot
```

### OpenClaw internal commands

After installation, these commands are available inside OpenClaw:

```
/octo_doctor              # Check plugin status and connectivity
/octo_doctor my_bot       # Check a specific account
```

The legacy `/dmwork_*` aliases keep working for one release cycle and emit a
deprecation hint on every invocation. Prefer the `/octo_*` names.

## Configuration

Bot accounts are stored in `~/.openclaw/openclaw.json` under `channels.octo.accounts`:

```json
{
  "channels": {
    "octo": {
      "apiUrl": "http://your-server:8090",
      "accounts": {
        "my_bot": {
          "botToken": "bf_your_token_here",
          "apiUrl": "http://your-server:8090"
        },
        "another_bot": {
          "botToken": "bf_another_token",
          "apiUrl": "https://im.example.com/api"
        }
      }
    }
  }
}
```

Configuration fields per account:

- `botToken` (required): Bot token from BotFather (`bf_` prefix)
- `apiUrl` (required): Octo server API URL
- `wsUrl` (optional): WebSocket URL. Auto-detected if omitted.
- `requireMention` (optional): Only respond when @mentioned in groups
- `historyLimit` (optional): Group chat history message limit (default: 20)

## What it does

1. Registers the bot with the Octo server via REST API
2. Connects to WebSocket for real-time message receiving
3. Auto-reconnects on disconnection
4. Sends a greeting to the bot owner on connect
5. Dispatches incoming messages to OpenClaw's message handler
6. Supports streaming responses (start/send/end), typing indicators, and read receipts

## As an OpenClaw Plugin

The `index.ts` exports a standard OpenClaw plugin object. When loaded by OpenClaw:

- `register(api)` is called automatically
- `api.runtime` is injected for logging and lifecycle management
- `api.registerChannel()` registers the Octo channel plugin
- `api.registerCommand()` registers `/octo_doctor` (and the legacy `/dmwork_doctor` alias)
- Configuration is read from `channels.octo` in OpenClaw's config

The plugin uses the `ChannelPlugin` SDK interface with support for:
- Direct messages and group chats
- Multi-account configuration via `channels.octo.accounts`
- Config hot-reload on `channels.octo` prefix changes

## Disconnect

To disconnect the bot, send `/disconnect` to BotFather in Octo. This invalidates the current IM token and kicks the WebSocket connection.
