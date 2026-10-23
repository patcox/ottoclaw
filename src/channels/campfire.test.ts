/**
 * Campfire adapter: webhook auth and parsing on the real shared webhook
 * server, async delivery to the bot API, the Markdown → HTML conversion,
 * named instances, group/DM detection, openDM, card rendering and the
 * numbered-reply interception. No test touches DATA_DIR: each adapter gets a
 * temp stateDir.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter, ChannelSetup, InboundMessage } from './adapter.js';
import {
  createCampfireAdapter,
  createCampfireAdapterFromEnv,
  hasMention,
  markdownToHtml,
  matchOption,
  parseCampfireInstanceNames,
  parseWebhookPayload,
  resolveEmoji,
  roomIdFromPlatformId,
  splitForLimit,
} from './campfire.js';
import { allocateFreePort } from '../test-utils/free-port.js';
import { stopWebhookServer } from '../webhook-server.js';

const TOKEN = 'test-token-abc';
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'campfire-test-'));
  tempDirs.push(dir);
  return dir;
}

const payload = {
  user: { id: 1, name: 'Alice' },
  room: { id: 4, name: 'Alice + Bot', path: '/rooms/4/2-key/messages' },
  message: { id: 99, body: { html: '<div>hi</div>', plain: 'hi there' }, path: '/rooms/4@99' },
};

let PORT: number;
const inbound: Array<{ platformId: string; threadId: string | null; message: InboundMessage }> = [];
const fetchMock = vi.fn();

async function postWebhook(query: string, body: string, route = 'campfire'): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(`http://127.0.0.1:${PORT}/webhook/${route}${query}`, { method: 'POST', body });
    } catch (err) {
      if (attempt >= 40) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

const adapter = createCampfireAdapter({
  baseUrl: 'http://campfire.test/',
  botKey: '2-key',
  webhookToken: TOKEN,
  fetchImpl: fetchMock as unknown as typeof fetch,
  stateDir: tempDir(),
});

beforeAll(async () => {
  PORT = await allocateFreePort();
  process.env.WEBHOOK_PORT = String(PORT);
  const setup: ChannelSetup = {
    onInbound: (platformId, threadId, message) => {
      inbound.push({ platformId, threadId, message });
    },
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  };
  await adapter.setup(setup);
});

afterAll(async () => {
  await stopWebhookServer();
  delete process.env.WEBHOOK_PORT;
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('campfire webhook', () => {
  it('rejects a missing or wrong token', async () => {
    expect((await postWebhook('', JSON.stringify(payload))).status).toBe(401);
    expect((await postWebhook('?token=nope', JSON.stringify(payload))).status).toBe(401);
    expect(inbound).toHaveLength(0);
  });

  it('rejects a malformed payload', async () => {
    expect((await postWebhook(`?token=${TOKEN}`, '{"user":{}}')).status).toBe(400);
  });

  it('answers 204 and routes the message as a mention from campfire:<userId>', async () => {
    const res = await postWebhook(`?token=${TOKEN}`, JSON.stringify(payload));
    expect(res.status).toBe(204);
    await vi.waitFor(() => expect(inbound).toHaveLength(1));
    const [msg] = inbound;
    expect(msg.platformId).toBe('campfire:4');
    expect(msg.threadId).toBeNull();
    expect(msg.message.isMention).toBe(true);
    expect(msg.message.content).toMatchObject({ text: 'hi there', sender: 'Alice', senderId: 'campfire:1' });
  });
});

describe('campfire deliver', () => {
  it('posts HTML to the room bot URL and returns the id from Location', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 201, headers: { location: 'http://campfire.test/rooms/4/messages/123' } }),
    );
    const id = await adapter.deliver('campfire:4', null, { kind: 'chat', content: { text: 'hello **you**' } });
    expect(id).toBe('123');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://campfire.test/rooms/4/2-key/messages');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('hello <strong>you</strong>');
  });

  it('throws on a non-201 so delivery can retry', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 404 }));
    await expect(adapter.deliver('campfire:4', null, { kind: 'chat', content: { text: 'x' } })).rejects.toThrow(
      /HTTP 404/,
    );
  });

  it('ignores platform ids that are not campfire rooms', async () => {
    fetchMock.mockClear();
    expect(await adapter.deliver('telegram:1', null, { kind: 'chat', content: { text: 'x' } })).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('helpers', () => {
  it('parses room ids', () => {
    expect(roomIdFromPlatformId('campfire:12')).toBe('12');
    expect(roomIdFromPlatformId('campfire:abc')).toBeNull();
  });

  it('validates payloads', () => {
    expect(parseWebhookPayload('not json')).toBeNull();
    expect(parseWebhookPayload(JSON.stringify(payload))?.room.id).toBe(4);
  });

  it('converts markdown and escapes HTML', () => {
    expect(markdownToHtml('a <b> & c')).toBe('a &lt;b&gt; &amp; c');
    expect(markdownToHtml('line1\nline2')).toBe('line1<br>line2');
    expect(markdownToHtml('*it* and `x<y`')).toBe('<em>it</em> and <code>x&lt;y</code>');
    expect(markdownToHtml('see [docs](https://x.dev/a)')).toBe('see <a href="https://x.dev/a">docs</a>');
    expect(markdownToHtml('before\n```js\nif (a < b) {}\n```\nafter')).toBe(
      'before<br><pre>if (a &lt; b) {}</pre><br>after',
    );
  });
});

// --- helpers for the multi-adapter tests below ---------------------------------

const MENTION_HTML =
  '<div><action-text-attachment sgid="abc" content-type="application/vnd.campfire.mention">Bot</action-text-attachment> hi</div>';

function webhookPayload(opts: { user?: number; room?: number; plain?: string; html?: string; name?: string }) {
  return JSON.stringify({
    user: { id: opts.user ?? 7, name: opts.name ?? 'Alice' },
    room: { id: opts.room ?? 9, name: 'Room', path: '/rooms/9/2-key/messages' },
    message: {
      id: 500,
      body: { html: opts.html ?? `<div>${opts.plain ?? 'hi'}</div>`, plain: opts.plain ?? 'hi' },
      path: '/rooms/9@500',
    },
  });
}

interface Harness {
  adapter: ChannelAdapter;
  route: string;
  stateDir: string;
  fetch: ReturnType<typeof vi.fn>;
  inbound: Array<{ platformId: string; message: InboundMessage }>;
  actions: Array<{ questionId: string; value: string; userId: string; address: unknown }>;
  meta: Array<{ platformId: string; name?: string; isGroup?: boolean }>;
  send: (opts: Parameters<typeof webhookPayload>[0]) => Promise<void>;
}

/** Starts an adapter on its own route with a mocked fetch that numbers new messages from 1000. */
async function startAdapter(
  instanceKey: string,
  extra: Partial<Parameters<typeof createCampfireAdapter>[0]> = {},
): Promise<Harness> {
  let nextId = 1000;
  const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') return new Response(null, { status: 200 });
    if (String(_url).endsWith('/boosts')) return new Response(null, { status: 201 });
    return new Response(null, {
      status: 201,
      headers: { location: `http://campfire.test/rooms/9/messages/${nextId++}` },
    });
  });
  const stateDir = extra.stateDir ?? tempDir();
  const adapter = createCampfireAdapter({
    baseUrl: 'http://campfire.test',
    botKey: '2-key',
    webhookToken: TOKEN,
    instanceKey,
    stateDir,
    resolveRender: async () => undefined,
    fetchImpl: fetchFn as unknown as typeof fetch,
    ...extra,
  });
  const h: Harness = {
    adapter,
    route: instanceKey,
    stateDir,
    fetch: fetchFn,
    inbound: [],
    actions: [],
    meta: [],
    send: async (opts) => {
      const before = h.inbound.length + h.actions.length;
      const res = await postWebhook(`?token=${TOKEN}`, webhookPayload(opts), instanceKey);
      expect(res.status).toBe(204);
      // Give the async handler time to finish routing.
      await vi
        .waitFor(() => expect(h.inbound.length + h.actions.length).toBeGreaterThan(before), { timeout: 500 })
        .catch(() => {});
      await new Promise((r) => setTimeout(r, 20));
    },
  };
  await adapter.setup({
    onInbound: (platformId, _t, message) => {
      h.inbound.push({ platformId, message });
    },
    onInboundEvent: () => {},
    onMetadata: (platformId, name, isGroup) => {
      h.meta.push({ platformId, name, isGroup });
    },
    onAction: (questionId, value, userId, address) => {
      h.actions.push({ questionId, value, userId, address });
    },
  });
  return h;
}

