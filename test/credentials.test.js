/**
 * loadCredentials caching
 *
 * Credential presence gates message-tool discovery (describeMessageTool),
 * which the gateway calls while building agent tool schemas — a hot path
 * that must not hit the filesystem on every invocation.
 */

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
}));

const { existsSync, readFileSync } = require('fs');
const { loadCredentials, resetCredentialsCache } = require('../plugin');

const SECRETS = 'ZULIP_EMAIL=bot@x.com\nZULIP_API_KEY=k\nZULIP_SITE=https://x.zulipchat.com\n';

describe('loadCredentials caching', () => {
  beforeEach(() => {
    resetCredentialsCache();
    existsSync.mockReset();
    readFileSync.mockReset();
  });

  test('reads the secrets file once per TTL window', () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(SECRETS);
    const first = loadCredentials();
    const second = loadCredentials();
    expect(first).toEqual({ email: 'bot@x.com', apiKey: 'k', site: 'https://x.zulipchat.com' });
    expect(second).toBe(first);
    expect(readFileSync).toHaveBeenCalledTimes(1);
  });

  test('caches a missing secrets file without re-statting', () => {
    existsSync.mockReturnValue(false);
    expect(loadCredentials()).toBeNull();
    expect(loadCredentials()).toBeNull();
    expect(existsSync).toHaveBeenCalledTimes(1);
  });

  test('resetCredentialsCache forces a fresh read', () => {
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue(SECRETS);
    loadCredentials();
    resetCredentialsCache();
    loadCredentials();
    expect(readFileSync).toHaveBeenCalledTimes(2);
  });
});
