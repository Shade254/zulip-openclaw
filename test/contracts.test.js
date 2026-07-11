/**
 * OpenClaw 2026.6.11 plugin-contract tests
 *
 * Guards the two registration surfaces the gateway tightened in 2026.6.11:
 *  1. Agent tools register only when openclaw.plugin.json declares them
 *     in contracts.tools.
 *  2. Message-action discovery calls actions.describeMessageTool(ctx)
 *     directly (the legacy listActions hook is no longer consulted).
 *
 * Run with: npm test
 */

const manifest = require('../openclaw.plugin.json');
const register = require('../index.js');
const { zulipPlugin, MESSAGE_ACTIONS } = require('../plugin');

// ============================================
// contracts.tools <-> registerTool consistency
// ============================================

describe('manifest contracts.tools', () => {
  /**
   * Runs index.js register() against a mock plugin API and captures every
   * tool name it tries to register, the same names the gateway checks
   * against contracts.tools.
   */
  function captureRegisteredToolNames() {
    const names = [];
    register({
      logger: { info: () => {} },
      runtime: null,
      registerChannel: () => {},
      registerTool: (tool, opts) => {
        if (opts?.name) names.push(opts.name);
        if (Array.isArray(opts?.names)) names.push(...opts.names);
        if (typeof tool !== 'function' && tool?.name) names.push(tool.name);
      },
    });
    return [...new Set(names)];
  }

  test('manifest declares a non-empty contracts.tools array', () => {
    expect(Array.isArray(manifest.contracts?.tools)).toBe(true);
    expect(manifest.contracts.tools.length).toBeGreaterThan(0);
    for (const name of manifest.contracts.tools) {
      expect(typeof name).toBe('string');
      expect(name.trim()).toBe(name);
      expect(name).not.toBe('');
    }
  });

  test('every tool registered by index.js is declared in contracts.tools', () => {
    // The 2026.6.11 gateway rejects registration of any undeclared tool with
    // "plugin must declare contracts.tools for: <name>".
    const declared = new Set(manifest.contracts.tools);
    for (const name of captureRegisteredToolNames()) {
      expect(declared).toContain(name);
    }
  });

  test('contracts.tools contains no stale entries', () => {
    // A declared-but-never-registered name means the manifest drifted from
    // index.js; the gateway would advertise a tool that never materializes.
    const registered = new Set(captureRegisteredToolNames());
    for (const name of manifest.contracts.tools) {
      expect(registered).toContain(name);
    }
  });
});

// ============================================
// channelConfigs metadata
// ============================================

describe('manifest channelConfigs', () => {
  test('every declared channel has a channelConfigs entry', () => {
    // Mirrors the gateway's manifest-registry check: channels declared
    // without channelConfigs metadata trigger a boot warning and leave the
    // pre-runtime config schema / setup UI surfaces blind to the channel.
    for (const channelId of manifest.channels) {
      expect(Object.hasOwn(manifest.channelConfigs ?? {}, channelId)).toBe(true);
    }
  });

  test('each channelConfigs entry declares an object schema', () => {
    for (const [channelId, entry] of Object.entries(manifest.channelConfigs)) {
      expect(typeof entry.schema).toBe('object');
      expect(entry.schema.type).toBe('object');
      expect(typeof entry.label).toBe('string');
      // channelConfigs entries also imply channel ownership in the gateway
      // (recordOwnsChannel); do not declare channels the plugin doesn't own.
      expect(manifest.channels).toContain(channelId);
    }
  });

  test('zulip schema tolerates core channel fields users already set', () => {
    // Core does not merge its shared channel options (blockStreaming,
    // chunkMode, ...) into plugin schemas — the schema itself must accept
    // them or real-world `channels.zulip` config would fail validation.
    const schema = manifest.channelConfigs.zulip.schema;
    expect(schema.additionalProperties).toBe(true);
    for (const field of ['enabled', 'blockStreaming', 'blockStreamingCoalesce', 'chunkMode']) {
      expect(Object.hasOwn(schema.properties, field)).toBe(true);
    }
  });
});

// ============================================
// actions.describeMessageTool
// ============================================

