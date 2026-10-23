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
 * Also over the bot API: PATCH .../messages/:id edits a message the bot posted,
 * and POST .../messages/:id/boosts adds an emoji boost (Campfire's reaction).
 * Cards have no buttons here: ask_question renders as numbered text and a
 * reply naming an option answers it (intercepted before onInbound).
 *
 * Campfire has no threads, typing API for bots, conversation listing or way to
 * create rooms, so openDM only returns DMs the user has already started
 * (learned from inbound webhooks, persisted in DATA_DIR).
 *
 * Env (.env): CAMPFIRE_URL, CAMPFIRE_BOT_KEY, CAMPFIRE_WEBHOOK_TOKEN for the
 * default instance. CAMPFIRE_INSTANCES=a,b adds `campfire-a`, `campfire-b`:
 * CAMPFIRE_BOT_KEY_<NAME> / CAMPFIRE_WEBHOOK_TOKEN_<NAME> (uppercased, dashes
 * to underscores), webhook route /webhook/campfire-<name>. CAMPFIRE_URL is shared.
 */
import type http from 'http';
import { createHash, timingSafeEqual } from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerWebhookHandler } from '../webhook-server.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';
import { normalizeOptions, type NormalizedOption } from './ask-question.js';
import { registerChannelAdapter } from './channel-registry.js';
import { resolveQuestionRender } from './question-render-registry.js';

const CHANNEL = 'campfire';
const MAX_BODY_BYTES = 1024 * 1024;
/**
 * Campfire (app/models/message.rb, an ActionText body in SQLite) enforces no
 * body length; this just keeps one message readable. Long replies split.
 */
const DEFAULT_MAX_TEXT_LENGTH = 8000;

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
  /** Registry key of a named instance (`campfire-<name>`). Omit for the default instance (keyed `campfire`). */
  instanceKey?: string;
  /** Where learned DMs and pending questions persist. Defaults to DATA_DIR. */
  stateDir?: string;
  /** Longest single message in characters before deliver() splits it. */
  maxTextLength?: number;
  /**
   * Looks up a question's render metadata so gateway approvals (which the
   * coordinator resolves itself after authorizing) are not marked resolved
   * on an unauthorized reply. Defaults to the host's registry.
   */
  resolveRender?: (questionId: string) => Promise<{ deferResolution?: boolean } | undefined>;
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

/**
 * Campfire stores an @mention as an ActionText attachment of content type
 * application/vnd.campfire.mention (app/models/user/mentionable.rb), which
 * webhook `body.html` serializes as `<action-text-attachment ... content-type=
 * "application/vnd.campfire.mention" ...>`; the rendered form is
 * `<span class="mention" sgid=...>` (app/views/users/_mention.html.erb).
 * Both are matched, as tags only, so a user typing the text is escaped and
 * does not count.
 */
const MENTION_ATTACHMENT_RE = /<action-text-attachment\b[^>]*application\/vnd\.campfire\.mention/i;
const MENTION_SPAN_RE = /<span\b[^>]*\bclass="mention"/i;

export function hasMention(html: string): boolean {
  return MENTION_ATTACHMENT_RE.test(html) || MENTION_SPAN_RE.test(html);
}

/**
 * Campfire calls the webhook for every message in a DM with the bot, but in
 * other rooms only for messages that @mention it (app/controllers/
 * messages_controller.rb, `bots_eligible_for_webhook`). So a mention marks a
 * group message and its absence marks a DM. Caveat: a DM message that happens
 * to @mention someone else reads as a group message; the adapter corrects for
 * it once the room has delivered a mention-free message (see knownDmRooms).
 */
export function isGroupPayload(p: CampfireWebhookPayload): boolean {
  return hasMention(p.message.body.html ?? '');
}

