/**
 * Zulip Channel Plugin for OpenClaw
 * 
 * Provides bidirectional Zulip messaging with topic-aware routing,
 * reactions, and persona support.
 */

const { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } = require('fs');
const { readFile, stat } = require('fs/promises');
const { join, extname, basename } = require('path');
const { homedir } = require('os');

const { version } = require('./package.json');
const USER_AGENT = `zulip-openclaw/${version}`;
const MAX_UPLOAD_SIZE_MB = 25;
const MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024;

// --- Plugin Runtime (set during registration) ---

let pluginRuntime = null;

function setPluginRuntime(runtime) {
  pluginRuntime = runtime;
}

function getPluginRuntime() {
  if (!pluginRuntime) throw new Error('Zulip plugin runtime not initialized');
  return pluginRuntime;
}

// --- Credentials ---

function loadCredentials() {
  const secretsPath = join(homedir(), '.openclaw', 'secrets', 'zulip.env');
  if (!existsSync(secretsPath)) return null;

  const content = readFileSync(secretsPath, 'utf-8');
  const creds = {};
  for (const line of content.split('\n')) {
    const [key, ...rest] = line.split('=');
    const value = rest.join('=').trim();
    if (key === 'ZULIP_EMAIL') creds.email = value;
    if (key === 'ZULIP_API_KEY') creds.apiKey = value;
    if (key === 'ZULIP_SITE') creds.site = value;
  }
  return (creds.email && creds.apiKey && creds.site) ? creds : null;
}

// --- Persona Routing (Optional) ---