const ASK = {
  type: 'ask_question',
  questionId: 'q-1',
  title: 'Allow Bob?',
  question: 'Bob wants in.',
  options: [
    { label: 'Allow', selectedLabel: '✅ Allowed', value: 'approve' },
    { label: 'Deny', selectedLabel: '❌ Denied', value: 'reject' },
  ],
};

function bodies(h: Harness, method: string): string[] {
  return h.fetch.mock.calls.filter(([, init]) => init?.method === method).map(([, init]) => String(init.body));
}

describe('named instances', () => {
  const env = {
    CAMPFIRE_URL: 'http://campfire.test',
    CAMPFIRE_BOT_KEY: '2-default',
    CAMPFIRE_WEBHOOK_TOKEN: 'tok-default',
    CAMPFIRE_BOT_KEY_CONCIERGE_X: '3-named',
    CAMPFIRE_WEBHOOK_TOKEN_CONCIERGE_X: 'tok-named',
    CAMPFIRE_BOT_KEY_TWIN: '3-named', // same bot key as concierge-x
    CAMPFIRE_WEBHOOK_TOKEN_TWIN: 'tok-twin',
    CAMPFIRE_BOT_KEY_NOTOKEN: '4-nope',
  } as Record<string, string>;
  const readEnv = (keys: string[]) => Object.fromEntries(keys.filter((k) => env[k]).map((k) => [k, env[k]]));

  it('builds the default instance from the unsuffixed keys, keyed by channelType', () => {
    const a = createCampfireAdapterFromEnv(undefined, readEnv)!;
    expect(a).toMatchObject({ name: 'campfire', channelType: 'campfire' });
    expect(a.instance).toBeUndefined();
  });

  it('maps a name to campfire-<name> and _<NAME> keys (uppercased, dashes to underscores)', () => {
    expect(createCampfireAdapterFromEnv('concierge-x', readEnv)).toMatchObject({
      name: 'campfire-concierge-x',
      instance: 'campfire-concierge-x',
      channelType: 'campfire',
    });
  });

  it('returns null when a credential is missing, and skips a bot key another instance holds', () => {
    expect(createCampfireAdapterFromEnv('notoken', readEnv)).toBeNull();
    expect(createCampfireAdapterFromEnv('nothing-set', readEnv)).toBeNull();
    // concierge-x claimed 3-named above.
    expect(createCampfireAdapterFromEnv('twin', readEnv)).toBeNull();
  });

  it('validates CAMPFIRE_INSTANCES names', () => {
    expect(parseCampfireInstanceNames('a, b-2 ,,Bad_Name,-x')).toEqual(['a', 'b-2']);
  });

  it('registers campfire-<name> per CAMPFIRE_INSTANCES entry from .env via the real module', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, '.env'), 'CAMPFIRE_INSTANCES=alpha,beta-1,Bad_Name\n');
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      vi.resetModules();
      await import('./campfire.js');
      const registry = await import('./channel-registry.js');
      const names = registry.getRegisteredChannelNames();
      expect(names).toEqual(expect.arrayContaining(['campfire', 'campfire-alpha', 'campfire-beta-1']));
      expect(names.filter((n) => n.toLowerCase() === 'campfire-bad_name')).toEqual([]);
      expect(registry.hasDeclaredChannelDefaults('campfire-alpha')).toBe(true);
    } finally {
      process.chdir(cwd);
    }
  });

  it('serves a named instance on /webhook/campfire-<name> with its own token and key', async () => {
    const h = await startAdapter('campfire-alt', { webhookToken: 'alt-token', botKey: '5-altkey' });
    expect(h.adapter).toMatchObject({ name: 'campfire-alt', instance: 'campfire-alt', channelType: 'campfire' });
    // The default adapter's token is rejected on the named route.
    expect((await postWebhook(`?token=${TOKEN}`, webhookPayload({}), 'campfire-alt')).status).toBe(401);
    expect((await postWebhook('?token=alt-token', webhookPayload({}), 'campfire-alt')).status).toBe(204);
    await vi.waitFor(() => expect(h.inbound).toHaveLength(1));
    await h.adapter.deliver('campfire:9', null, { kind: 'chat', content: { text: 'x' } });
    expect(h.fetch.mock.calls[0][0]).toBe('http://campfire.test/rooms/9/5-altkey/messages');
  });
});

