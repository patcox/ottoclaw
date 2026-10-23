/**
 * Campfire adapter: webhook auth and parsing on the real shared webhook
 * server, async delivery to the bot API, and the Markdown → HTML conversion.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ChannelSetup, InboundMessage } from './adapter.js';
import { createCampfireAdapter, markdownToHtml, parseWebhookPayload, roomIdFromPlatformId } from './campfire.js';
import { allocateFreePort } from '../test-utils/free-port.js';
import { stopWebhookServer } from '../webhook-server.js';

const TOKEN = 'test-token-abc';

const payload = {
  user: { id: 1, name: 'Pat' },
  room: { id: 4, name: 'Pat + Bot', path: '/rooms/4/2-key/messages' },
  message: { id: 99, body: { html: '<div>hi</div>', plain: 'hi there' }, path: '/rooms/4@99' },
};

let PORT: number;
const inbound: Array<{ platformId: string; threadId: string | null; message: InboundMessage }> = [];
const fetchMock = vi.fn();

async function postWebhook(query: string, body: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(`http://127.0.0.1:${PORT}/webhook/campfire${query}`, { method: 'POST', body });
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
    expect(msg.message.content).toMatchObject({ text: 'hi there', sender: 'Pat', senderId: 'campfire:1' });
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