function loadPersonasConfig() {
  const configPath = join(homedir(), '.openclaw', 'secrets', 'zulip-personas.json');
  if (!existsSync(configPath)) return null;

  try {
    const content = readFileSync(configPath, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    console.warn('[zulip] Failed to parse personas config:', err.message);
    return null;
  }
}

function resolvePersonaForMessage(config, streamName, messageText) {
  if (!config?.streams) return null;

  // Get available personas for this stream (or default)
  const streamPersonas = config.streams[streamName] ?? config.streams['*'] ?? [];
  if (streamPersonas.length === 0) return null;

  // If only one persona for stream, use it
  if (streamPersonas.length === 1) {
    return streamPersonas[0];
  }

  // Check message for persona triggers
  const messageStart = (messageText ?? '').slice(0, 50).toLowerCase();
  for (const personaId of streamPersonas) {
    const persona = config.personas?.[personaId];
    if (!persona?.triggers) continue;

    for (const trigger of persona.triggers) {
      if (messageStart.includes(trigger.toLowerCase())) {
        return personaId;
      }
    }
  }

  // Default to first configured persona when no trigger matches
  return streamPersonas[0];
}

function loadPersonaContent(config, personaId) {
  if (!config || !personaId) return null;

  const persona = config.personas[personaId];
  if (!persona) return null;

  // Expand ~ in personasDir
  const personasDir = config.personasDir.replace(/^~/, homedir());
  const filePath = join(personasDir, persona.file);

  if (!existsSync(filePath)) {
    console.warn(`[zulip] Persona file not found: ${filePath}`);
    return null;
  }

  try {
    return readFileSync(filePath, 'utf-8');
  } catch (err) {
    console.warn(`[zulip] Failed to read persona file: ${err.message}`);
    return null;
  }
}

// --- MIME helpers ---

const MIME_MAP = {
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.mp4':  'video/mp4',
  '.mp3':  'audio/mpeg',
  '.ogg':  'audio/ogg',
  '.pdf':  'application/pdf',
  '.txt':  'text/plain',
};

function guessMimeType(filename) {
  const ext = extname(filename).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

function resolveMessageTarget(to, replyToId) {
  let type = 'private';
  let target = to;
  let topic = replyToId ?? 'chat';

  if (to.startsWith('stream:')) {
    type = 'stream';
    target = to.slice(7);
  } else if (to.startsWith('private:')) {
    target = to.slice(8);
  }

  return { type, target, topic };
}

function createMessagePayload(to, replyToId, content) {
  const { type, target, topic } = resolveMessageTarget(to, replyToId);
  const data = { type, to: target, content };
  if (type === 'stream') data.topic = topic;
  return data;
}

function makeAttachmentLink(site, filename, uri) {
  return `[${filename}](${site}${uri})`;
}

function createUploadBoundary() {
  return `----ZulipUpload${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeFilename(filename) {
  // Strip characters that break multipart Content-Disposition headers
  // or cause issues in downstream file handling: quotes, CRLF, control
  // characters (including null bytes), and backslashes.
  return filename.replace(/["\r\n\\\x00-\x1f\x7f]/g, '_');
}

async function assertLocalFileWithinLimit(source) {
  const fileStat = await stat(source);
  if (fileStat.size > MAX_UPLOAD_SIZE_BYTES) {
    throw new Error(`File too large (${fileStat.size} bytes). Max allowed is ${MAX_UPLOAD_SIZE_MB}MB: ${basename(source)}`);
  }
}

// --- API Client ---

class RateLimitError extends Error {
  constructor(retryAfterSecs) {
    super(`Rate limited, retry after ${retryAfterSecs}s`);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterSecs * 1000;
  }
}

async function zulipApi(creds, endpoint, method = 'GET', data, opts = {}) {
  const url = new URL(`/api/v1${endpoint}`, creds.site);
  const auth = Buffer.from(`${creds.email}:${creds.apiKey}`).toString('base64');
  const headers = { 'Authorization': `Basic ${auth}`, 'User-Agent': USER_AGENT };

  let body;
  if (data && (method === 'POST' || method === 'PATCH' || method === 'DELETE')) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(data).toString();
  }

  const fetchOpts = { method, headers, body };
  if (opts.timeoutMs) {
    fetchOpts.signal = AbortSignal.timeout(opts.timeoutMs);
  }

  const response = await fetch(url.toString(), fetchOpts);

  if (response.status === 429) {
    const retryAfter = parseInt(response.headers.get('retry-after') || '60', 10);
    console.warn(`[zulip] 429 rate limited on ${endpoint}, retry-after=${retryAfter}s`);
    throw new RateLimitError(retryAfter);
  }

  if (!response.ok) {
    const body = await response.text();
    console.warn(`[zulip] HTTP ${response.status} on ${endpoint}: ${body.slice(0, 200)}`);
    throw new Error(`Zulip API error ${response.status} on ${endpoint}`);
  }

  return response.json();
}

// --- File Upload ---

/**
 * Upload a local file to Zulip's /user_uploads endpoint.
 *
 * Accepts a local file path. The caller is responsible for fetching remote
 * content to disk before calling this function — the plugin does not download
 * files on the user's behalf.
 *
 * Returns { ok: true, uri, filename } on success, or throws on failure.
 *
 * The returned `uri` is relative (e.g. `/user_uploads/1/abc/file.png`).
 * Build the full link as: `[filename](${creds.site}${uri})`
 */
async function zulipUpload(creds, source) {
  if (!source || typeof source !== 'string') {
    throw new Error('Upload source must be a non-empty string (local file path)');
  }

  if (source.startsWith('http://') || source.startsWith('https://')) {
    throw new Error('URL sources are not supported. Download the file locally first, then pass the local path.');
  }

  await assertLocalFileWithinLimit(source);
  const buffer = await readFile(source);
  const filename = sanitizeFilename(basename(source));
  const mimeType = guessMimeType(filename);

  // Build multipart/form-data manually — required because Node's native fetch
  // (undici) does not correctly handle Buffer bodies with FormData.
  const boundary = createUploadBoundary();
  const CRLF = '\r\n';
  const head = Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="files[]"; filename="${filename}"${CRLF}` +
    `Content-Type: ${mimeType}${CRLF}${CRLF}`
  );
  const tail = Buffer.from(`${CRLF}--${boundary}--${CRLF}`);
  const body = Buffer.concat([head, buffer, tail]);

  const url = new URL('/api/v1/user_uploads', creds.site);
  const auth = Buffer.from(`${creds.email}:${creds.apiKey}`).toString('base64');

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'User-Agent': USER_AGENT,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
    body,
  });

  if (response.status === 429) {
    const retryAfter = parseInt(response.headers.get('retry-after') || '60', 10);
    throw new RateLimitError(retryAfter);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Zulip upload error ${response.status} for ${filename}: ${text.slice(0, 200)}`);
  }

  const result = await response.json();
  if (result.result !== 'success') throw new Error(`Zulip upload failed: ${result.msg}`);

  return { ok: true, uri: result.uri ?? result.url, filename };
}

// --- Gateway Helpers ---

const CONTEXT_LIMIT = 15;

async function fetchThreadContext(creds, msg, myUserId) {
  const isStream = msg.type === 'stream';
  const contextNarrow = [];
  if (isStream) {
    contextNarrow.push({ operator: 'stream', operand: msg.display_recipient });
    contextNarrow.push({ operator: 'topic', operand: msg.subject });
  } else {
    contextNarrow.push({ operator: 'dm', operand: [creds.email, msg.sender_email] });
  }

  const contextQs = new URLSearchParams({
    narrow: JSON.stringify(contextNarrow),
    num_before: String(CONTEXT_LIMIT),
    num_after: '0',
    anchor: String(msg.id),
  }).toString();

  const contextResult = await zulipApi(creds, `/messages?${contextQs}`);
  if (contextResult.result !== 'success' || !contextResult.messages?.length) {
    return undefined;
  }

  const formatted = contextResult.messages.map(m => {
    const name = m.sender_id === myUserId ? '(bot)' : m.sender_full_name;
    const content = m.content.replace(/<[^>]*>/g, '');
    const reactions = (m.reactions ?? []).map(r => r.emoji_name);
    const reactStr = reactions.length > 0 ? ` [reacts: ${reactions.join(', ')}]` : '';
    return `[${name}] (id:${m.id}) ${content}${reactStr}`;
  }).join('\n');

  const label = isStream
    ? `Recent messages in #${msg.display_recipient} > ${msg.subject}`
    : `Recent DM history`;
  return `${label}:\n${formatted}`;
}