describe('group vs DM detection', () => {
  it('detects mention markup, in both stored and rendered forms, and not typed text', () => {
    expect(hasMention(MENTION_HTML)).toBe(true);
    expect(hasMention('<p><span class="mention" sgid="x">Bot</span> hi</p>')).toBe(true);
    expect(hasMention('<div>hi</div>')).toBe(false);
    expect(hasMention('<div>&lt;span class="mention"&gt;</div>')).toBe(false);
  });

  it('flags a mention as a group message and a plain message as a DM, in onInbound and onMetadata', async () => {
    const h = await startAdapter('campfire-groups');
    await h.send({ room: 20, html: MENTION_HTML, plain: 'hi' });
    await h.send({ room: 21, user: 8, plain: 'hello' });
    expect(h.inbound.map((i) => i.message.isGroup)).toEqual([true, false]);
    expect(h.meta.map((m) => m.isGroup)).toEqual([true, false]);
    expect(h.meta[0]).toMatchObject({ platformId: 'campfire:20', name: 'Room' });
  });

  it('keeps a room a DM once it has delivered a mention-free message', async () => {
    const h = await startAdapter('campfire-sticky');
    await h.send({ room: 30, plain: 'plain first' });
    await h.send({ room: 30, html: MENTION_HTML, plain: 'now mentioning someone' });
    expect(h.inbound.map((i) => i.message.isGroup)).toEqual([false, false]);
  });

  it('resolves cached room names', async () => {
    const h = await startAdapter('campfire-names');
    await h.send({ room: 31 });
    expect(await h.adapter.resolveChannelName!('campfire:31')).toBe('Room');
    expect(await h.adapter.resolveChannelName!('campfire:32')).toBeNull();
  });
});