export function toInboundMessage(
  p: CampfireWebhookPayload,
  now = new Date(),
  isGroup = isGroupPayload(p),
): InboundMessage {
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
    isGroup,
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Characters a Markdown backslash escapes (gateway-approval-presentation emits these). */
const MD_ESCAPABLE = '\\\\`*_{}\\[\\]()#+\\-.!<>~|&';
const MD_ESCAPE_RE = new RegExp(`\\\\([${MD_ESCAPABLE}])`, 'g');
const ESCAPE_OPEN = '';
const ESCAPE_CLOSE = '';

/**
 * Swap backslash escapes outside inline code for private-use placeholders, so
 * `\*` survives the emphasis pass as a literal `*`. Code spans keep their
 * backslashes, as CommonMark has it.
 */
function protectEscapes(line: string): string {
  return line
    .split(/(`[^`\n]+`)/)
    .map((seg, i) =>
      i % 2 === 1
        ? seg
        : seg.replace(MD_ESCAPE_RE, (_m, ch: string) => `${ESCAPE_OPEN}${ch.charCodeAt(0)}${ESCAPE_CLOSE}`),
    )
    .join('');
}

function restoreEscapes(html: string): string {
  return html.replace(new RegExp(`${ESCAPE_OPEN}(\\d+)${ESCAPE_CLOSE}`, 'g'), (_m, code: string) =>
    escapeHtml(String.fromCharCode(Number(code))),
  );
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
 * inline code, bold, italics, links, backslash escapes and line breaks.
 * Everything else stays as escaped text, which is what the agent would have
 * shown anyway.
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
        .map((line) => restoreEscapes(inlineMarkdown(protectEscapes(line))))
        .join('<br>');
    })
    .filter(Boolean)
    .join('<br>');
}

/**
 * Split text into chunks of at most `limit` characters, preferring paragraph,
 * then line, then word boundaries. A fenced code block cut by a split is
 * closed at the end of its chunk and reopened at the start of the next, so
 * each chunk converts to HTML on its own.
 */
export function splitForLimit(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  let reopen = false;
  while (remaining.length > limit) {
    // Leave room for the closing/opening fence lines we may add.
    const room = Math.max(limit - 8, Math.floor(limit / 2));
    let cut = remaining.lastIndexOf('\n\n', room);
    if (cut <= 0) cut = remaining.lastIndexOf('\n', room);
    if (cut <= 0) cut = remaining.lastIndexOf(' ', room);
    if (cut <= 0) cut = room;
    let chunk = remaining.slice(0, cut).trimEnd();
    remaining = remaining.slice(cut).trimStart();
    if (reopen) chunk = `\`\`\`\n${chunk}`;
    const fences = chunk.match(/^```/gm)?.length ?? 0;
    reopen = fences % 2 === 1;
    if (reopen) chunk = `${chunk}\n\`\`\``;
    chunks.push(chunk);
  }
  if (remaining.length > 0) chunks.push(reopen ? `\`\`\`\n${remaining}` : remaining);
  return chunks;
}

/** Common reaction names → the unicode emoji Campfire boosts take. */
const EMOJI_BY_NAME: Record<string, string> = {
  thumbs_up: '👍',
  thumbsup: '👍',
  '+1': '👍',
  thumbs_down: '👎',
  thumbsdown: '👎',
  '-1': '👎',
  heart: '❤️',
  white_check_mark: '✅',
  check: '✅',
  x: '❌',
  eyes: '👀',
  tada: '🎉',
  fire: '🔥',
  rocket: '🚀',
  pray: '🙏',
  ok_hand: '👌',
  smile: '😄',
  laughing: '😆',
  thinking: '🤔',
  warning: '⚠️',
  wave: '👋',
};

/** A name from the table, an emoji passed through as-is, or null for an unknown name. */
export function resolveEmoji(raw: string): string | null {
  const name = raw.trim().replace(/^:|:$/g, '').toLowerCase().replace(/-/g, '_');
  if (!name) return null;
  if (EMOJI_BY_NAME[name]) return EMOJI_BY_NAME[name];
  // Anything with a character outside [a-z0-9_+] is taken to be an emoji already.
  return /^[a-z0-9_+]+$/.test(name) ? null : raw.trim();
}

function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') {
    if (typeof content.markdown === 'string' && content.markdown) return content.markdown;
    if (typeof content.text === 'string') return content.text;
  }
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

/** A question card awaiting a numbered reply in one room. */
interface PendingQuestion {
  questionId: string;
  options: NormalizedOption[];
  messageId?: string;
  title: string;
  question: string;
}

function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function writeJsonFile(file: string, data: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    log.warn('Campfire: could not persist state', { file, err });
  }
}

/** The option a reply picks: its 1-based number, or its label, case-insensitively. */
export function matchOption(options: NormalizedOption[], reply: string): NormalizedOption | null {
  const text = reply.trim();
  const num = text.match(/^(\d{1,3})[.)]?$/);
  if (num) return options[Number(num[1]) - 1] ?? null;
  const lower = text.toLowerCase();
  return options.find((o) => o.label.toLowerCase() === lower) ?? null;
}

/** Title, question and resolution of a settled card, as Markdown. */
function terminalCardMarkdown(title: string, question: string, resolution: string): string {
  return [title && `**${title}**`, question, resolution].filter(Boolean).join('\n\n');
}