async function handleInboundMessage(ctx, creds, account, msg, myUserId) {
  const isStream = msg.type === 'stream';
  const chatId = isStream
    ? `stream:${msg.display_recipient}`
    : `private:${msg.sender_email}`;
  const from = isStream
    ? `zulip:${msg.display_recipient}`
    : `zulip:${msg.sender_id}`;
  let text = (msg.content ?? '').replace(/<[^>]*>/g, '');

  try {
    cleanupAttachments();
    const { attachments } = await resolveAttachments(creds, msg.content ?? '');
    if (attachments.length > 0) {
      const attachmentLines = attachments.map(a => {
        if (a.type === 'skipped') return `[Attachment: ${a.filename} — ${a.reason}]`;
        return `[Attachment: ${a.filename} → ${a.localPath}]`;
      });
      text = text.trim() + '\n' + attachmentLines.join('\n');
    }
  } catch (attachErr) {
    ctx.log?.warn?.(`[zulip] Attachment resolution failed: ${attachErr.message}`);
  }

  ctx.log?.info?.(`[zulip] Received message from ${msg.sender_full_name} in ${chatId}`);

  // Fetch recent topic/DM context for ThreadStarterBody
  let threadStarterBody;
  try {
    threadStarterBody = await fetchThreadContext(creds, msg, myUserId);
  } catch (err) {
    if (err instanceof RateLimitError) {
      ctx.log?.warn?.(`[zulip] Rate limited fetching context, waiting ${err.retryAfterMs / 1000}s`);
      await new Promise(r => setTimeout(r, err.retryAfterMs));
    } else {
      ctx.log?.warn?.(`[zulip] Failed to fetch context: ${err.message}`);
    }
  }

  // Resolve persona for this message (if config exists)
  let personaContent = null;
  let personaDisplayName = null;
  const personasConfig = loadPersonasConfig();
  if (personasConfig && isStream) {
    const personaId = resolvePersonaForMessage(personasConfig, msg.display_recipient, text);
    if (personaId) {
      personaContent = loadPersonaContent(personasConfig, personaId);
      if (personaContent) {
        const persona = personasConfig.personas[personaId];
        personaDisplayName = persona?.triggers?.[0] ?? personaId;
        ctx.log?.info?.(`[zulip] Using persona: ${personaDisplayName}`);
      }
    }
  }

  // Dispatch through OpenClaw's inbound message system
  const runtime = getPluginRuntime();
  const cfg = runtime.config.loadConfig();

  const peer = isStream
    ? { kind: 'channel', id: `${msg.display_recipient}:${msg.subject}` }
    : { kind: 'direct', id: String(msg.sender_id) };
  const route = runtime.channel.routing.resolveAgentRoute({
    channel: 'zulip-openclaw',
    accountId: account.accountId,
    peer,
    cfg,
  });

  let fullThreadStarterBody = threadStarterBody;
  if (personaContent) {
    const personaSection = `You are responding as this persona:\n---\n${personaContent}\n---\n\nDo not prefix your response with your name — the system will add it automatically.\n\n`;
    fullThreadStarterBody = personaSection + (threadStarterBody ?? '');
  }

  const inboundCtx = runtime.channel.reply.finalizeInboundContext({
    Body: text,
    RawBody: text,
    From: from,
    To: `zulip:${account.email}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isStream ? 'group' : 'direct',
    SenderName: msg.sender_full_name,
    SenderId: String(msg.sender_id),
    SenderUsername: msg.sender_email,
    Provider: 'zulip-openclaw',
    Surface: 'zulip',
    MessageSid: String(msg.id),
    Timestamp: msg.timestamp * 1000,
    ThreadId: isStream ? msg.subject : undefined,
    GroupSubject: isStream ? msg.display_recipient : undefined,
    CommandAuthorized: true,
    ThreadStarterBody: fullThreadStarterBody,
  });

  const replyTarget = isStream ? msg.display_recipient : msg.sender_email;
  const replyType = isStream ? 'stream' : 'private';
  const replyTopic = isStream ? msg.subject : undefined;

  // Zulip typing indicator with heartbeat (server expires after ~15s without refresh)
  const TYPING_HEARTBEAT_MS = 10_000;
  let typingInterval = null;
  let typingStopped = false;

  const sendTypingOp = async (op) => {
    try {
      const typingData = isStream
        ? { op, type: 'stream', stream_id: msg.stream_id, topic: msg.subject }
        : { op, type: 'direct', to: JSON.stringify([msg.sender_id]) };
      await zulipApi(creds, '/typing', 'POST', typingData);
    } catch (err) {
      if (err instanceof RateLimitError) {
        ctx.log?.warn?.(`[zulip] Typing ${op} rate-limited (retry-after ${err.retryAfterMs / 1000}s)`);
      } else {
        ctx.log?.warn?.(`[zulip] Typing ${op} failed: ${err.message}`);
      }
    }
  };

  const startTyping = () => {
    if (typingInterval) return;
    typingStopped = false;
    sendTypingOp('start');
    typingInterval = setInterval(() => sendTypingOp('start'), TYPING_HEARTBEAT_MS);
  };

  const stopTyping = () => {
    if (typingStopped) return;
    typingStopped = true;
    if (typingInterval) { clearInterval(typingInterval); typingInterval = null; }
    sendTypingOp('stop');
  };

  await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: inboundCtx,
    cfg,
    dispatcherOptions: {
      onReplyStart: () => startTyping(),
      onIdle: () => stopTyping(),
      onCleanup: () => stopTyping(),
      deliver: async (payload) => {
        let replyText = typeof payload === 'string' ? payload : (payload.body ?? payload.text ?? '');
        if (!replyText) return;

        if (personaDisplayName) {
          replyText = `[${personaDisplayName}] ${replyText}`;
        }

        const data = { type: replyType, to: replyTarget, content: replyText };
        if (replyTopic) data.topic = replyTopic;

        const sendResult = await zulipApi(creds, '/messages', 'POST', data);
        if (sendResult.result !== 'success') {
          ctx.log?.error?.(`[zulip] Failed to send reply: ${sendResult.msg}`);
        }
      },
      onError: (err) => {
        ctx.log?.error?.(`[zulip] Dispatch error: ${String(err)}`);
      },
    },
  });
}

// --- Attachment Handling (Inbound) ---

const ZULIP_ATTACHMENTS_DIR = join(homedir(), '.openclaw', 'workspace', '.zulip-attachments');
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const MAX_FILE_SIZE_MB = 25;

async function resolveAttachments(creds, htmlContent) {
  const uploadRegex = /\/user_uploads\/([^\s"'<>)]+)/g;
  const matches = [...new Set([...htmlContent.matchAll(uploadRegex)].map(m => m[0]))];

  if (matches.length === 0) return { attachments: [] };

  mkdirSync(ZULIP_ATTACHMENTS_DIR, { recursive: true });
  const attachments = [];

  for (const uploadPath of matches) {
    try {
      const apiResult = await zulipApi(creds, uploadPath);

      if (apiResult.result !== 'success' || !apiResult.url) {
        console.warn(`[zulip] Failed to get temp URL for ${uploadPath}: ${apiResult.msg}`);
        continue;
      }

      const tempUrl = `${creds.site}${apiResult.url}`;
      const filename = uploadPath.split('/').pop() || 'attachment';
      const ext = extname(filename).toLowerCase();
      const timestamp = Date.now();
      const localFilename = `${timestamp}-${filename}`;
      const localPath = join(ZULIP_ATTACHMENTS_DIR, localFilename);

      const response = await fetch(tempUrl);
      if (!response.ok) continue;

      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_FILE_SIZE_MB * 1024 * 1024) {
        attachments.push({ filename, localPath: null, type: 'skipped', reason: `File too large (>${MAX_FILE_SIZE_MB}MB)` });
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_FILE_SIZE_MB * 1024 * 1024) {
        attachments.push({ filename, localPath: null, type: 'skipped', reason: `File too large (>${MAX_FILE_SIZE_MB}MB)` });
        continue;
      }

      writeFileSync(localPath, buffer);
      const type = IMAGE_EXTENSIONS.has(ext) ? 'image' : 'file';
      attachments.push({ filename, localPath, type, ext });
    } catch (err) {
      console.warn(`[zulip] Attachment resolve error: ${err.message}`);
    }
  }

  return { attachments };
}

function cleanupAttachments(maxAgeMs = 5 * 60 * 1000) {
  if (!existsSync(ZULIP_ATTACHMENTS_DIR)) return;
  const now = Date.now();
  for (const file of readdirSync(ZULIP_ATTACHMENTS_DIR)) {
    const filePath = join(ZULIP_ATTACHMENTS_DIR, file);
    try {
      const stat = statSync(filePath);
      if (now - stat.mtimeMs > maxAgeMs) {
        unlinkSync(filePath);
      }
    } catch {
      // ignore cleanup races
    }
  }
}

// --- Channel Plugin Definition ---

const zulipPlugin = {
  id: 'zulip-openclaw',

  meta: {
    id: 'zulip-openclaw',
    label: 'Zulip',
    selectionLabel: 'Zulip (Bot API)',
    docsPath: '/channels/zulip',
    blurb: 'Zulip team chat with topic-aware routing.',
    aliases: ['zulip'],
  },

  capabilities: {
    chatTypes: ['direct', 'channel', 'thread'],
    reactions: true,
    threads: true,   // Zulip topics = threads
    media: true,
    nativeCommands: false,
  },

  config: {
    listAccountIds: (_cfg) => {
      const creds = loadCredentials();
      return creds ? ['default'] : [];
    },

    resolveAccount: (_cfg, accountId) => {
      const creds = loadCredentials();
      if (!creds) return null;
      return {
        accountId: accountId ?? 'default',
        name: 'Zulip Bot',
        email: creds.email,
        apiKey: creds.apiKey,
        site: creds.site,
        enabled: true,
        config: {},
      };
    },

    defaultAccountId: (_cfg) => 'default',

    isConfigured: (account) => Boolean(account?.email && account?.apiKey && account?.site),

    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.email && account.apiKey),
    }),
  },

  messaging: {
    normalizeTarget: (target) => {
      if (!target) return target;
      // Support formats: "stream:general", "private:user@email.com", raw stream name
      if (target.startsWith('stream:') || target.startsWith('private:')) return target;
      return `stream:${target}`;
    },
    targetResolver: {
      looksLikeId: (input) => input.startsWith('stream:') || input.startsWith('private:') || input.includes('@'),
      hint: '<stream:name|private:email>',
    },
  },

  outbound: {
    deliveryMode: 'direct',
    chunker: null,
    textChunkLimit: 10000, // Zulip supports long messages

    sendText: async ({ to, text, accountId, cfg, replyToId }) => {
      const account = zulipPlugin.config.resolveAccount(cfg, accountId);
      if (!account) return { ok: false, error: 'No Zulip account configured' };

      const creds = { email: account.email, apiKey: account.apiKey, site: account.site };

      const data = createMessagePayload(to, replyToId, text);

      const result = await zulipApi(creds, '/messages', 'POST', data);

      if (result.result === 'success') {
        return { channel: 'zulip-openclaw', ok: true, messageId: String(result.id) };
      }
      return { channel: 'zulip-openclaw', ok: false, error: result.msg };
    },

    sendMedia: async ({ to, text, mediaUrl, mediaUrls, accountId, cfg, replyToId }) => {
      const account = zulipPlugin.config.resolveAccount(cfg, accountId);
      if (!account) return { ok: false, error: 'No Zulip account configured' };

      const creds = { email: account.email, apiKey: account.apiKey, site: account.site };

      // Normalise single vs multiple media sources into one list
      const sources = mediaUrls?.length > 0 ? mediaUrls : (mediaUrl ? [mediaUrl] : []);

      // Upload each source and collect Zulip attachment markdown links
      const attachmentLinks = [];
      for (const source of sources) {
        try {
          const { uri, filename } = await zulipUpload(creds, source);
          attachmentLinks.push(makeAttachmentLink(creds.site, filename, uri));
        } catch (err) {
          const safeName = source ? sanitizeFilename(basename(source)) : 'unknown';
          console.warn(`[zulip] sendMedia upload failed for ${safeName}: ${err.message}`);
          // Graceful fallback: note the failure rather than leaking local paths
          attachmentLinks.push(`(upload failed: ${safeName})`);
        }
      }

      const parts = [];
      if (text) parts.push(text);
      if (attachmentLinks.length > 0) parts.push(attachmentLinks.join('\n'));
      const content = parts.join('\n') || '(media)';

      const data = createMessagePayload(to, replyToId, content);

      const result = await zulipApi(creds, '/messages', 'POST', data);
      if (result.result === 'success') {
        return { channel: 'zulip-openclaw', ok: true, messageId: String(result.id) };
      }
      return { channel: 'zulip-openclaw', ok: false, error: result.msg };
    },
  },

  actions: {
    listActions: ({ cfg }) => {
      const accounts = zulipPlugin.config.listAccountIds(cfg);
      if (accounts.length === 0) return [];
      return ['send', 'react', 'reactions', 'read', 'edit', 'delete'];
    },

    handleAction: async ({ action, params, cfg, accountId }) => {
      const account = zulipPlugin.config.resolveAccount(cfg, accountId);
      if (!account) return { error: 'No Zulip account configured' };

      const creds = { email: account.email, apiKey: account.apiKey, site: account.site };

      if (action === 'send') {
        const to = params.to ?? params.target;
        const message = params.message ?? params.content ?? '';
        const replyToId = params.threadId ?? params.topic ?? 'chat';

        const data = createMessagePayload(to, replyToId, message);

        const result = await zulipApi(creds, '/messages', 'POST', data);
        return result.result === 'success'
          ? { ok: true, messageId: String(result.id) }
          : { ok: false, error: result.msg };
      }

      if (action === 'react') {
        const messageId = params.messageId;
        const emoji = params.emoji;
        const remove = params.remove ?? false;

        const method = remove ? 'DELETE' : 'POST';
        const result = await zulipApi(creds, `/messages/${messageId}/reactions`, method, { emoji_name: emoji });
        return { ok: result.result === 'success', error: result.msg };
      }

      if (action === 'reactions') {
        const messageId = params.messageId;
        const result = await zulipApi(creds, `/messages/${messageId}`);
        if (result.result === 'success') {
          const reactions = (result.message?.reactions ?? []).map(r => ({
            emoji: r.emoji_name,
            user: r.user?.full_name ?? 'unknown',
          }));
          return { ok: true, messageId, reactions };
        }
        return { ok: false, error: result.msg };
      }

      if (action === 'read') {
        const stream = params.channelId ?? params.stream;
        const topic = params.topic ?? params.threadId;
        const limit = params.limit ?? 10;

        const narrow = [];
        if (stream) {
          const streamName = stream.startsWith('stream:') ? stream.slice(7) : stream;
          narrow.push({ operator: 'stream', operand: streamName });
        }
        if (topic) narrow.push({ operator: 'topic', operand: topic });

        const queryParams = {
          narrow: JSON.stringify(narrow),
          num_before: String(limit),
          num_after: '0',
          anchor: 'newest',
        };
        const qs = new URLSearchParams(queryParams).toString();
        const result = await zulipApi(creds, `/messages?${qs}`);
        
        if (result.result === 'success') {
          const messages = (result.messages ?? []).reverse().map(m => ({
            id: String(m.id),
            sender: m.sender_full_name,
            senderEmail: m.sender_email,
            content: m.content.replace(/<[^>]*>/g, ''), // strip HTML
            topic: m.subject,
            timestamp: m.timestamp,
            reactions: (m.reactions ?? []).map(r => ({ emoji: r.emoji_name, user: r.user.full_name })),
          }));
          return { ok: true, messages };
        }
        return { ok: false, error: result.msg };
      }

      if (action === 'edit') {
        const messageId = params.messageId;
        const content = params.message ?? params.content;
        const result = await zulipApi(creds, `/messages/${messageId}`, 'PATCH', { content });
        return { ok: result.result === 'success', error: result.msg };
      }

      if (action === 'delete') {
        const messageId = params.messageId;
        const result = await zulipApi(creds, `/messages/${messageId}`, 'DELETE');
        return { ok: result.result === 'success', error: result.msg };
      }

      return { error: `Unsupported action: ${action}` };
    },
  },

  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const creds = { email: account.email, apiKey: account.apiKey, site: account.site };

      ctx.log?.info?.(`[zulip] Starting event poller for ${account.email}`);

      // Register event queue
      const registerResult = await zulipApi(creds, '/register', 'POST', {
        event_types: JSON.stringify(['message', 'reaction']),
      });

      if (registerResult.result !== 'success') {
        ctx.log?.error?.(`[zulip] Failed to register event queue: ${registerResult.msg}`);
        return;
      }

      let queueId = registerResult.queue_id;
      let lastEventId = registerResult.last_event_id;

      // Get our own user ID to filter self-messages
      const meResult = await zulipApi(creds, '/users/me');
      const myUserId = meResult.user_id;

      // Poll loop with 90s timeout (Zulip long-poll typically returns within 60s)
      const POLL_TIMEOUT_MS = 90_000;
      let consecutiveErrors = 0;
      const MAX_CONSECUTIVE_ERRORS = 20; // Give up after sustained failures

      const backoff = (errors) => {
        // Exponential backoff: 5s, 10s, 20s, 40s, capped at 120s
        const ms = Math.min(5000 * Math.pow(2, errors - 1), 120_000);
        ctx.log?.info?.(`[zulip] Backing off for ${ms / 1000}s (error ${errors}/${MAX_CONSECUTIVE_ERRORS})`);
        return new Promise(r => setTimeout(r, ms));
      };

      const reRegister = async () => {
        const reReg = await zulipApi(creds, '/register', 'POST', {
          event_types: JSON.stringify(['message', 'reaction']),
        });
        if (reReg.result === 'success') {
          queueId = reReg.queue_id;
          lastEventId = reReg.last_event_id;
          ctx.log?.info?.('[zulip] Re-registered event queue');
          return true;
        }
        ctx.log?.error?.(`[zulip] Re-registration failed: ${reReg.msg}`);
        return false;
      };

      const poll = async () => {
        while (!ctx.abortSignal?.aborted) {
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            ctx.log?.error?.(`[zulip] Too many consecutive errors (${consecutiveErrors}), stopping poller. Fix the issue and restart the gateway.`);
            return;
          }

          try {
            const qs = `queue_id=${encodeURIComponent(queueId)}&last_event_id=${lastEventId}&dont_block=false`;
            const result = await zulipApi(creds, `/events?${qs}`, 'GET', undefined, { timeoutMs: POLL_TIMEOUT_MS });

            if (result.result !== 'success') {
              consecutiveErrors++;
              if (String(result.msg).includes('BAD_EVENT_QUEUE_ID')) {
                ctx.log?.warn?.('[zulip] Queue expired, re-registering...');
                if (!await reRegister()) {
                  await backoff(consecutiveErrors);
                }
              } else {
                ctx.log?.error?.(`[zulip] Poll failed: ${result.msg}`);
                await backoff(consecutiveErrors);
              }
              continue;
            }

            // Only reset after a genuinely useful response (not just any 200)
            if (consecutiveErrors > 0) {
              ctx.log?.info?.(`[zulip] Poll recovered after ${consecutiveErrors} errors`);
            }
            consecutiveErrors = 0;

            for (const event of result.events) {
              lastEventId = event.id;

              if (event.type === 'message') {
                const msg = event.message;
                if (msg.sender_id === myUserId) continue;

                try {
                  await handleInboundMessage(ctx, creds, account, msg, myUserId);
                } catch (dispatchErr) {
                  if (dispatchErr instanceof RateLimitError) {
                    ctx.log?.warn?.(`[zulip] Rate limited during dispatch, waiting ${dispatchErr.retryAfterMs / 1000}s`);
                    await new Promise(r => setTimeout(r, dispatchErr.retryAfterMs));
                  } else {
                    ctx.log?.error?.(`[zulip] Failed to dispatch message: ${dispatchErr.message}`);
                  }
                }
              }
            }
          } catch (err) {
            if (err.name === 'TimeoutError' || err.name === 'AbortError') {
              // Normal — long-poll timed out with no events, just retry
              continue;
            }
            if (err instanceof RateLimitError) {
              ctx.log?.warn?.(`[zulip] Rate limited, waiting ${err.retryAfterMs / 1000}s`);
              await new Promise(r => setTimeout(r, err.retryAfterMs));
              consecutiveErrors++;
              continue;
            }
            consecutiveErrors++;
            ctx.log?.error?.(`[zulip] Poll error: ${err.message}`);
            await backoff(consecutiveErrors);
          }
        }
        ctx.log?.info?.('[zulip] Poll loop exited');
      };

      // Await the poll loop so the gateway knows when it exits
      await poll();
    },
  },

  status: {
    probeAccount: async ({ account, timeoutMs }) => {
      const creds = { email: account.email, apiKey: account.apiKey, site: account.site };
      try {
        const result = await zulipApi(creds, '/users/me');
        return result.user_id
          ? { ok: true, name: result.full_name }
          : { ok: false, error: result.msg };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
  },
};

// --- Export & Registration ---

module.exports = {
  zulipPlugin, zulipApi, zulipUpload, loadCredentials, setPluginRuntime, RateLimitError,
  // Exported for direct unit testing
  resolvePersonaForMessage, fetchThreadContext, handleInboundMessage,
};