describe('openDM', () => {
  it('returns the DM room learned from a message, for the bare or prefixed handle', async () => {
    const h = await startAdapter('campfire-dm');
    await h.send({ user: 7, room: 40, plain: 'hi' });
    expect(await h.adapter.openDM!('7')).toBe('campfire:40');
    expect(await h.adapter.openDM!('campfire:7')).toBe('campfire:40');
  });

  it('rejects for an unknown user and does not learn from group mentions', async () => {
    const h = await startAdapter('campfire-dm2');
    await h.send({ user: 8, room: 41, html: MENTION_HTML });
    await expect(h.adapter.openDM!('8')).rejects.toThrow(/no DM/);
    await expect(h.adapter.openDM!('99')).rejects.toThrow(/no DM/);
  });

  it('persists the map to DATA_DIR-style state and reloads it', async () => {
    const h = await startAdapter('campfire-dm3');
    await h.send({ user: 7, room: 42, plain: 'hi' });
    const file = join(h.stateDir, 'campfire-dms-campfire-dm3.json');
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ '7': '42' });
    const reloaded = createCampfireAdapter({
      baseUrl: 'http://campfire.test',
      botKey: '2-key',
      webhookToken: TOKEN,
      instanceKey: 'campfire-dm3',
      stateDir: h.stateDir,
    });
    expect(await reloaded.openDM!('7')).toBe('campfire:42');
  });
});

