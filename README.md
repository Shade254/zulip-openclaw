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

Works on OpenClaw **2026.6.11 and later**, and remains backward compatible with earlier gateways. Version 2026.6.11 tightened the plugin API in two ways this plugin now satisfies:

- **Tool ownership contract** — agent tools only register when the plugin manifest declares them upfront. `openclaw.plugin.json` lists all three tools under `contracts.tools`; if you add or rename a tool in `index.js`, update that list too (the `contracts.test.js` suite fails on any drift).
- **Unified message-action discovery** — the gateway discovers channel actions by calling `actions.describeMessageTool(context)` and no longer consults the legacy `actions.listActions` hook. The plugin implements both, sharing one action list, so it works on either side of the 2026.6.11 boundary.

Symptoms on 2026.6.11 without these fixes: boot-log errors `plugin must declare contracts.tools before registering agent tools` and `describeMessageTool is not a function`, with Zulip agent tools and message actions missing while the gateway otherwise stays healthy.

## Setup

**Requires Node.js 18+** (for native fetch)

1. Add credentials to `~/.openclaw/secrets/zulip.env`:
   ```
   ZULIP_EMAIL=bot@your-org.zulipchat.com
   ZULIP_API_KEY=your-api-key
   ZULIP_SITE=https://your-org.zulipchat.com
   ```

2. Add the plugin load path:
   ```bash
   openclaw config set plugins.load.paths '["/path/to/zulip-openclaw"]'
   openclaw config set plugins.entries.zulip-openclaw.enabled true
   ```

3. Restart the gateway.

## Zulip API Reference

- [REST API docs](https://zulip.com/api/)
- [Real-time events](https://zulip.com/api/real-time-events)
- [Message formatting](https://zulip.com/help/format-your-message-using-markdown)

## License

MIT
