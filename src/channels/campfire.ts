/**
 * Campfire channel — 37signals' self-hosted chat (github.com/basecamp/once-campfire).
 *
 * Native adapter over Campfire's bot API:
 *
 *   Inbound:  Campfire POSTs JSON to the bot's webhook URL for every message in
 *             a DM with the bot, and for messages that @mention the bot in
 *             other rooms. The URL points at the shared webhook server:
 *             http://<host>:<WEBHOOK_PORT>/webhook/campfire?token=<CAMPFIRE_WEBHOOK_TOKEN>
 *             Campfire signs nothing, so the token is the only thing stopping
 *             anyone who can reach the port from posting as any user.
 *   Outbound: POST <CAMPFIRE_URL>/rooms/<roomId>/<botKey>/messages with the
 *             message as the raw request body (HTML is accepted; Markdown is
 *             not rendered, so replies are converted). Files go as multipart
 *             `attachment`, one message per file.
 *
 * Campfire waits only 7 seconds for a webhook response and would post the
 * response body as the reply, so the handler answers 204 at once and replies
 * arrive asynchronously through deliver().
 *
 * Campfire has no threads, typing API for bots or conversation listing.
 *
 * Env (.env): CAMPFIRE_URL, CAMPFIRE_BOT_KEY, CAMPFIRE_WEBHOOK_TOKEN.
 */
import type http from 'http';
import { timingSafeEqual } from 'crypto';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerWebhookHandler } from '../webhook-server.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const CHANNEL = 'campfire';
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Campfire already filters webhooks down to DMs and @mentions, so everything
 * that arrives is meant for the bot: engage on every message in both contexts.
 * The server is invite-only, but unknown senders still need owner approval.
 */
const CAMPFIRE_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

export interface CampfireConfig {
  baseUrl: string;
  botKey: string;
  webhookToken: string;
  fetchImpl?: typeof fetch;
}

/** The subset of Campfire's webhook payload (app/models/webhook.rb) this adapter uses. */
export interface CampfireWebhookPayload {
  user: { id: number; name: string };
  room: { id: number; name: string; path: string };
  message: { id: number; body: { html: string; plain: string }; path: string };
}

export function platformIdForRoom(roomId: number | string): string {
  return `${CHANNEL}:${roomId}`;
}

export function roomIdFromPlatformId(platformId: string): string | null {
  const m = platformId.match(/^campfire:(\d+)$/);
  return m ? m[1] : null;
}

export function parseWebhookPayload(raw: string): CampfireWebhookPayload | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const d = data as Partial<CampfireWebhookPayload> | null;
  if (
    !d ||
    typeof d.user?.id !== 'number' ||
    typeof d.room?.id !== 'number' ||
    typeof d.message?.id !== 'number' ||
    typeof d.message.body?.plain !== 'string'
  ) {
    return null;
  }
  return d as CampfireWebhookPayload;
}

export function toInboundMessage(p: CampfireWebhookPayload, now = new Date()): InboundMessage {
  return {
    id: `campfire-${p.message.id}`,
    kind: 'chat',
    timestamp: now.toISOString(),
    content: {
      text: p.message.body.plain,
      sender: p.user.name,
      senderId: `${CHANNEL}:${p.user.id}`,
      roomName: p.room.name,
    },
    // Campfire only calls the webhook for DMs and mentions of this bot.
    isMention: true,
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inlineMarkdown(s: string): string {
  return s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
}

/**
 * Minimal Markdown → HTML for Campfire's ActionText bodies: fenced code,
 * inline code, bold, italics, links and line breaks. Everything else stays as
 * escaped text, which is what the agent would have shown anyway.
 */
export function markdownToHtml(md: string): string {
  const parts = md.replace(/\r\n/g, '\n').split(/^```[^\n]*\n([\s\S]*?)^```[ \t]*$/m);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return `<pre>${escapeHtml(part.replace(/\n$/, ''))}</pre>`;
      const trimmed = part.replace(/^\n+|\n+$/g, '');
      if (!trimmed) return '';
      return escapeHtml(trimmed)
        .split('\n')
        .map((line) => inlineMarkdown(line))
        .join('<br>');
    })
    .filter(Boolean)
    .join('<br>');
}

