/**
 * OpenClaw plugin-contract tests
 *
 * Guards the two gateway registration surfaces this plugin depends on:
 *  1. Agent tools register only when openclaw.plugin.json declares them
 *     in contracts.tools (enforced by the gateway since 2026.5.2).
 *  2. Message-action discovery calls actions.describeMessageTool(ctx);
 *     the legacy listActions adapter was removed in gateway 2026.3.22.
 *
 * Run with: npm test
 */

const manifest = require('../openclaw.plugin.json');
const pkg = require('../package.json');
const register = require('../index.js');
const { zulipPlugin, MESSAGE_ACTIONS } = require('../plugin');

// ============================================
// contracts.tools <-> registerTool consistency
// ============================================

describe('manifest contracts.tools', () => {
  /**
   * Runs index.js register() against a mock plugin API and captures every
   * tool name it tries to register — the same names the gateway checks
   * against contracts.tools. Mirrors the gateway's extraction (opts.names,
   * opts.name, tool.name for non-factory tools) including its trim step.
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
    return [...new Set(names.map((name) => String(name).trim()))];
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
    // The gateway rejects registration of any undeclared tool with
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

  test('manifest version stays in sync with package.json', () => {
    // The two files are hand-edited independently and drifted once before
    // (manifest stuck at 0.1.0 while package.json moved on).
    expect(manifest.version).toBe(pkg.version);
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

  test('zulip schema stays open so core channel options validate as core defines them', () => {
    // Declaring per-field constraints here would newly subject pre-existing
    // `channels.zulip` values to hard config validation on upgrade (before
    // this manifest entry existed, core skipped schema validation for the
    // channel entirely). Keep the schema open and let core validate its own
    // shared options (blockStreaming, chunkMode, ...) with its own bounds.
    const schema = manifest.channelConfigs.zulip.schema;
    expect(schema.additionalProperties).toBe(true);
    expect(schema.properties ?? {}).toEqual({});
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

  test('is a function (missing hook silently disables message actions)', () => {
    // Gateway discovery calls params.describeMessageTool(context) inside a
    // try/catch: a missing function is caught and logged once as a
    // "[message-action-discovery] ... failed" error while tool schemas are
    // built, and Zulip's message actions silently vanish from the shared
    // `message` tool. The gateway itself keeps running.
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

  test('action list is frozen shared state (gateway copies before use)', () => {
    zulipPlugin.config.listAccountIds = jest.fn(() => ['default']);
    const described = zulipPlugin.actions.describeMessageTool({ cfg: {} });
    expect(described.actions).toBe(MESSAGE_ACTIONS);
    expect(Object.isFrozen(described.actions)).toBe(true);
  });

  test('requires a trusted requester sender for edit and delete only', () => {
    // The gateway only enforces its requester-identity gate for actions the
    // plugin marks via requiresTrustedRequesterSender; without it, any
    // tool-driven caller could edit or delete Zulip messages.
    const gate = zulipPlugin.actions.requiresTrustedRequesterSender;
    expect(typeof gate).toBe('function');
    for (const action of MESSAGE_ACTIONS) {
      expect(gate({ action })).toBe(action === 'edit' || action === 'delete');
    }
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
});

// ============================================
// advertised actions <-> handleAction parity
// ============================================

describe('advertised actions are executable', () => {
  let originalListAccountIds;
  let originalResolveAccount;
  let originalFetch;

  // One canned Zulip success response rich enough that every action's happy
  // path — including the read/reactions mappers — actually executes. The
  // second reaction has no `user` object, matching newer Zulip servers where
  // the legacy nested user dict is deprecated in favor of user_id.
  const zulipResponse = {
    result: 'success',
    id: 1,
    messages: [
      {
        id: 7,
        sender_full_name: 'Ada',
        sender_email: 'ada@example.com',
        content: 'hi **there**',
        subject: 'topic-a',
        timestamp: 1720000000,
        reactions: [
          { emoji_name: 'heart', user: { full_name: 'Ada' } },
          { emoji_name: 'tada', user_id: 9 },
        ],
      },
    ],
    message: {
      reactions: [{ emoji_name: 'heart', user: { full_name: 'Ada' } }],
    },
  };

  beforeEach(() => {
    originalListAccountIds = zulipPlugin.config.listAccountIds;
    originalResolveAccount = zulipPlugin.config.resolveAccount;
    originalFetch = global.fetch;
    zulipPlugin.config.listAccountIds = jest.fn(() => ['default']);
    zulipPlugin.config.resolveAccount = jest.fn(() => ({
      accountId: 'default',
      email: 'bot@example.com',
      apiKey: 'test-key',
      site: 'https://example.zulipchat.com',
    }));
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map(),
      json: () => Promise.resolve(zulipResponse),
    });
  });

  afterEach(() => {
    zulipPlugin.config.listAccountIds = originalListAccountIds;
    zulipPlugin.config.resolveAccount = originalResolveAccount;
    global.fetch = originalFetch;
  });

  const actionParams = {
    to: 'stream:general',
    message: 'hi',
    topic: 't',
    messageId: '1',
    emoji: 'heart',
    stream: 'general',
    content: 'hi',
  };

  test('every advertised action succeeds against a healthy Zulip API', async () => {
    // Discovery and execution must not drift: an advertised action that
    // handleAction rejects or fumbles would surface as an error to users.
    const { actions } = zulipPlugin.actions.describeMessageTool({ cfg: {} });
    for (const action of actions) {
      const result = await zulipPlugin.actions.handleAction({
        action,
        params: actionParams,
        cfg: {},
        accountId: 'default',
      });
      expect(result.error ?? '').not.toContain('Unsupported action');
      expect(result.ok).toBe(true);
    }
  });

  test('edit PATCHes /messages/:id with the new content', async () => {
    await zulipPlugin.actions.handleAction({
      action: 'edit',
      params: { messageId: '42', message: 'updated' },
      cfg: {},
      accountId: 'default',
    });
    const [url, opts] = global.fetch.mock.calls.at(-1);
    expect(url).toBe('https://example.zulipchat.com/api/v1/messages/42');
    expect(opts.method).toBe('PATCH');
    expect(opts.body).toBe(new URLSearchParams({ content: 'updated' }).toString());
  });

  test('delete sends DELETE to /messages/:id', async () => {
    await zulipPlugin.actions.handleAction({
      action: 'delete',
      params: { messageId: '42' },
      cfg: {},
      accountId: 'default',
    });
    const [url, opts] = global.fetch.mock.calls.at(-1);
    expect(url).toBe('https://example.zulipchat.com/api/v1/messages/42');
    expect(opts.method).toBe('DELETE');
  });

  test('read maps messages and tolerates reactions without a user object', async () => {
    const result = await zulipPlugin.actions.handleAction({
      action: 'read',
      params: { stream: 'general', topic: 'topic-a' },
      cfg: {},
      accountId: 'default',
    });
    expect(result.ok).toBe(true);
    expect(result.messages).toEqual([
      {
        id: '7',
        sender: 'Ada',
        senderEmail: 'ada@example.com',
        content: 'hi **there**',
        topic: 'topic-a',
        timestamp: 1720000000,
        reactions: [
          { emoji: 'heart', user: 'Ada' },
          { emoji: 'tada', user: 'unknown' },
        ],
      },
    ]);
  });
});
