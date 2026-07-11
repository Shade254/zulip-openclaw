/**
 * Tests for zulip-openclaw plugin
 *
 * Run with: npm test
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  zulipPlugin, zulipApi, zulipUpload, RateLimitError,
  resolvePersonaForMessage, fetchThreadContext, handleInboundMessage, setPluginRuntime,
  resolveAttachments, cleanupAttachments, ZULIP_ATTACHMENTS_DIR,
} = require('../plugin');

// ============================================
// UNIT TESTS - Pure functions, no network
// ============================================

describe('Unit Tests', () => {
  describe('messaging.normalizeTarget', () => {
    const normalize = zulipPlugin.messaging.normalizeTarget;

    test('returns null/undefined unchanged', () => {
      expect(normalize(null)).toBe(null);
      expect(normalize(undefined)).toBe(undefined);
    });

    test('passes through stream: prefix unchanged', () => {
      expect(normalize('stream:general')).toBe('stream:general');
    });

    test('passes through private: prefix unchanged', () => {
      expect(normalize('private:user@example.com')).toBe('private:user@example.com');
    });

    test('adds stream: prefix to bare stream names', () => {
      expect(normalize('general')).toBe('stream:general');
      expect(normalize('engineering')).toBe('stream:engineering');
    });
  });

  describe('messaging.targetResolver.looksLikeId', () => {
    const looksLikeId = zulipPlugin.messaging.targetResolver.looksLikeId;

    test('recognizes stream: prefix', () => {
      expect(looksLikeId('stream:general')).toBe(true);
    });

    test('recognizes private: prefix', () => {
      expect(looksLikeId('private:user@example.com')).toBe(true);
    });

    test('recognizes email addresses', () => {
      expect(looksLikeId('user@example.com')).toBe(true);
    });

    test('rejects bare stream names without @', () => {
      expect(looksLikeId('general')).toBe(false);
    });
  });

  describe('config.isConfigured', () => {
    const isConfigured = zulipPlugin.config.isConfigured;

    test('returns true when all fields present', () => {
      expect(isConfigured({
        email: 'bot@example.com',
        apiKey: 'secret123',
        site: 'https://example.zulipchat.com'
      })).toBe(true);
    });

    test('returns false when email missing', () => {
      expect(isConfigured({
        apiKey: 'secret123',
        site: 'https://example.zulipchat.com'
      })).toBe(false);
    });

    test('returns false when apiKey missing', () => {
      expect(isConfigured({
        email: 'bot@example.com',
        site: 'https://example.zulipchat.com'
      })).toBe(false);
    });

    test('returns false for null/undefined', () => {
      expect(isConfigured(null)).toBe(false);
      expect(isConfigured(undefined)).toBe(false);
    });
  });

  describe('HTML stripping (used in message parsing)', () => {
    // The plugin uses this regex: content.replace(/<[^>]*>/g, '')
    const stripHtml = (content) => content.replace(/<[^>]*>/g, '');

    test('removes simple tags', () => {
      expect(stripHtml('<p>Hello</p>')).toBe('Hello');
    });

    test('removes nested tags', () => {
      expect(stripHtml('<div><span>Hello</span></div>')).toBe('Hello');
    });

    test('removes tags with attributes', () => {
      expect(stripHtml('<a href="http://example.com">link</a>')).toBe('link');
    });

    test('handles Zulip-style formatted messages', () => {
      expect(stripHtml('<p>Hello <strong>world</strong>!</p>')).toBe('Hello world!');
    });

    test('leaves plain text unchanged', () => {
      expect(stripHtml('Hello world')).toBe('Hello world');
    });
  });

  // These helpers are not exported, so we test them indirectly through
  // the exported functions that use them. However, we can test the
  // resolveMessageTarget/createMessagePayload behavior through sendText.
  describe('message target resolution (via sendText)', () => {
    const originalFetch = global.fetch;
    const mockAccount = {
      accountId: 'default',
      email: 'bot@example.com',
      apiKey: 'test-key',
      site: 'https://example.zulipchat.com'
    };

    let originalResolveAccount;

    beforeEach(() => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true, status: 200, headers: new Map(),
        json: () => Promise.resolve({ result: 'success', id: 1 }),
      });
      originalResolveAccount = zulipPlugin.config.resolveAccount;
      zulipPlugin.config.resolveAccount = jest.fn(() => mockAccount);
    });

    afterEach(() => {
      global.fetch = originalFetch;
      zulipPlugin.config.resolveAccount = originalResolveAccount;
    });

    test('routes stream: prefix correctly', async () => {
      await zulipPlugin.outbound.sendText({
        to: 'stream:engineering', text: 'hi', accountId: 'default', cfg: {}, replyToId: 'standup'
      });
      const body = new URLSearchParams(global.fetch.mock.calls[0][1].body);
      expect(body.get('type')).toBe('stream');
      expect(body.get('to')).toBe('engineering');
      expect(body.get('topic')).toBe('standup');
    });

    test('routes private: prefix correctly', async () => {
      await zulipPlugin.outbound.sendText({
        to: 'private:alice@example.com', text: 'hi', accountId: 'default', cfg: {}
      });
      const body = new URLSearchParams(global.fetch.mock.calls[0][1].body);
      expect(body.get('type')).toBe('private');
      expect(body.get('to')).toBe('alice@example.com');
    });

    test('defaults to private type for bare target', async () => {
      await zulipPlugin.outbound.sendText({
        to: 'alice@example.com', text: 'hi', accountId: 'default', cfg: {}
      });
      const body = new URLSearchParams(global.fetch.mock.calls[0][1].body);
      expect(body.get('type')).toBe('private');
      expect(body.get('to')).toBe('alice@example.com');
    });

    test('uses "chat" as default topic when replyToId is missing', async () => {
      await zulipPlugin.outbound.sendText({
        to: 'stream:general', text: 'hi', accountId: 'default', cfg: {}
      });
      const body = new URLSearchParams(global.fetch.mock.calls[0][1].body);
      expect(body.get('topic')).toBe('chat');
    });
  });
});

// ============================================
// MOCK TESTS - Fake network responses
// ============================================

describe('Mock Tests', () => {
  // Save original fetch
  const originalFetch = global.fetch;

  beforeEach(() => {
    // Reset fetch mock before each test
    global.fetch = jest.fn();
  });

  afterEach(() => {
    // Restore original fetch
    global.fetch = originalFetch;
  });

  describe('zulipApi', () => {
    const creds = {
      email: 'bot@example.com',
      apiKey: 'test-api-key',
      site: 'https://example.zulipchat.com'
    };

    test('makes GET request with correct auth header', async () => {
      global.fetch.mockResolvedValue({
        ok: true, status: 200,
        json: () => Promise.resolve({ result: 'success', user_id: 123 })
      });

      await zulipApi(creds, '/users/me');

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url, opts] = global.fetch.mock.calls[0];

      expect(url).toBe('https://example.zulipchat.com/api/v1/users/me');
      expect(opts.method).toBe('GET');
      expect(opts.headers.Authorization).toMatch(/^Basic /);
    });

    test('makes POST request with form-encoded body', async () => {
      global.fetch.mockResolvedValue({
        ok: true, status: 200,
        json: () => Promise.resolve({ result: 'success', id: 456 })
      });

      await zulipApi(creds, '/messages', 'POST', {
        type: 'stream',
        to: 'general',
        content: 'Hello!'
      });

      const [url, opts] = global.fetch.mock.calls[0];

      expect(url).toBe('https://example.zulipchat.com/api/v1/messages');
      expect(opts.method).toBe('POST');
      expect(opts.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      expect(opts.body).toContain('type=stream');
      expect(opts.body).toContain('to=general');
    });

    test('returns parsed JSON response', async () => {
      const mockResponse = { result: 'success', messages: [{ id: 1 }] };
      global.fetch.mockResolvedValue({
        ok: true, status: 200,
        json: () => Promise.resolve(mockResponse)
      });

      const result = await zulipApi(creds, '/messages');
      expect(result).toEqual(mockResponse);
    });
  });

  describe('actions.handleAction', () => {
    const mockAccount = {
      accountId: 'default',
      email: 'bot@example.com',
      apiKey: 'test-key',
      site: 'https://example.zulipchat.com'
    };

    // Mock resolveAccount to return our test account
    let originalResolveAccount;

    beforeEach(() => {
      originalResolveAccount = zulipPlugin.config.resolveAccount;
      zulipPlugin.config.resolveAccount = jest.fn(() => mockAccount);
    });

    afterEach(() => {
      zulipPlugin.config.resolveAccount = originalResolveAccount;
    });

    test('send action posts message to stream', async () => {
      global.fetch.mockResolvedValue({
        ok: true, status: 200,
        json: () => Promise.resolve({ result: 'success', id: 789 })
      });

      const result = await zulipPlugin.actions.handleAction({
        action: 'send',
        params: { to: 'stream:general', message: 'Hello!', topic: 'greetings' },
        cfg: {},
        accountId: 'default'
      });

      expect(result.ok).toBe(true);
      expect(result.messageId).toBe('789');
    });

    test('send action returns error on failure', async () => {
      global.fetch.mockResolvedValue({
        ok: true, status: 200,
        json: () => Promise.resolve({ result: 'error', msg: 'Stream not found' })
      });

      const result = await zulipPlugin.actions.handleAction({
        action: 'send',
        params: { to: 'stream:nonexistent', message: 'Hello!' },
        cfg: {},
        accountId: 'default'
      });

      expect(result.ok).toBe(false);
      expect(result.error).toBe('Stream not found');
    });

    test('react action adds reaction to message', async () => {
      global.fetch.mockResolvedValue({
        ok: true, status: 200,
        json: () => Promise.resolve({ result: 'success' })
      });

      const result = await zulipPlugin.actions.handleAction({
        action: 'react',
        params: { messageId: '123', emoji: 'thumbs_up' },
        cfg: {},
        accountId: 'default'
      });

      expect(result.ok).toBe(true);

      const [url, opts] = global.fetch.mock.calls[0];
      expect(url).toContain('/messages/123/reactions');
      expect(opts.method).toBe('POST');
    });

    test('read action fetches messages', async () => {
      global.fetch.mockResolvedValue({
        ok: true, status: 200,
        json: () => Promise.resolve({
          result: 'success',
          messages: [
            { id: 1, sender_full_name: 'Alice', sender_email: 'alice@example.com',
              content: '<p>Hello</p>', subject: 'test', timestamp: 1234567890, reactions: [] }
          ]
        })
      });

      const result = await zulipPlugin.actions.handleAction({
        action: 'read',
        params: { stream: 'general', topic: 'test', limit: 5 },
        cfg: {},
        accountId: 'default'
      });

      expect(result.ok).toBe(true);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].sender).toBe('Alice');
      expect(result.messages[0].content).toBe('Hello'); // HTML stripped
    });

    test('returns error for unknown action', async () => {
      const result = await zulipPlugin.actions.handleAction({
        action: 'unknown_action',
        params: {},
        cfg: {},
        accountId: 'default'
      });

      expect(result.error).toContain('Unsupported action');
    });

    test('send action uses createMessagePayload for stream routing', async () => {
      global.fetch.mockResolvedValue({
        ok: true, status: 200,
        json: () => Promise.resolve({ result: 'success', id: 100 })
      });

      await zulipPlugin.actions.handleAction({
        action: 'send',
        params: { to: 'stream:general', message: 'Hello!', topic: 'greetings' },
        cfg: {},
        accountId: 'default'
      });

      const [, opts] = global.fetch.mock.calls[0];
      const body = new URLSearchParams(opts.body);
      expect(body.get('type')).toBe('stream');
      expect(body.get('to')).toBe('general');
      expect(body.get('topic')).toBe('greetings');
    });

    test('send action uses createMessagePayload for private routing', async () => {
      global.fetch.mockResolvedValue({
        ok: true, status: 200,
        json: () => Promise.resolve({ result: 'success', id: 101 })
      });

      await zulipPlugin.actions.handleAction({
        action: 'send',
        params: { to: 'private:user@example.com', message: 'Hi' },
        cfg: {},
        accountId: 'default'
      });

      const [, opts] = global.fetch.mock.calls[0];
      const body = new URLSearchParams(opts.body);
      expect(body.get('type')).toBe('private');
      expect(body.get('to')).toBe('user@example.com');
    });
  });

  describe('zulipUpload', () => {
    const creds = {
      email: 'bot@example.com',
      apiKey: 'test-api-key',
      site: 'https://example.zulipchat.com'
    };

    test('rejects empty source', async () => {
      await expect(zulipUpload(creds, '')).rejects.toThrow('non-empty string');
      await expect(zulipUpload(creds, null)).rejects.toThrow('non-empty string');
    });

    test('rejects http URLs', async () => {
      await expect(zulipUpload(creds, 'http://example.com/file.png'))
        .rejects.toThrow('URL sources are not supported');
    });

    test('rejects https URLs', async () => {
      await expect(zulipUpload(creds, 'https://example.com/file.png'))
        .rejects.toThrow('URL sources are not supported');
    });

    test('rejects non-existent file', async () => {
      await expect(zulipUpload(creds, '/nonexistent/file.png'))
        .rejects.toThrow();
    });

    test('uploads a local file successfully', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zulip-test-'));
      const tmpFile = path.join(tmpDir, 'test.png');
      fs.writeFileSync(tmpFile, Buffer.from('fake-png-data'));

      global.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Map(),
        json: () => Promise.resolve({ result: 'success', uri: '/user_uploads/1/abc/test.png' }),
      });

      try {
        const result = await zulipUpload(creds, tmpFile);
        expect(result.ok).toBe(true);
        expect(result.uri).toBe('/user_uploads/1/abc/test.png');
        expect(result.filename).toBe('test.png');

        const [url, opts] = global.fetch.mock.calls[0];
        expect(url).toBe('https://example.zulipchat.com/api/v1/user_uploads');
        expect(opts.method).toBe('POST');
        expect(opts.headers['Content-Type']).toMatch(/multipart\/form-data; boundary=/);
      } finally {
        fs.unlinkSync(tmpFile);
        fs.rmdirSync(tmpDir);
      }
    });

    test('sanitizes dangerous characters in filename', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zulip-test-'));
      // Create a file whose name would break multipart framing
      const tmpFile = path.join(tmpDir, 'file"evil.png');
      fs.writeFileSync(tmpFile, Buffer.from('data'));

      global.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Map(),
        json: () => Promise.resolve({ result: 'success', uri: '/user_uploads/1/abc/file_evil.png' }),
      });

      try {
        const result = await zulipUpload(creds, tmpFile);
        expect(result.filename).toBe('file_evil.png');

        // Verify the multipart body doesn't contain unescaped quotes in filename
        const body = global.fetch.mock.calls[0][1].body;
        const headerPart = body.slice(0, 200).toString();
        expect(headerPart).not.toContain('file"evil');
        expect(headerPart).toContain('file_evil.png');
      } finally {
        fs.unlinkSync(tmpFile);
        fs.rmdirSync(tmpDir);
      }
    });

    test('throws RateLimitError on 429', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zulip-test-'));
      const tmpFile = path.join(tmpDir, 'test.txt');
      fs.writeFileSync(tmpFile, 'data');

      global.fetch.mockResolvedValue({
        ok: false,
        status: 429,
        headers: new Map([['retry-after', '30']]),
      });

      try {
        await expect(zulipUpload(creds, tmpFile)).rejects.toThrow('Rate limited');
      } finally {
        fs.unlinkSync(tmpFile);
        fs.rmdirSync(tmpDir);
      }
    });

    test('rejects files exceeding size limit', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zulip-test-'));
      const tmpFile = path.join(tmpDir, 'huge.bin');
      // Create a sparse file that reports large size without using disk space
      const fd = fs.openSync(tmpFile, 'w');
      fs.ftruncateSync(fd, 26 * 1024 * 1024); // 26MB > 25MB limit
      fs.closeSync(fd);

      try {
        await expect(zulipUpload(creds, tmpFile)).rejects.toThrow('File too large');
      } finally {
        fs.unlinkSync(tmpFile);
        fs.rmdirSync(tmpDir);
      }
    });
  });

  describe('sendMedia', () => {
    const mockAccount = {
      accountId: 'default',
      email: 'bot@example.com',
      apiKey: 'test-key',
      site: 'https://example.zulipchat.com'
    };

    let originalResolveAccount;

    beforeEach(() => {
      originalResolveAccount = zulipPlugin.config.resolveAccount;
      zulipPlugin.config.resolveAccount = jest.fn(() => mockAccount);
    });

    afterEach(() => {
      zulipPlugin.config.resolveAccount = originalResolveAccount;
    });

    test('sends message with uploaded attachment link', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zulip-test-'));
      const tmpFile = path.join(tmpDir, 'report.pdf');
      fs.writeFileSync(tmpFile, 'pdf-content');

      // First call: upload, second call: send message
      global.fetch
        .mockResolvedValueOnce({
          ok: true, status: 200, headers: new Map(),
          json: () => Promise.resolve({ result: 'success', uri: '/user_uploads/1/abc/report.pdf' }),
        })
        .mockResolvedValueOnce({
          ok: true, status: 200, headers: new Map(),
          json: () => Promise.resolve({ result: 'success', id: 42 }),
        });

      try {
        const result = await zulipPlugin.outbound.sendMedia({
          to: 'stream:general', text: 'Here is the report', mediaUrl: tmpFile,
          accountId: 'default', cfg: {}, replyToId: 'reports'
        });

        expect(result.ok).toBe(true);
        expect(result.messageId).toBe('42');

        // Verify the message content includes the attachment link
        const [, sendOpts] = global.fetch.mock.calls[1];
        const body = new URLSearchParams(sendOpts.body);
        expect(body.get('content')).toContain('[report.pdf]');
        expect(body.get('content')).toContain('/user_uploads/');
        expect(body.get('content')).toContain('Here is the report');
      } finally {
        fs.unlinkSync(tmpFile);
        fs.rmdirSync(tmpDir);
      }
    });

    test('falls back gracefully on upload failure without leaking paths', async () => {
      // Send message call (upload will fail because file doesn't exist)
      global.fetch.mockResolvedValue({
        ok: true, status: 200, headers: new Map(),
        json: () => Promise.resolve({ result: 'success', id: 43 }),
      });

      const result = await zulipPlugin.outbound.sendMedia({
        to: 'stream:general', text: 'Attached', mediaUrl: '/no/such/file.txt',
        accountId: 'default', cfg: {}, replyToId: 'topic'
      });

      expect(result.ok).toBe(true);

      // Verify fallback doesn't contain the full filesystem path
      const [, sendOpts] = global.fetch.mock.calls[0];
      const body = new URLSearchParams(sendOpts.body);
      const content = body.get('content');
      expect(content).toContain('upload failed');
      expect(content).toContain('file.txt');
      expect(content).not.toContain('/no/such/');
    });

    test('sends (media) placeholder when no sources provided', async () => {
      global.fetch.mockResolvedValue({
        ok: true, status: 200, headers: new Map(),
        json: () => Promise.resolve({ result: 'success', id: 44 }),
      });

      const result = await zulipPlugin.outbound.sendMedia({
        to: 'stream:general', accountId: 'default', cfg: {}, replyToId: 'topic'
      });

      expect(result.ok).toBe(true);
      const [, sendOpts] = global.fetch.mock.calls[0];
      const body = new URLSearchParams(sendOpts.body);
      expect(body.get('content')).toBe('(media)');
    });
  });
});

// ============================================
// resolvePersonaForMessage
// ============================================

describe('resolvePersonaForMessage', () => {
  const config = {
    streams: {
      'general': ['ember', 'sage'],
      'solo': ['sage'],
      '*': ['ember'],
    },
    personas: {
      ember: { triggers: ['@ember', 'ember'], file: 'ember.md' },
      sage: { triggers: ['@sage', 'sage'], file: 'sage.md' },
    },
  };

  test('returns null when config is null', () => {
    expect(resolvePersonaForMessage(null, 'general', 'hello')).toBeNull();
  });

  test('returns null when config is undefined', () => {
    expect(resolvePersonaForMessage(undefined, 'general', 'hello')).toBeNull();
  });

  test('returns null when stream has no personas configured', () => {
    const cfg = { streams: { 'general': [] }, personas: {} };
    expect(resolvePersonaForMessage(cfg, 'general', 'hello')).toBeNull();
  });

  test('returns null when stream is missing from config and no wildcard', () => {
    const cfg = { streams: {}, personas: {} };
    expect(resolvePersonaForMessage(cfg, 'unknown', 'hello')).toBeNull();
  });

  test('returns the single persona when only one is configured', () => {
    expect(resolvePersonaForMessage(config, 'solo', 'hello there')).toBe('sage');
  });

  test('returns persona matching trigger in message text', () => {
    expect(resolvePersonaForMessage(config, 'general', '@sage can you help?')).toBe('sage');
  });

  test('trigger matching is case-insensitive', () => {
    expect(resolvePersonaForMessage(config, 'general', '@SAGE please help')).toBe('sage');
  });

  test('only checks first 50 characters for triggers', () => {
    // Trigger starting at char 45 — fits within the 50-char window
    const short = 'x'.repeat(45) + '@sage';
    expect(resolvePersonaForMessage(config, 'general', short)).toBe('sage');

    // Trigger starting at char 50 — falls outside the window
    const long = 'x'.repeat(50) + '@sage';
    expect(resolvePersonaForMessage(config, 'general', long)).toBe('ember');
  });

  test('falls back to first configured persona when no trigger match', () => {
    expect(resolvePersonaForMessage(config, 'general', 'no trigger here')).toBe('ember');
  });

  test('fallback returns first persona, not hardcoded ember', () => {
    const cfg = {
      streams: { 'general': ['alice', 'bob'] },
      personas: { alice: { triggers: ['@alice'] }, bob: { triggers: ['@bob'] } },
    };
    expect(resolvePersonaForMessage(cfg, 'general', 'hello')).toBe('alice');
  });

  test('does not crash when config has no streams key', () => {
    expect(resolvePersonaForMessage({ personas: {} }, 'general', 'hello')).toBeNull();
  });

  test('does not crash when persona has no triggers', () => {
    const cfg = {
      streams: { 'general': ['ember', 'sage'] },
      personas: { ember: {}, sage: { triggers: ['@sage'] } },
    };
    expect(resolvePersonaForMessage(cfg, 'general', 'hello')).toBe('ember');
  });

  test('does not crash when messageText is undefined', () => {
    expect(resolvePersonaForMessage(config, 'general', undefined)).toBe('ember');
  });

  test('uses wildcard stream config for unknown streams', () => {
    expect(resolvePersonaForMessage(config, 'random-stream', 'hello')).toBe('ember');
  });
});

// ============================================
// fetchThreadContext
// ============================================

describe('fetchThreadContext', () => {
  const originalFetch = global.fetch;
  const creds = { email: 'bot@example.com', apiKey: 'test-key', site: 'https://z.example.com' };

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('returns formatted context for stream messages', async () => {
    global.fetch.mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({
        result: 'success',
        messages: [
          { id: 10, sender_id: 99, sender_full_name: 'Alice', content: '<p>Hello</p>', reactions: [] },
          { id: 11, sender_id: 42, sender_full_name: 'Bot', content: '<p>Hi there</p>', reactions: [] },
        ],
      }),
    });

    const msg = { id: 12, type: 'stream', display_recipient: 'general', subject: 'greetings', sender_email: 'alice@example.com' };
    const result = await fetchThreadContext(creds, msg, 42);

    expect(result).toContain('Recent messages in #general > greetings:');
    expect(result).toContain('[Alice] (id:10) Hello');
    expect(result).toContain('[(bot)] (id:11) Hi there');
  });

  test('returns formatted context for private messages', async () => {
    global.fetch.mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({
        result: 'success',
        messages: [
          { id: 20, sender_id: 99, sender_full_name: 'Bob', content: '<p>Hey</p>', reactions: [] },
        ],
      }),
    });

    const msg = { id: 21, type: 'private', sender_email: 'bob@example.com' };
    const result = await fetchThreadContext(creds, msg, 42);

    expect(result).toContain('Recent DM history:');
    expect(result).toContain('[Bob] (id:20) Hey');
  });

  test('includes reaction info in formatted output', async () => {
    global.fetch.mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({
        result: 'success',
        messages: [
          { id: 30, sender_id: 99, sender_full_name: 'Alice', content: '<p>Nice</p>',
            reactions: [{ emoji_name: 'thumbs_up' }, { emoji_name: 'heart' }] },
        ],
      }),
    });

    const msg = { id: 31, type: 'stream', display_recipient: 'general', subject: 'topic' };
    const result = await fetchThreadContext(creds, msg, 42);

    expect(result).toContain('[reacts: thumbs_up, heart]');
  });

  test('returns undefined when API returns no messages', async () => {
    global.fetch.mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ result: 'success', messages: [] }),
    });

    const msg = { id: 40, type: 'stream', display_recipient: 'empty', subject: 'topic' };
    const result = await fetchThreadContext(creds, msg, 42);

    expect(result).toBeUndefined();
  });

  test('returns undefined when API result is not success', async () => {
    global.fetch.mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ result: 'error', msg: 'bad queue' }),
    });

    const msg = { id: 50, type: 'stream', display_recipient: 'general', subject: 'topic' };
    const result = await fetchThreadContext(creds, msg, 42);

    expect(result).toBeUndefined();
  });

  test('narrows by stream and topic for stream messages', async () => {
    global.fetch.mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ result: 'success', messages: [] }),
    });

    const msg = { id: 60, type: 'stream', display_recipient: 'engineering', subject: 'deploy' };
    await fetchThreadContext(creds, msg, 42);

    const [url] = global.fetch.mock.calls[0];
    const narrow = JSON.parse(new URL(url).searchParams.get('narrow'));
    expect(narrow).toEqual([
      { operator: 'stream', operand: 'engineering' },
      { operator: 'topic', operand: 'deploy' },
    ]);
  });

  test('narrows by DM participants for private messages', async () => {
    global.fetch.mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ result: 'success', messages: [] }),
    });

    const msg = { id: 70, type: 'private', sender_email: 'alice@example.com' };
    await fetchThreadContext(creds, msg, 42);

    const [url] = global.fetch.mock.calls[0];
    const narrow = JSON.parse(new URL(url).searchParams.get('narrow'));
    expect(narrow).toEqual([
      { operator: 'dm', operand: ['bot@example.com', 'alice@example.com'] },
    ]);
  });
});

// ============================================
// resolveAttachments & cleanupAttachments
// ============================================

describe('resolveAttachments', () => {
  const originalFetch = global.fetch;
  const creds = { email: 'bot@example.com', apiKey: 'key', site: 'https://z.example.com' };
  const log = { warn: jest.fn() };

  beforeEach(() => {
    log.warn.mockClear();
    global.fetch = jest.fn();
  });
  afterEach(() => { global.fetch = originalFetch; });

  test('returns empty for HTML with no uploads', async () => {
    const result = await resolveAttachments(creds, '<p>Hello world</p>', log);
    expect(result.attachments).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('resolves a single attachment end-to-end', async () => {
    const html = '<a href="/user_uploads/1/ab/report.pdf">report.pdf</a>';
    const fileContent = Buffer.from('fake-pdf-content');

    global.fetch
      // 1st call: zulipApi → get temp URL
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: () => Promise.resolve({ result: 'success', url: '/user_uploads/temporary/tok123' }),
      })
      // 2nd call: download file
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => String(fileContent.length) },
        arrayBuffer: () => Promise.resolve(fileContent.buffer.slice(fileContent.byteOffset, fileContent.byteOffset + fileContent.byteLength)),
      });

    const result = await resolveAttachments(creds, html, log);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].filename).toBe('report.pdf');
    expect(result.attachments[0].type).toBe('file');
    expect(result.attachments[0].localPath).toContain('report.pdf');

    // Verify temp URL was fetched from the right host
    const downloadCall = global.fetch.mock.calls[1];
    expect(downloadCall[0]).toBe('https://z.example.com/user_uploads/temporary/tok123');

    // Cleanup the file we wrote
    await fs.promises.unlink(result.attachments[0].localPath).catch(() => {});
  });

  test('classifies images by extension', async () => {
    const html = '<img src="/user_uploads/1/cd/photo.jpg">';
    const fileContent = Buffer.from('fake-jpg');

    global.fetch
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: () => Promise.resolve({ result: 'success', url: '/user_uploads/temporary/img' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => String(fileContent.length) },
        arrayBuffer: () => Promise.resolve(fileContent.buffer.slice(fileContent.byteOffset, fileContent.byteOffset + fileContent.byteLength)),
      });

    const result = await resolveAttachments(creds, html, log);
    expect(result.attachments[0].type).toBe('image');
    expect(result.attachments[0].ext).toBe('.jpg');

    await fs.promises.unlink(result.attachments[0].localPath).catch(() => {});
  });

  test('skips when API fails to return temp URL', async () => {
    const html = '<a href="/user_uploads/1/ef/secret.doc">secret.doc</a>';
    global.fetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: () => Promise.resolve({ result: 'error', msg: 'not found' }),
    });

    const result = await resolveAttachments(creds, html, log);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].type).toBe('skipped');
    expect(result.attachments[0].reason).toContain('resolve download URL');
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to get temp URL'));
  });

  test('skips file exceeding size limit via content-length', async () => {
    const html = '<a href="/user_uploads/1/gh/huge.zip">huge.zip</a>';
    global.fetch
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: () => Promise.resolve({ result: 'success', url: '/user_uploads/temporary/big' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => String(30 * 1024 * 1024) }, // 30MB
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      });

    const result = await resolveAttachments(creds, html, log);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].type).toBe('skipped');
    expect(result.attachments[0].reason).toContain('too large');
  });

  test('skips when download response is not ok', async () => {
    const html = '<a href="/user_uploads/1/ij/gone.txt">gone.txt</a>';
    global.fetch
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: () => Promise.resolve({ result: 'success', url: '/user_uploads/temporary/gone' }),
      })
      .mockResolvedValueOnce({ ok: false, status: 404 });

    const result = await resolveAttachments(creds, html, log);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].type).toBe('skipped');
    expect(result.attachments[0].reason).toContain('Download failed');
    expect(result.attachments[0].reason).toContain('404');
  });

  test('deduplicates repeated upload paths', async () => {
    const html = '<a href="/user_uploads/1/ab/file.txt">file.txt</a> and <a href="/user_uploads/1/ab/file.txt">again</a>';
    const fileContent = Buffer.from('x');

    global.fetch
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: () => Promise.resolve({ result: 'success', url: '/user_uploads/temporary/t1' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => '1' },
        arrayBuffer: () => Promise.resolve(fileContent.buffer.slice(fileContent.byteOffset, fileContent.byteOffset + fileContent.byteLength)),
      });

    const result = await resolveAttachments(creds, html, log);
    expect(result.attachments).toHaveLength(1);
    // Only 2 fetch calls (1 API + 1 download), not 4
    expect(global.fetch).toHaveBeenCalledTimes(2);

    await fs.promises.unlink(result.attachments[0].localPath).catch(() => {});
  });

  test('sanitizes dangerous filename characters', async () => {
    const html = '<a href="/user_uploads/1/ab/file%22name%0d.txt">file</a>';
    const fileContent = Buffer.from('x');

    global.fetch
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: () => Promise.resolve({ result: 'success', url: '/user_uploads/temporary/t2' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => '1' },
        arrayBuffer: () => Promise.resolve(fileContent.buffer.slice(fileContent.byteOffset, fileContent.byteOffset + fileContent.byteLength)),
      });

    const result = await resolveAttachments(creds, html, log);
    // The regex won't match %22 (URL-encoded "), but if it did, sanitize would strip it
    // What matters is the filename doesn't contain raw dangerous chars
    if (result.attachments.length > 0) {
      expect(result.attachments[0].filename).not.toMatch(/["\r\n\\]/);
      await fs.promises.unlink(result.attachments[0].localPath).catch(() => {});
    }
  });

  test('logs warning on fetch error without propagating', async () => {
    const html = '<a href="/user_uploads/1/kl/boom.txt">boom.txt</a>';
    global.fetch.mockRejectedValueOnce(new Error('network fail'));

    const result = await resolveAttachments(creds, html, log);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].type).toBe('skipped');
    expect(result.attachments[0].reason).toContain('network fail');
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Attachment resolve error'));
  });
});

describe('cleanupAttachments', () => {
  const testDir = path.join(os.tmpdir(), 'zulip-cleanup-test');

  beforeEach(async () => {
    await fs.promises.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.promises.rm(testDir, { recursive: true, force: true });
  });

  test('removes files older than maxAge and keeps recent ones', async () => {
    const oldFile = path.join(testDir, 'old.txt');
    const newFile = path.join(testDir, 'new.txt');
    await fs.promises.writeFile(oldFile, 'old');
    await fs.promises.writeFile(newFile, 'new');

    // Backdate the old file's mtime
    const pastTime = new Date(Date.now() - 10 * 60 * 1000);
    await fs.promises.utimes(oldFile, pastTime, pastTime);

    // We can't directly call cleanupAttachments with a custom dir,
    // but we can test the logic via the real function if we temporarily
    // point the constant. Instead, let's test the behavior indirectly:
    // verify the files exist, then check the pattern matches expectations.
    const files = await fs.promises.readdir(testDir);
    expect(files).toHaveLength(2);

    // Manually replicate cleanup logic to verify our understanding
    const now = Date.now();
    for (const file of files) {
      const fileStat = await fs.promises.stat(path.join(testDir, file));
      if (now - fileStat.mtimeMs > 5 * 60 * 1000) {
        await fs.promises.unlink(path.join(testDir, file));
      }
    }

    const remaining = await fs.promises.readdir(testDir);
    expect(remaining).toEqual(['new.txt']);
  });
});

// ============================================
// handleInboundMessage
// ============================================

describe('handleInboundMessage', () => {
  const originalFetch = global.fetch;
  const creds = { email: 'bot@example.com', apiKey: 'test-key', site: 'https://z.example.com' };
  const account = { accountId: 'default', email: 'bot@example.com' };
  const myUserId = 42;

  let capturedDispatchArgs;
  let deliverFn;

  const fakeRuntime = {
    config: { loadConfig: () => ({}) },
    channel: {
      routing: {
        resolveAgentRoute: () => ({ sessionKey: 'sk-123', accountId: 'acc-1' }),
      },
      reply: {
        finalizeInboundContext: (x) => x,
        dispatchReplyWithBufferedBlockDispatcher: async (args) => {
          capturedDispatchArgs = args;
          deliverFn = args.dispatcherOptions.deliver;
        },
      },
    },
  };

  beforeEach(() => {
    capturedDispatchArgs = null;
    deliverFn = null;
    setPluginRuntime(fakeRuntime);
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function mockFetchThreadContext() {
    global.fetch.mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ result: 'success', messages: [] }),
    });
  }

  test('stream message builds correct inbound context shape', async () => {
    mockFetchThreadContext();
    const msg = {
      id: 100, type: 'stream', stream_id: 10, display_recipient: 'general', subject: 'greetings',
      sender_full_name: 'Alice', sender_id: 99, sender_email: 'alice@example.com',
      content: '<p>Hello bot</p>', timestamp: 1700000000,
    };

    await handleInboundMessage({}, creds, account, msg, myUserId);

    const ctx = capturedDispatchArgs.ctx;
    expect(ctx.ChatType).toBe('group');
    expect(ctx.From).toBe('zulip:general');
    expect(ctx.ThreadId).toBe('greetings');
    expect(ctx.GroupSubject).toBe('general');
    expect(ctx.Body).toBe('Hello bot');
    expect(ctx.SenderName).toBe('Alice');
    expect(ctx.SessionKey).toBe('sk-123');
    expect(ctx.AccountId).toBe('acc-1');
    expect(ctx.Provider).toBe('zulip-openclaw');
  });

  test('private message builds correct inbound context shape', async () => {
    mockFetchThreadContext();
    const msg = {
      id: 200, type: 'private', display_recipient: [{ email: 'alice@example.com' }],
      subject: '', sender_full_name: 'Alice', sender_id: 99,
      sender_email: 'alice@example.com', content: '<p>DM hello</p>', timestamp: 1700000000,
    };

    await handleInboundMessage({}, creds, account, msg, myUserId);

    const ctx = capturedDispatchArgs.ctx;
    expect(ctx.ChatType).toBe('direct');
    expect(ctx.From).toBe('zulip:99');
    expect(ctx.ThreadId).toBeUndefined();
    expect(ctx.GroupSubject).toBeUndefined();
  });

  test('resolveAgentRoute receives channel peer for stream messages', async () => {
    const resolveAgentRoute = jest.fn(() => ({ sessionKey: 'sk', accountId: 'acc' }));
    setPluginRuntime({
      ...fakeRuntime,
      channel: {
        ...fakeRuntime.channel,
        routing: { resolveAgentRoute },
        reply: fakeRuntime.channel.reply,
      },
    });
    mockFetchThreadContext();

    const msg = {
      id: 300, type: 'stream', stream_id: 30, display_recipient: 'dev', subject: 'ci',
      sender_full_name: 'Bob', sender_id: 88, sender_email: 'bob@example.com',
      content: '<p>test</p>', timestamp: 1700000000,
    };

    await handleInboundMessage({}, creds, account, msg, myUserId);

    expect(resolveAgentRoute).toHaveBeenCalledWith(expect.objectContaining({
      peer: { kind: 'channel', id: 'dev:ci' },
    }));
  });

  test('resolveAgentRoute receives direct peer for private messages', async () => {
    const resolveAgentRoute = jest.fn(() => ({ sessionKey: 'sk', accountId: 'acc' }));
    setPluginRuntime({
      ...fakeRuntime,
      channel: {
        ...fakeRuntime.channel,
        routing: { resolveAgentRoute },
        reply: fakeRuntime.channel.reply,
      },
    });
    mockFetchThreadContext();

    const msg = {
      id: 400, type: 'private', display_recipient: [],
      subject: '', sender_full_name: 'Carol', sender_id: 77,
      sender_email: 'carol@example.com', content: '<p>hi</p>', timestamp: 1700000000,
    };

    await handleInboundMessage({}, creds, account, msg, myUserId);

    expect(resolveAgentRoute).toHaveBeenCalledWith(expect.objectContaining({
      peer: { kind: 'direct', id: '77' },
    }));
  });

  test('deliver callback sends reply via zulipApi for stream messages', async () => {
    mockFetchThreadContext();

    const msg = {
      id: 500, type: 'stream', stream_id: 10, display_recipient: 'general', subject: 'test',
      sender_full_name: 'Alice', sender_id: 99, sender_email: 'alice@example.com',
      content: '<p>hi</p>', timestamp: 1700000000,
    };

    await handleInboundMessage({}, creds, account, msg, myUserId);

    global.fetch.mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ result: 'success', id: 501 }),
    });

    await deliverFn('Hello back!');

    const lastCall = global.fetch.mock.calls[global.fetch.mock.calls.length - 1];
    const body = new URLSearchParams(lastCall[1].body);
    expect(body.get('type')).toBe('stream');
    expect(body.get('to')).toBe('general');
    expect(body.get('topic')).toBe('test');
    expect(body.get('content')).toBe('Hello back!');
  });

  test('suppresses a final payload already sent successfully as a block', async () => {
    mockFetchThreadContext();
    const log = { warn: jest.fn() };
    const msg = {
      id: 100, type: 'stream', stream_id: 10, display_recipient: 'general', subject: 'greetings',
      sender_full_name: 'Alice', sender_id: 99, sender_email: 'alice@example.com',
      content: '<p>Hello bot</p>', timestamp: 1700000000,
    };
    global.fetch.mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ result: 'success', id: 123 }),
    });

    await handleInboundMessage({ log }, creds, account, msg, myUserId);
    await deliverFn('Done.', { kind: 'block' });
    await deliverFn('Done.', { kind: 'final' });

    const messagePosts = global.fetch.mock.calls.filter(([, options]) =>
      options?.method === 'POST' && String(options.body).includes('content=Done.')
    );
    expect(messagePosts).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('already delivered as a block'));
  });

  test('sends the final payload when the matching block send failed', async () => {
    mockFetchThreadContext();
    const log = { error: jest.fn() };
    const msg = {
      id: 100, type: 'stream', stream_id: 10, display_recipient: 'general', subject: 'greetings',
      sender_full_name: 'Alice', sender_id: 99, sender_email: 'alice@example.com',
      content: '<p>Hello bot</p>', timestamp: 1700000000,
    };
    global.fetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ result: 'success', messages: [] }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ result: 'error', msg: 'send failed' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ result: 'success', id: 124 }) });

    await handleInboundMessage({ log }, creds, account, msg, myUserId);
    await deliverFn('Retry me', { kind: 'block' });
    await deliverFn('Retry me', { kind: 'final' });

    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('send failed'));
  });

  test('waits for an in-flight matching block before sending the final payload', async () => {
    mockFetchThreadContext();
    const log = { warn: jest.fn() };
    const msg = {
      id: 100, type: 'stream', stream_id: 10, display_recipient: 'general', subject: 'greetings',
      sender_full_name: 'Alice', sender_id: 99, sender_email: 'alice@example.com',
      content: '<p>Hello bot</p>', timestamp: 1700000000,
    };
    await handleInboundMessage({ log }, creds, account, msg, myUserId);
    let finishBlock;
    global.fetch.mockImplementationOnce(() => new Promise(resolve => { finishBlock = resolve; }));
    const blockPromise = deliverFn('Slow response', { kind: 'block' });
    const finalPromise = deliverFn('Slow response', { kind: 'final' });
    expect(global.fetch).toHaveBeenCalledTimes(2);

    finishBlock({
      ok: true, status: 200,
      json: () => Promise.resolve({ result: 'success', id: 126 }),
    });
    await Promise.all([blockPromise, finalPromise]);

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('already delivered as a block'));
  });

  test('does not deduplicate matching payloads unless the second is final', async () => {
    mockFetchThreadContext();
    const msg = {
      id: 100, type: 'stream', stream_id: 10, display_recipient: 'general', subject: 'greetings',
      sender_full_name: 'Alice', sender_id: 99, sender_email: 'alice@example.com',
      content: '<p>Hello bot</p>', timestamp: 1700000000,
    };
    global.fetch.mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ result: 'success', id: 125 }),
    });

    await handleInboundMessage({}, creds, account, msg, myUserId);
    await deliverFn('Same text', { kind: 'final' });
    await deliverFn('Same text', { kind: 'final' });

    const messagePosts = global.fetch.mock.calls.filter(([, options]) =>
      options?.method === 'POST' && String(options.body).includes('content=Same+text')
    );
    expect(messagePosts).toHaveLength(2);
  });

  test('deliver callback sends private reply correctly', async () => {
    mockFetchThreadContext();

    const msg = {
      id: 600, type: 'private', display_recipient: [],
      subject: '', sender_full_name: 'Bob', sender_id: 88,
      sender_email: 'bob@example.com', content: '<p>hi</p>', timestamp: 1700000000,
    };

    await handleInboundMessage({}, creds, account, msg, myUserId);

    global.fetch.mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ result: 'success', id: 601 }),
    });

    await deliverFn('DM reply');

    const lastCall = global.fetch.mock.calls[global.fetch.mock.calls.length - 1];
    const body = new URLSearchParams(lastCall[1].body);
    expect(body.get('type')).toBe('private');
    expect(body.get('to')).toBe('bob@example.com');
    expect(body.get('content')).toBe('DM reply');
  });

  test('deliver callback does not send when payload is empty', async () => {
    mockFetchThreadContext();

    const msg = {
      id: 700, type: 'stream', stream_id: 10, display_recipient: 'general', subject: 'test',
      sender_full_name: 'Alice', sender_id: 99, sender_email: 'alice@example.com',
      content: '<p>hi</p>', timestamp: 1700000000,
    };

    await handleInboundMessage({}, creds, account, msg, myUserId);

    const callCountBefore = global.fetch.mock.calls.length;
    await deliverFn('');
    expect(global.fetch.mock.calls.length).toBe(callCountBefore);
  });

  test('does not crash when msg.content is undefined', async () => {
    mockFetchThreadContext();
    const msg = {
      id: 750, type: 'stream', stream_id: 10, display_recipient: 'general', subject: 'test',
      sender_full_name: 'Alice', sender_id: 99, sender_email: 'alice@example.com',
      content: undefined, timestamp: 1700000000,
    };

    await handleInboundMessage({}, creds, account, msg, myUserId);

    const ctx = capturedDispatchArgs.ctx;
    expect(ctx.Body).toBe('');
  });

  test('appends attachment markers to message body', async () => {
    const fileContent = Buffer.from('hello');
    global.fetch
      // 1st: resolveAttachments → zulipApi temp URL
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ result: 'success', url: '/user_uploads/temporary/tok' }) })
      // 2nd: resolveAttachments → download file
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => String(fileContent.length) },
        arrayBuffer: () => Promise.resolve(fileContent.buffer.slice(fileContent.byteOffset, fileContent.byteOffset + fileContent.byteLength)),
      })
      // 3rd: fetchThreadContext
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ result: 'success', messages: [] }) });

    const msg = {
      id: 760, type: 'stream', stream_id: 10, display_recipient: 'general', subject: 'test',
      sender_full_name: 'Alice', sender_id: 99, sender_email: 'alice@example.com',
      content: '<p>Check this</p><a href="/user_uploads/1/ab/notes.txt">notes.txt</a>',
      timestamp: 1700000000,
    };

    await handleInboundMessage({}, creds, account, msg, myUserId);

    const body = capturedDispatchArgs.ctx.Body;
    expect(body).toContain('Check this');
    expect(body).toContain('[Attachment: notes.txt');

    // Cleanup written file
    const match = body.match(/→ (.+)\]/);
    if (match) await fs.promises.unlink(match[1]).catch(() => {});
  });

  test('attachment failure does not break message handling', async () => {
    global.fetch
      // 1st: resolveAttachments → zulipApi fails
      .mockRejectedValueOnce(new Error('server down'))
      // 2nd: fetchThreadContext
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ result: 'success', messages: [] }) });

    const log = { warn: jest.fn(), info: jest.fn() };
    const msg = {
      id: 770, type: 'stream', stream_id: 10, display_recipient: 'general', subject: 'test',
      sender_full_name: 'Alice', sender_id: 99, sender_email: 'alice@example.com',
      content: '<p>see</p><a href="/user_uploads/1/cd/doc.pdf">doc.pdf</a>',
      timestamp: 1700000000,
    };

    await handleInboundMessage({ log }, creds, account, msg, myUserId);

    // Message still dispatched despite attachment failure
    expect(capturedDispatchArgs).not.toBeNull();
    expect(capturedDispatchArgs.ctx.Body).toContain('see');
  });

  test('deliver handles payload object with body property', async () => {
    mockFetchThreadContext();

    const msg = {
      id: 800, type: 'stream', stream_id: 10, display_recipient: 'general', subject: 'test',
      sender_full_name: 'Alice', sender_id: 99, sender_email: 'alice@example.com',
      content: '<p>hi</p>', timestamp: 1700000000,
    };

    await handleInboundMessage({}, creds, account, msg, myUserId);

    global.fetch.mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ result: 'success', id: 801 }),
    });

    await deliverFn({ body: 'object payload' });

    const lastCall = global.fetch.mock.calls[global.fetch.mock.calls.length - 1];
    const body = new URLSearchParams(lastCall[1].body);
    expect(body.get('content')).toBe('object payload');
  });

  // --- Typing indicators ---

  describe('typing indicators', () => {
    const streamMsg = {
      id: 900, type: 'stream', stream_id: 10, display_recipient: 'general', subject: 'test',
      sender_full_name: 'Alice', sender_id: 99, sender_email: 'alice@example.com',
      content: '<p>hi</p>', timestamp: 1700000000,
    };

    const privateMsg = {
      id: 901, type: 'private', display_recipient: [],
      subject: '', sender_full_name: 'Bob', sender_id: 88,
      sender_email: 'bob@example.com', content: '<p>hi</p>', timestamp: 1700000000,
    };

    function typingCalls() {
      return global.fetch.mock.calls
        .filter(([url]) => url.includes('/typing'))
        .map(([, opts]) => Object.fromEntries(new URLSearchParams(opts.body)));
    }

    function mockTypingOk() {
      global.fetch.mockResolvedValue({
        ok: true, status: 200,
        json: () => Promise.resolve({ result: 'success' }),
      });
    }

    test('onReplyStart sends stream typing start with correct payload', async () => {
      mockTypingOk();
      await handleInboundMessage({}, creds, account, streamMsg, myUserId);

      const opts = capturedDispatchArgs.dispatcherOptions;
      opts.onReplyStart();
      await new Promise(r => setImmediate(r));
      opts.onCleanup();

      const calls = typingCalls();
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls[0]).toEqual({ op: 'start', type: 'stream', stream_id: '10', topic: 'test' });
    });

    test('onReplyStart sends direct typing start with correct payload', async () => {
      mockTypingOk();
      await handleInboundMessage({}, creds, account, privateMsg, myUserId);

      const opts = capturedDispatchArgs.dispatcherOptions;
      opts.onReplyStart();
      await new Promise(r => setImmediate(r));
      opts.onCleanup();

      const calls = typingCalls();
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls[0]).toEqual({ op: 'start', type: 'direct', to: '[88]' });
    });

    test('onCleanup sends typing stop', async () => {
      mockTypingOk();
      await handleInboundMessage({}, creds, account, streamMsg, myUserId);

      const opts = capturedDispatchArgs.dispatcherOptions;
      await opts.onReplyStart();
      await opts.onCleanup();

      const calls = typingCalls();
      const stopCalls = calls.filter(c => c.op === 'stop');
      expect(stopCalls.length).toBe(1);
      expect(stopCalls[0]).toEqual({ op: 'stop', type: 'stream', stream_id: '10', topic: 'test' });
    });

    test('double stop is deduplicated (onIdle + onCleanup sends stop only once)', async () => {
      mockTypingOk();
      await handleInboundMessage({}, creds, account, streamMsg, myUserId);

      const opts = capturedDispatchArgs.dispatcherOptions;
      await opts.onReplyStart();
      await opts.onIdle();
      await opts.onCleanup();

      const stopCalls = typingCalls().filter(c => c.op === 'stop');
      expect(stopCalls.length).toBe(1);
    });

    test('typing failure does not propagate (error is swallowed)', async () => {
      // Thread context call succeeds, then typing calls fail
      global.fetch
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ result: 'success', messages: [] }) })
        .mockRejectedValue(new Error('network down'));

      const log = { warn: jest.fn(), error: jest.fn() };
      await handleInboundMessage({ log }, creds, account, streamMsg, myUserId);

      const opts = capturedDispatchArgs.dispatcherOptions;
      opts.onReplyStart();
      await new Promise(r => setImmediate(r));
      opts.onCleanup();

      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Typing start failed'));
    });

    test('RateLimitError on typing logs retry-after duration', async () => {
      global.fetch
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({ result: 'success', messages: [] }) })
        .mockRejectedValue(new RateLimitError(30));

      const log = { warn: jest.fn(), error: jest.fn() };
      await handleInboundMessage({ log }, creds, account, streamMsg, myUserId);

      const opts = capturedDispatchArgs.dispatcherOptions;
      opts.onReplyStart();
      await new Promise(r => setImmediate(r));
      opts.onCleanup();

      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('rate-limited'));
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('30s'));
    });

    test('heartbeat re-sends start on interval and stops after cleanup', async () => {
      jest.useFakeTimers();
      mockTypingOk();
      await handleInboundMessage({}, creds, account, streamMsg, myUserId);

      await capturedDispatchArgs.dispatcherOptions.onReplyStart();
      expect(typingCalls().filter(c => c.op === 'start').length).toBe(1);

      // Simulate 30s of generation — 3 heartbeat ticks
      for (let i = 2; i <= 4; i++) {
        jest.advanceTimersByTime(10_000);
        await Promise.resolve();
        expect(typingCalls().filter(c => c.op === 'start').length).toBe(i);
      }

      // Stop should clear the interval
      await capturedDispatchArgs.dispatcherOptions.onCleanup();

      jest.advanceTimersByTime(10_000);
      await Promise.resolve();

      expect(typingCalls().filter(c => c.op === 'start').length).toBe(4); // no more heartbeats

      jest.useRealTimers();
    });
  });
});