function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return null;
}

function tokenMatches(given: string | null, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

export function createCampfireAdapter(cfg: CampfireConfig): ChannelAdapter {
  const baseUrl = cfg.baseUrl.replace(/\/+$/, '');
  const doFetch = cfg.fetchImpl ?? fetch;
  let connected = false;

  function messagesUrl(roomId: string): string {
    return `${baseUrl}/rooms/${roomId}/${cfg.botKey}/messages`;
  }

  async function post(url: string, init: RequestInit): Promise<string | undefined> {
    const res = await doFetch(url, { method: 'POST', ...init });
    if (res.status !== 201) {
      throw new Error(`Campfire post failed: HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
    }
    // 201 Created, empty body, Location: <base>/rooms/:room_id/messages/:id
    const id = res.headers.get('location')?.match(/\/messages\/(\d+)/)?.[1];
    return id;
  }

  async function handleWebhook(config: ChannelSetup, req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url || '/', 'http://localhost');
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method not allowed');
      return;
    }
    if (!tokenMatches(url.searchParams.get('token'), cfg.webhookToken)) {
      log.warn('Campfire: webhook rejected, bad token', { remote: req.socket.remoteAddress });
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Unauthorized');
      return;
    }
    let payload: CampfireWebhookPayload | null;
    try {
      payload = parseWebhookPayload(await readBody(req));
    } catch {
      payload = null;
    }
    if (!payload) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad payload');
      return;
    }
    // Answer before routing: Campfire gives up after 7s and would post any
    // text body as the bot's reply. 204 posts nothing.
    res.writeHead(204);
    res.end();

    const platformId = platformIdForRoom(payload.room.id);
    config.onMetadata(platformId, payload.room.name);
    try {
      await config.onInbound(platformId, null, toInboundMessage(payload));
    } catch (err) {
      log.error('Campfire: onInbound threw', { err, platformId });
    }
  }

  const adapter: ChannelAdapter = {
    name: CHANNEL,
    channelType: CHANNEL,
    supportsThreads: false,
    defaults: CAMPFIRE_DEFAULTS,

    async setup(config: ChannelSetup) {
      registerWebhookHandler(CHANNEL, (req, res) => handleWebhook(config, req, res));
      connected = true;
      log.info('Campfire: adapter ready', { baseUrl });
    },

    async teardown() {
      connected = false;
    },

    isConnected: () => connected,

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage) {
      const roomId = roomIdFromPlatformId(platformId);
      if (!roomId) {
        log.warn('Campfire: deliver to non-campfire platformId ignored', { platformId });
        return undefined;
      }
      const url = messagesUrl(roomId);
      let lastId: string | undefined;

      const text = extractText(message);
      if (text && text.trim()) {
        lastId = await post(url, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
          body: markdownToHtml(text),
        });
      }
      for (const file of message.files ?? []) {
        const form = new FormData();
        form.append('attachment', new Blob([new Uint8Array(file.data)]), file.filename);
        lastId = await post(url, { body: form });
      }
      return lastId;
    },
  };

  return adapter;
}

function createAdapterFromEnv(): ChannelAdapter | null {
  const env = readEnvFile(['CAMPFIRE_URL', 'CAMPFIRE_BOT_KEY', 'CAMPFIRE_WEBHOOK_TOKEN']);
  if (!env.CAMPFIRE_URL || !env.CAMPFIRE_BOT_KEY || !env.CAMPFIRE_WEBHOOK_TOKEN) return null;
  return createCampfireAdapter({
    baseUrl: env.CAMPFIRE_URL,
    botKey: env.CAMPFIRE_BOT_KEY,
    webhookToken: env.CAMPFIRE_WEBHOOK_TOKEN,
  });
}

registerChannelAdapter(CHANNEL, { factory: createAdapterFromEnv, defaults: CAMPFIRE_DEFAULTS });
