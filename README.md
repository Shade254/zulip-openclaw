# zulip-openclaw

A Zulip channel plugin for [OpenClaw](https://github.com/openclaw/openclaw) — bidirectional messaging with persona routing and topic-aware conversations.

## Why Zulip?

Zulip's topic model makes it uniquely powerful for structured AI agent work:
- **Topics are first-class** — every message belongs to a topic, enabling persistent workspaces
- **Open source** — self-hostable for privacy
- **Generous API limits** — no rate limit hell
- **Email-like threading** — topics are long-lived, not ephemeral

## Status

The plugin loads in OpenClaw and implements the core channel plugin contract (config, outbound, actions, gateway). Tested end-to-end with bidirectional messaging, context injection, and reactions.

## Features

- **Bidirectional messaging** — receive and respond to Zulip messages
- **Topic context** — recent messages injected as conversation history
- **Reactions** — see reactions on messages, add reactions via tools
- **Session routing** — streams get their own sessions (separate from DMs)

## Roadmap

### Next: Shareability
- Documentation and README
- ClawdHub skill publication
- npm package

### Later: As needed
- Persona routing — map streams to personas
- File/image support
- Edit & delete
- Stream/topic management
- Search across streams/topics

## Architecture

```
┌──────────────────────────────────────────────────┐
│                 OpenClaw Gateway                 │
├──────────────────────────────────────────────────┤
│  zulip-openclaw channel plugin                   │
│  ├── config: account from ~/.openclaw/secrets/   │
│  ├── gateway: long-poll event loop               │
│  ├── outbound: sendText, sendMedia               │
│  └── actions: send, react, read, edit, delete    │
└──────────────────────────────────────────────────┘
```

The plugin registers as an OpenClaw channel. All messaging goes through OpenClaw's native `message` tool via `actions.handleAction`. Agent tools (`zulip_send`, `zulip_read`, `zulip_react`) are also registered for direct use.

## OpenClaw compatibility

Requires OpenClaw **2026.3.22 or later**. Two gateway plugin-API changes (both predating 2026.6.11, per the gateway changelog) shape how this plugin registers:

- **Message-action discovery** (since 2026.3.22, breaking) — the gateway discovers channel actions by calling `actions.describeMessageTool(context)`; the legacy `actions.listActions` adapter was removed. If the hook is missing, the gateway catches and logs a `[message-action-discovery] … failed` error while building tool schemas, and Zulip's message actions silently disappear from the shared `message` tool — the gateway keeps running.
- **Tool ownership contract** (enforced since 2026.5.2) — agent tools only register when the plugin manifest declares them upfront. `openclaw.plugin.json` lists all three tools under `contracts.tools`; if you add or rename a tool in `index.js`, update that list too (the `contracts.test.js` suite fails on any drift). Undeclared tools are rejected with the diagnostic `plugin must declare contracts.tools for: <name>`.

The manifest also declares `channelConfigs.zulip` so the gateway's config-schema, setup, and Control UI surfaces know the channel exists before the plugin runtime loads (without it, the gateway logs a boot warning and the setup UI is limited). The declared schema is intentionally open (`additionalProperties: true`, no per-field constraints) so core channel options like `blockStreaming` keep validating exactly as core defines them — Zulip credentials live in `~/.openclaw/secrets/zulip.env`, never in `channels.zulip`.

## Setup

**Requires Node.js 18+** (for native fetch)

1. Add credentials to `~/.openclaw/secrets/zulip.env`:
   ```
   ZULIP_EMAIL=bot@your-org.zulipchat.com
   ZULIP_API_KEY=your-api-key
   ZULIP_SITE=https://your-org.zulipchat.com
   ZULIP_DEFAULT_TOPIC=chat
   ```

   `ZULIP_DEFAULT_TOPIC` is optional; it defaults to `chat`.

2. Add the plugin load path:
   ```bash
   openclaw config set plugins.load.paths '["/path/to/zulip-openclaw"]'
   openclaw config set plugins.entries.zulip-openclaw.enabled true
   ```

3. Restart the gateway.

## Destinations and topics

| Destination | Goes to |
|---|---|
| `stream:general` | stream `general`, in the reply's topic or the default topic |
| `stream:operations:topic:Job alerts` | stream `operations`, topic `Job alerts` |
| `stream:daily:topic:{date:Europe/Copenhagen} standup` | a dated topic, e.g. `2026-11-12 standup` |
| `private:user@example.com` | a direct message |

- **Topic in the destination.** Everything after `:topic:` is the topic. It wins over the topic of the conversation being replied to. This is how a scheduled delivery or a failure alert, which carry only a destination, reaches a fixed topic:
  ```bash
  openclaw cron edit <job> --announce --channel zulip-openclaw --to "stream:operations:topic:Job alerts"
  openclaw cron edit <job> --failure-alert --failure-alert-channel zulip-openclaw --failure-alert-to "stream:operations:topic:Job alerts"
  ```
- **Dated topics.** `{date}` in a topic becomes today's date (`YYYY-MM-DD`) in the gateway host's time zone, `{date:<IANA zone>}` in a named one. An unknown zone is an error.
- **No topic at all.** A stream message without a topic goes to the default topic: `ZULIP_DEFAULT_TOPIC` in `zulip.env` if set, otherwise `chat`. The plugin logs a warning each time, naming the stream, so a misrouted message can be found in the gateway log.
- **Errors.** A rejected request reports Zulip's own reason (`Zulip API error 400 on /messages: Channel 'x' does not exist`). Sends time out after 30 seconds.

## Zulip API Reference

- [REST API docs](https://zulip.com/api/)
- [Real-time events](https://zulip.com/api/real-time-events)
- [Message formatting](https://zulip.com/help/format-your-message-using-markdown)

## License

MIT