function questionCardMarkdown(title: string, question: string, options: NormalizedOption[]): string {
  const list = options.map((o, i) => `${i + 1}. ${o.label}`).join('\n');
  return [`**${title}**`, question, list, 'Reply with a number.'].filter(Boolean).join('\n\n');
}

/** Markdown for a send_card display card when the producer gave no fallbackText. */
function displayCardMarkdown(card: Record<string, unknown>): string {
  const lines: string[] = [];
  if (typeof card.title === 'string' && card.title) lines.push(`**${card.title}**`);
  if (typeof card.description === 'string' && card.description) lines.push(card.description);
  if (Array.isArray(card.children)) {
    for (const child of card.children) {
      if (typeof child === 'string' && child) lines.push(child);
      else if (child && typeof child === 'object' && typeof (child as Record<string, unknown>).text === 'string') {
        lines.push((child as Record<string, string>).text);
      }
    }
  }
  if (Array.isArray(card.actions)) {
    const links = (card.actions as Array<Record<string, unknown> | null | undefined>)
      .filter((a) => a && typeof a.url === 'string' && a.url && typeof a.label === 'string' && a.label)
      .map((a) => `[${a!.label as string}](${a!.url as string})`);
    if (links.length > 0) lines.push(links.join(' | '));
  }
  return lines.join('\n\n');
}