describe('deliver branches', () => {
  it('converts a long text, unescapes Markdown escapes and returns the first chunk id', async () => {
    const h = await startAdapter('campfire-split', { maxTextLength: 50 });
    const text = `${'para one words '.repeat(2).trim()}\n\n${'para two words '.repeat(2).trim()}\n\n${'x'.repeat(120)}`;
    const id = await h.adapter.deliver('campfire:9', null, { kind: 'chat', content: { text } });
    expect(id).toBe('1000');
    const posts = bodies(h, 'POST');
    expect(posts.length).toBeGreaterThanOrEqual(4);
    for (const body of posts) expect(body.length).toBeLessThanOrEqual(60);
    expect(posts.join('')).toContain('para one words');
  });

  it('unescapes backslash-escaped Markdown but leaves code alone', async () => {
    const h = await startAdapter('campfire-unescape');
    await h.adapter.deliver('campfire:9', null, {
      kind: 'chat',
      content: { text: 'john\\_doe\\*x\\* \\(1\\) and `a\\*b`' },
    });
    expect(bodies(h, 'POST')[0]).toBe('john_doe*x* (1) and <code>a\\*b</code>');
  });

  it('attaches files after the text and returns the text message id', async () => {
    const h = await startAdapter('campfire-files');
    const id = await h.adapter.deliver('campfire:9', null, {
      kind: 'chat',
      content: { text: 'see attached' },
      files: [{ filename: 'a.txt', data: Buffer.from('hi') }],
    });
    expect(id).toBe('1000');
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.fetch.mock.calls[1][1].body).toBeInstanceOf(FormData);
  });

  it('edits with PATCH to the message url, as HTML', async () => {
    const h = await startAdapter('campfire-edit');
    const ret = await h.adapter.deliver('campfire:9', null, {
      kind: 'chat',
      content: { operation: 'edit', messageId: '321', text: 'new **text**' },
    });
    expect(ret).toBeUndefined();
    const [url, init] = h.fetch.mock.calls[0];
    expect(url).toBe('http://campfire.test/rooms/9/2-key/messages/321');
    expect(init.method).toBe('PATCH');
    expect(init.body).toBe('new <strong>text</strong>');
  });

  it('renders a terminalCard on edit instead of the text', async () => {
    const h = await startAdapter('campfire-terminal');
    await h.adapter.deliver('campfire:9', null, {
      kind: 'chat',
      content: {
        operation: 'edit',
        messageId: '321',
        text: 'ignored',
        terminalCard: { title: 'Allow?', question: 'Bob wants in.', resolution: '✅ Allowed by Alice' },
      },
    });
    expect(bodies(h, 'PATCH')[0]).toBe('<strong>Allow?</strong><br><br>Bob wants in.<br><br>✅ Allowed by Alice');
  });

  it('throws when an edit fails so delivery can retry', async () => {
    const h = await startAdapter('campfire-editfail', {
      fetchImpl: (async () => new Response('no', { status: 403 })) as unknown as typeof fetch,
    });
    await expect(
      h.adapter.deliver('campfire:9', null, {
        kind: 'chat',
        content: { operation: 'edit', messageId: '1', text: 'x' },
      }),
    ).rejects.toThrow(/HTTP 403/);
  });

  it('boosts with the emoji: a mapped name, a raw emoji, and skips an unknown name', async () => {
    const h = await startAdapter('campfire-boost');
    const react = (emoji: string) =>
      h.adapter.deliver('campfire:9', null, {
        kind: 'chat',
        content: { operation: 'reaction', messageId: '77', emoji },
      });
    expect(await react('thumbs_up')).toBeUndefined();
    await react('🎉');
    await react(':white_check_mark:');
    await react('definitely_not_an_emoji');
    expect(h.fetch).toHaveBeenCalledTimes(3);
    const [url, init] = h.fetch.mock.calls[0];
    expect(url).toBe('http://campfire.test/rooms/9/2-key/messages/77/boosts');
    expect(init.method).toBe('POST');
    expect(bodies(h, 'POST')).toEqual(['👍', '🎉', '✅']);
  });

  it('maps the common reaction names', () => {
    for (const name of [
      'thumbs_up',
      'thumbs_down',
      'heart',
      'white_check_mark',
      'check',
      'x',
      'eyes',
      'tada',
      'fire',
      'rocket',
      'pray',
      'ok_hand',
      'smile',
      'laughing',
      'thinking',
      'warning',
      'wave',
    ]) {
      expect(resolveEmoji(name), name).toBeTruthy();
    }
    expect(resolveEmoji('nope_nope')).toBeNull();
  });

  it('posts an ask_question as a numbered text card and returns its id', async () => {
    const h = await startAdapter('campfire-ask');
    const id = await h.adapter.deliver('campfire:9', null, { kind: 'chat-sdk', content: ASK });
    expect(id).toBe('1000');
    expect(bodies(h, 'POST')[0]).toBe(
      '<strong>Allow Bob?</strong><br><br>Bob wants in.<br><br>1. Allow<br>2. Deny<br><br>Reply with a number.',
    );
  });

  it('skips an ask_question with no title', async () => {
    const h = await startAdapter('campfire-ask-notitle');
    expect(
      await h.adapter.deliver('campfire:9', null, { kind: 'chat-sdk', content: { ...ASK, title: '' } }),
    ).toBeUndefined();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('posts a display card as its fallbackText, or title + description + links', async () => {
    const h = await startAdapter('campfire-card');
    const id = await h.adapter.deliver('campfire:9', null, {
      kind: 'chat-sdk',
      content: { type: 'card', card: { title: 'T' }, fallbackText: 'fallback here' },
    });
    expect(id).toBe('1000');
    await h.adapter.deliver('campfire:9', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Build done',
          description: 'All green.',
          actions: [{ label: 'Open', url: 'https://ci.test/run/1' }, { label: 'no url' }],
        },
      },
    });
    expect(bodies(h, 'POST')).toEqual([
      'fallback here',
      '<strong>Build done</strong><br><br>All green.<br><br><a href="https://ci.test/run/1">Open</a>',
    ]);
  });
});