describe('actions.describeMessageTool', () => {
  let originalListAccountIds;

  beforeEach(() => {
    originalListAccountIds = zulipPlugin.config.listAccountIds;
  });

  afterEach(() => {
    zulipPlugin.config.listAccountIds = originalListAccountIds;
  });

  test('is a function (gateway calls it without a typeof guard)', () => {
    // 2026.6.11 discovery invokes params.describeMessageTool(context)
    // directly; a missing function surfaces as a boot-time TypeError.
    expect(typeof zulipPlugin.actions.describeMessageTool).toBe('function');
  });

  test('returns null when no account is configured', () => {
    zulipPlugin.config.listAccountIds = jest.fn(() => []);
    expect(zulipPlugin.actions.describeMessageTool({ cfg: {} })).toBeNull();
  });

  test('returns the full action list when an account is configured', () => {
    zulipPlugin.config.listAccountIds = jest.fn(() => ['default']);
    const described = zulipPlugin.actions.describeMessageTool({ cfg: {} });
    expect(described).toEqual({
      actions: ['send', 'react', 'reactions', 'read', 'edit', 'delete'],
    });
  });

  test('stays in sync with the legacy listActions hook', () => {
    zulipPlugin.config.listAccountIds = jest.fn(() => ['default']);
    const described = zulipPlugin.actions.describeMessageTool({ cfg: {} });
    const legacy = zulipPlugin.actions.listActions({ cfg: {} });
    expect(described.actions).toEqual(legacy);
    expect(described.actions).toEqual(MESSAGE_ACTIONS);
  });

  test('returned action list is a copy, not shared mutable state', () => {
    zulipPlugin.config.listAccountIds = jest.fn(() => ['default']);
    const first = zulipPlugin.actions.describeMessageTool({ cfg: {} });
    first.actions.push('poll');
    const second = zulipPlugin.actions.describeMessageTool({ cfg: {} });
    expect(second.actions).not.toContain('poll');
    expect(MESSAGE_ACTIONS).not.toContain('poll');
  });

  test('tolerates the full gateway discovery context shape', () => {
    // Mirrors createMessageActionDiscoveryContext(...) in the gateway: the
    // hook must not choke on the extra runtime-scope fields it passes.
    zulipPlugin.config.listAccountIds = jest.fn(() => ['default']);
    const context = {
      cfg: {},
      currentChannelId: 'zulip-openclaw',
      currentChannelProvider: 'zulip-openclaw',
      currentThreadTs: undefined,
      currentMessageId: '123',
      accountId: 'default',
      sessionKey: 'sk-1',
      sessionId: 'sess-1',
      agentId: 'agent-1',
      requesterSenderId: '42',
      senderIsOwner: true,
    };
    const described = zulipPlugin.actions.describeMessageTool(context);
    expect(described).toEqual({
      actions: ['send', 'react', 'reactions', 'read', 'edit', 'delete'],
    });
  });

  test('every advertised action is handled by handleAction', async () => {
    // Discovery and execution must not drift: an advertised action that
    // handleAction rejects would surface as "Unsupported action" to users.
    zulipPlugin.config.listAccountIds = jest.fn(() => ['default']);
    const originalResolveAccount = zulipPlugin.config.resolveAccount;
    const originalFetch = global.fetch;
    zulipPlugin.config.resolveAccount = jest.fn(() => ({
      accountId: 'default',
      email: 'bot@example.com',
      apiKey: 'test-key',
      site: 'https://example.zulipchat.com',
    }));
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200, headers: new Map(),
      json: () => Promise.resolve({ result: 'success', id: 1, messages: [], message: { reactions: [] } }),
    });

    try {
      const { actions } = zulipPlugin.actions.describeMessageTool({ cfg: {} });
      for (const action of actions) {
        const result = await zulipPlugin.actions.handleAction({
          action,
          params: {
            to: 'stream:general', message: 'hi', topic: 't',
            messageId: '1', emoji: 'heart', stream: 'general', content: 'hi',
          },
          cfg: {},
          accountId: 'default',
        });
        expect(result.error ?? '').not.toContain('Unsupported action');
      }
    } finally {
      zulipPlugin.config.resolveAccount = originalResolveAccount;
      global.fetch = originalFetch;
    }
  });
});