export function createCampfireAdapter(cfg: CampfireConfig): ChannelAdapter {
  const baseUrl = cfg.baseUrl.replace(/\/+$/, '');
  const doFetch = cfg.fetchImpl ?? fetch;
  const instanceKey = cfg.instanceKey ?? CHANNEL;
  const stateDir = cfg.stateDir ?? DATA_DIR;
  const maxTextLength = cfg.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
  const resolveRender = cfg.resolveRender ?? resolveQuestionRender;
  const dmsFile = path.join(stateDir, `campfire-dms-${instanceKey}.json`);
  const pendingFile = path.join(stateDir, `campfire-pending-${instanceKey}.json`);
  let connected = false;

  /** userId → DM roomId, learned from inbound webhooks (the bot API can't create rooms). */
  const dmRoomByUser = new Map<string, string>(Object.entries(readJsonFile<Record<string, string>>(dmsFile) ?? {}));
  /** Rooms known to be DMs: one delivered a message with no mention, which only DMs do. */
  const knownDmRooms = new Set<string>(dmRoomByUser.values());
  const roomNames = new Map<string, string>();
  /** platformId → the latest unanswered question card in that room. */
  const pending = new Map<string, PendingQuestion>(
    Object.entries(readJsonFile<Record<string, PendingQuestion>>(pendingFile) ?? {}),
  );

  const persistDms = () => writeJsonFile(dmsFile, Object.fromEntries(dmRoomByUser));
  const persistPending = () => writeJsonFile(pendingFile, Object.fromEntries(pending));

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

  async function postHtmlText(roomId: string, markdown: string): Promise<string | undefined> {
    return post(messagesUrl(roomId), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: markdownToHtml(markdown),
    });
  }

  /** Text (split to the limit) then files, one message each. Returns the first message's id. */
  async function postText(roomId: string, text: string | null, message: OutboundMessage): Promise<string | undefined> {
    let firstId: string | undefined;
    let posted = false;
    if (text && text.trim()) {
      for (const chunk of splitForLimit(text, maxTextLength)) {
        const id = await postHtmlText(roomId, chunk);
        if (!posted) firstId = id;
        posted = true;
      }
    }
    for (const file of message.files ?? []) {
      const form = new FormData();
      form.append('attachment', new Blob([new Uint8Array(file.data)]), file.filename);
      const id = await post(messagesUrl(roomId), { body: form });
      if (!posted) firstId = id;
      posted = true;
    }
    return firstId;
  }

  async function editMessage(roomId: string, messageId: string, markdown: string): Promise<void> {
    const res = await doFetch(`${messagesUrl(roomId)}/${messageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: markdownToHtml(markdown),
    });
    if (!res.ok) {
      throw new Error(`Campfire edit failed: HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
    }
  }

  async function addBoost(roomId: string, messageId: string, emoji: string): Promise<void> {
    const res = await doFetch(`${messagesUrl(roomId)}/${messageId}/boosts`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: emoji,
    });
    if (res.status !== 201) {
      throw new Error(`Campfire boost failed: HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
    }
  }

  /**
   * A reply that picks an option of the room's pending question answers it
   * instead of reaching the agent. Returns true when it consumed the message.
   */
  async function interceptReply(
    config: ChannelSetup,
    platformId: string,
    roomId: string,
    payload: CampfireWebhookPayload,
  ): Promise<boolean> {
    const question = pending.get(platformId);
    if (!question) return false;
    const option = matchOption(question.options, payload.message.body.plain);
    if (!option) return false;

    // Look up render metadata BEFORE onAction, which may delete the row.
    const render = await (async () => resolveRender(question.questionId))().catch(() => undefined);

    pending.delete(platformId);
    persistPending();
    config.onAction(question.questionId, option.value, `${CHANNEL}:${payload.user.id}`, {
      instance: instanceKey,
      messageId: question.messageId,
      platformId,
    });
    // Gateway approvals update their own card once the decision is authorized.
    if (question.messageId && !render?.deferResolution) {
      const chosen = option.selectedLabel !== option.label ? option.selectedLabel : `✅ ${option.label}`;
      try {
        await editMessage(
          roomId,
          question.messageId,
          terminalCardMarkdown(question.title, question.question, `${chosen} by ${payload.user.name}`),
        );
      } catch (err) {
        log.warn('Campfire: failed to update question card after reply', { err, platformId });
      }
    }
    return true;
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

    const roomId = String(payload.room.id);
    const platformId = platformIdForRoom(roomId);
    const mentioned = hasMention(payload.message.body.html ?? '');
    // Only DMs deliver mention-free messages, so one proves the room is a DM.
    if (!mentioned && !knownDmRooms.has(roomId)) {
      knownDmRooms.add(roomId);
    }
    const isGroup = mentioned && !knownDmRooms.has(roomId);
    if (!isGroup && dmRoomByUser.get(String(payload.user.id)) !== roomId) {
      dmRoomByUser.set(String(payload.user.id), roomId);
      persistDms();
    }
    roomNames.set(roomId, payload.room.name);
    config.onMetadata(platformId, payload.room.name, isGroup);
    try {
      if (await interceptReply(config, platformId, roomId, payload)) return;
      await config.onInbound(platformId, null, toInboundMessage(payload, new Date(), isGroup));
    } catch (err) {
      log.error('Campfire: onInbound threw', { err, platformId });
    }
  }

  const adapter: ChannelAdapter = {
    name: instanceKey,
    channelType: CHANNEL,
    ...(cfg.instanceKey ? { instance: cfg.instanceKey } : {}),
    supportsThreads: false,
    defaults: CAMPFIRE_DEFAULTS,

    async setup(config: ChannelSetup) {
      registerWebhookHandler(instanceKey, (req, res) => handleWebhook(config, req, res));
      connected = true;
      log.info('Campfire: adapter ready', { baseUrl, instance: instanceKey });
    },

    async teardown() {
      connected = false;
    },

    isConnected: () => connected,

    async resolveChannelName(platformId: string) {
      const roomId = roomIdFromPlatformId(platformId);
      return (roomId && roomNames.get(roomId)) || null;
    },

    /**
     * The bot API can't create rooms, so this only returns a DM the user has
     * already opened with the bot (learned from their messages). Throwing
     * makes ensureUserDm treat the user as unreachable.
     */
    async openDM(userHandle: string) {
      const userId = userHandle.replace(/^campfire:/, '');
      const roomId = dmRoomByUser.get(userId);
      if (!roomId) {
        throw new Error(`Campfire: no DM with user ${userId} yet; they must message the bot first`);
      }
      return platformIdForRoom(roomId);
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage) {
      const roomId = roomIdFromPlatformId(platformId);
      if (!roomId) {
        log.warn('Campfire: deliver to non-campfire platformId ignored', { platformId });
        return undefined;
      }
      const content =
        message.content && typeof message.content === 'object' ? (message.content as Record<string, unknown>) : null;

      if (content?.operation === 'edit' && typeof content.messageId === 'string' && content.messageId) {
        const messageId = content.messageId;
        const terminal = content.terminalCard as Record<string, unknown> | undefined;
        const markdown =
          terminal && typeof terminal.resolution === 'string'
            ? terminalCardMarkdown(
                typeof terminal.title === 'string' ? terminal.title : '',
                typeof terminal.question === 'string' ? terminal.question : '',
                terminal.resolution,
              )
            : extractText(message);
        if (!markdown) {
          log.warn('Campfire: edit with no text ignored', { platformId, messageId });
          return undefined;
        }
        await editMessage(roomId, messageId, markdown);
        // The card was settled elsewhere (e.g. the host approved it): stop expecting a numbered reply.
        if (pending.get(platformId)?.messageId === messageId) {
          pending.delete(platformId);
          persistPending();
        }
        return undefined;
      }

      if (content?.operation === 'reaction' && content.messageId && content.emoji) {
        const emoji = resolveEmoji(String(content.emoji));
        if (!emoji) {
          log.warn('Campfire: unknown reaction name, skipped', { emoji: content.emoji });
          return undefined;
        }
        await addBoost(roomId, String(content.messageId), emoji);
        return undefined;
      }

      if (content?.type === 'ask_question' && content.questionId && content.options) {
        const questionId = String(content.questionId);
        const title = typeof content.title === 'string' ? content.title : '';
        const question = typeof content.question === 'string' ? content.question : '';
        if (!title) {
          log.error('Campfire: ask_question missing required title, skipping delivery', { questionId });
          return undefined;
        }
        const options = normalizeOptions(content.options as never);
        const messageId = await postHtmlText(roomId, questionCardMarkdown(title, question, options));
        pending.set(platformId, { questionId, options, messageId, title, question });
        persistPending();
        return messageId;
      }

      if (content?.type === 'card' && content.card && typeof content.card === 'object') {
        const card = content.card as Record<string, unknown>;
        const text = (typeof content.fallbackText === 'string' && content.fallbackText) || displayCardMarkdown(card);
        if (!text) {
          log.warn('Campfire: send_card payload empty, skipping delivery');
          return undefined;
        }
        return postText(roomId, text, message);
      }

      return postText(roomId, extractText(message), message);
    },
  };

  return adapter;
}

/** Env-key suffix for a named instance: uppercased, dashes to underscores. */
function instanceEnvKeySuffix(name: string): string {
  return name.toUpperCase().replace(/-/g, '_');
}

/**
 * Bot-key hash → the instance key that claimed it. One bot key can't serve two
 * instances (each would answer every webhook of the same bot), so a second
 * claim is skipped. Hashed so this module-level map never holds a secret.
 */
const claimedBotKeys = new Map<string, string>();

/**
 * Build one instance's adapter from env: the default instance reads
 * CAMPFIRE_BOT_KEY / CAMPFIRE_WEBHOOK_TOKEN, a named one the same keys with
 * `_<NAME>` appended. Returns null when a credential is missing or the bot key
 * already belongs to another instance, so the registry reports its normal
 * "credentials missing, skipping" warning. Exported for the tests.
 */
export function createCampfireAdapterFromEnv(
  name?: string,
  readEnv: (keys: string[]) => Record<string, string> = readEnvFile,
): ChannelAdapter | null {
  const suffix = name ? `_${instanceEnvKeySuffix(name)}` : '';
  const keyVar = `CAMPFIRE_BOT_KEY${suffix}`;
  const tokenVar = `CAMPFIRE_WEBHOOK_TOKEN${suffix}`;
  const env = readEnv(['CAMPFIRE_URL', keyVar, tokenVar]);
  if (!env.CAMPFIRE_URL || !env[keyVar] || !env[tokenVar]) return null;
  const instanceKey = name ? `${CHANNEL}-${name}` : CHANNEL;
  const keyHash = createHash('sha256').update(env[keyVar]).digest('hex');
  const holder = claimedBotKeys.get(keyHash);
  if (holder !== undefined && holder !== instanceKey) {
    log.warn('Campfire bot key already in use by another instance, skipping', { instance: instanceKey, holder });
    return null;
  }
  claimedBotKeys.set(keyHash, instanceKey);
  return createCampfireAdapter({
    baseUrl: env.CAMPFIRE_URL,
    botKey: env[keyVar],
    webhookToken: env[tokenVar],
    instanceKey: name ? instanceKey : undefined,
  });
}

/** Valid names from a CAMPFIRE_INSTANCES value; others are skipped with a warning. */
export function parseCampfireInstanceNames(raw: string): string[] {
  const names: string[] = [];
  for (const part of raw.split(',')) {
    const name = part.trim();
    if (!name) continue;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      log.warn('CAMPFIRE_INSTANCES name must match ^[a-z0-9][a-z0-9-]*$, skipping', { name });
      continue;
    }
    names.push(name);
  }
  return names;
}

registerChannelAdapter(CHANNEL, { factory: () => createCampfireAdapterFromEnv(), defaults: CAMPFIRE_DEFAULTS });

// Named instances register unconditionally (a missing credential is then
// reported at boot instead of leaving the bot silently absent), each with the
// same declared defaults as the default instance.
for (const name of parseCampfireInstanceNames(readEnvFile(['CAMPFIRE_INSTANCES']).CAMPFIRE_INSTANCES ?? '')) {
  registerChannelAdapter(`${CHANNEL}-${name}`, {
    factory: () => createCampfireAdapterFromEnv(name),
    defaults: CAMPFIRE_DEFAULTS,
  });
}