describe('question reply interception', () => {
  it('answers with a number: onAction, terminal card edit, not forwarded to the agent', async () => {
    const h = await startAdapter('campfire-icpt1');
    await h.adapter.deliver('campfire:9', null, { kind: 'chat-sdk', content: ASK });
    await h.send({ user: 7, room: 9, name: 'Alice', plain: ' 1 ' });
    expect(h.inbound).toHaveLength(0);
    expect(h.actions).toEqual([
      {
        questionId: 'q-1',
        value: 'approve',
        userId: 'campfire:7',
        address: { instance: 'campfire-icpt1', messageId: '1000', platformId: 'campfire:9' },
      },
    ]);
    expect(h.fetch.mock.calls.at(-1)![0]).toBe('http://campfire.test/rooms/9/2-key/messages/1000');
    expect(bodies(h, 'PATCH')).toEqual(['<strong>Allow Bob?</strong><br><br>Bob wants in.<br><br>✅ Allowed by Alice']);
    // The question is settled: a second "1" is an ordinary message.
    await h.send({ user: 7, room: 9, plain: '1' });
    expect(h.inbound).toHaveLength(1);
    expect(h.actions).toHaveLength(1);
  });

  it('answers with the option label, case-insensitively, using a fallback label when none is set', async () => {
    const h = await startAdapter('campfire-icpt2');
    await h.adapter.deliver('campfire:9', null, {
      kind: 'chat-sdk',
      content: { ...ASK, options: ['Yes', 'No'] },
    });
    await h.send({ plain: 'no' });
    expect(h.actions[0]).toMatchObject({ value: 'No' });
    expect(bodies(h, 'PATCH')[0]).toContain('✅ No by Alice');
  });

  it('passes a non-matching reply through to onInbound and keeps the question open', async () => {
    const h = await startAdapter('campfire-icpt3');
    await h.adapter.deliver('campfire:9', null, { kind: 'chat-sdk', content: ASK });
    await h.send({ plain: 'what is this about?' });
    await h.send({ plain: '3' });
    await h.send({ plain: '0' });
    expect(h.inbound).toHaveLength(3);
    expect(h.actions).toHaveLength(0);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    await h.send({ plain: '2' });
    expect(h.actions[0]).toMatchObject({ value: 'reject' });
  });

  it('only intercepts in the room that holds the question', async () => {
    const h = await startAdapter('campfire-icpt4');
    await h.adapter.deliver('campfire:9', null, { kind: 'chat-sdk', content: ASK });
    await h.send({ room: 10, plain: '1' });
    expect(h.inbound).toHaveLength(1);
    expect(h.actions).toHaveLength(0);
  });

  it('lets the latest question in a room win', async () => {
    const h = await startAdapter('campfire-icpt5');
    await h.adapter.deliver('campfire:9', null, { kind: 'chat-sdk', content: ASK });
    await h.adapter.deliver('campfire:9', null, { kind: 'chat-sdk', content: { ...ASK, questionId: 'q-2' } });
    await h.send({ plain: '1' });
    expect(h.actions.map((a) => a.questionId)).toEqual(['q-2']);
  });

  it('leaves the card for the coordinator when the render defers resolution', async () => {
    const h = await startAdapter('campfire-icpt6', { resolveRender: async () => ({ deferResolution: true }) });
    await h.adapter.deliver('campfire:9', null, { kind: 'chat-sdk', content: ASK });
    await h.send({ plain: '1' });
    expect(h.actions).toHaveLength(1);
    expect(bodies(h, 'PATCH')).toEqual([]);
  });

  it('survives a render lookup failure by updating the card anyway', async () => {
    const h = await startAdapter('campfire-icpt7', {
      resolveRender: async () => {
        throw new Error('no db');
      },
    });
    await h.adapter.deliver('campfire:9', null, { kind: 'chat-sdk', content: ASK });
    await h.send({ plain: '1' });
    expect(h.actions).toHaveLength(1);
    expect(bodies(h, 'PATCH')).toHaveLength(1);
  });

  it('stops expecting a reply once the host edits the card to a terminal state', async () => {
    const h = await startAdapter('campfire-icpt8');
    await h.adapter.deliver('campfire:9', null, { kind: 'chat-sdk', content: ASK });
    await h.adapter.deliver('campfire:9', null, {
      kind: 'chat',
      content: { operation: 'edit', messageId: '1000', text: 'done' },
    });
    await h.send({ plain: '1' });
    expect(h.actions).toHaveLength(0);
    expect(h.inbound).toHaveLength(1);
  });

  it('persists pending questions across a restart', async () => {
    const h = await startAdapter('campfire-icpt9');
    await h.adapter.deliver('campfire:9', null, { kind: 'chat-sdk', content: ASK });
    expect(JSON.parse(readFileSync(join(h.stateDir, 'campfire-pending-campfire-icpt9.json'), 'utf-8'))).toHaveProperty(
      'campfire:9.questionId',
      'q-1',
    );
    await h.adapter.teardown();
    // Same state dir and route: the new adapter takes over the webhook.
    const h2 = await startAdapter('campfire-icpt9', { stateDir: h.stateDir });
    await h2.send({ plain: '2' });
    expect(h2.actions).toMatchObject([{ questionId: 'q-1', value: 'reject' }]);
    expect(h2.inbound).toHaveLength(0);
  });
});

