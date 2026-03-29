/**
 * Tests for zulip-openclaw plugin
 *
 * Run with: npm test
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { zulipPlugin, zulipApi, zulipUpload } = require('../plugin');

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