describe('text helpers', () => {
  it('matches options by 1-based number or label', () => {
    const opts = [
      { label: 'Allow', selectedLabel: 'Allow', value: 'a' },
      { label: 'Deny', selectedLabel: 'Deny', value: 'd' },
    ];
    expect(matchOption(opts, '2')?.value).toBe('d');
    expect(matchOption(opts, '1.')?.value).toBe('a');
    expect(matchOption(opts, ' DENY ')?.value).toBe('d');
    expect(matchOption(opts, '3')).toBeNull();
    expect(matchOption(opts, 'allow it please')).toBeNull();
  });

  it('splits on paragraph, line, then a hard cut, within the limit', () => {
    expect(splitForLimit('short', 100)).toEqual(['short']);
    const chunks = splitForLimit(`${'a'.repeat(30)}\n\n${'b'.repeat(30)}`, 40);
    expect(chunks).toEqual(['a'.repeat(30), 'b'.repeat(30)]);
    const hard = splitForLimit('z'.repeat(100), 40);
    expect(hard.every((c) => c.length <= 40)).toBe(true);
    expect(hard.join('')).toBe('z'.repeat(100));
  });

  it('closes and reopens a code fence cut by a split', () => {
    const text = `\`\`\`\n${'line of code\n'.repeat(10)}\`\`\``;
    const chunks = splitForLimit(text, 60);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.match(/^```/gm)?.length ?? 0).toBe(2);
  });
});
