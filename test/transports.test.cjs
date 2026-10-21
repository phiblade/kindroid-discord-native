const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { BridgeStore } = require('../dist/native/store');
const {
  NativeKindroid,
  parseHistory,
  retryAfter,
} = require('../dist/native/kindroid');
const { DiscordPosting } = require('../dist/native/discord-posting');
const { DeliveryLoop } = require('../dist/native/delivery');
const { FakeClock, FakeDiscord } = require('../dist/native/fakes');
const {
  PermanentFailure,
  RejectedRequest,
  RetryLater,
} = require('../dist/native/types');
const config = {
  id: 'b',
  botId: '900',
  channelId: '800',
  kinId: 'kin',
  maxChars: 4000,
  retryBaseMs: 100,
  retryMaxMs: 1000,
  maxReconcileChecks: 3,
};
const message = (id, extra = {}) => ({
  id: String(id),
  channelId: '800',
  authorId: '700',
  speaker: 'Bob',
  content: `hello ${id}`,
  timestamp: Number(id),
  ...extra,
});
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'transports-')),
    path = join(dir, 'db.sqlite');
  let store = new BridgeStore(path);
  store.register(config);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    get store() {
      return store;
    },
    path,
    reopen() {
      store.close();
      store = new BridgeStore(path);
      store.register(config);
    },
    batch() {
      store.ingest('b', message(10));
      return store.beginBatch(store.prepare('b', 0));
    },
    chunk(text = 'hello discord') {
      const b = this.batch();
      store.finishBatch(b, { text });
      return store.beginChunk(store.chunks(b.id)[0]);
    },
  };
}
const historyMessage = (id, sender, text, timestamp) => ({
  id,
  sender,
  sender_type: sender === 'kin' ? 'ai' : 'user',
  timestamp,
  message: text,
});
const page = (messages, hasMore = false) =>
  Response.json({
    messages,
    pagination: { hasMore, lastTimestamp: messages.at(-1)?.timestamp ?? null },
  });

test('native send uses documented endpoint, bearer auth, immutable payload and plain-text response', async (t) => {
  const f = fixture(t),
    batch = f.batch();
  let calls = 0;
  const kin = new NativeKindroid(f.store, 'test-secret', {
    now: () => 0,
    fetch: async (url, init) => {
      calls++;
      assert.equal(url, 'https://api.kindroid.ai/v1/send-message');
      assert.equal(init.headers.Authorization, 'Bearer test-secret');
      assert.deepEqual(JSON.parse(init.body), {
        ai_id: 'kin',
        message: batch.payload,
        stream: false,
      });
      assert.equal(init.redirect, 'error');
      assert.ok(init.signal);
      return new Response('Hello, Bob!');
    },
  });
  assert.deepEqual(await kin.send('kin', batch), { text: 'Hello, Bob!' });
  assert.equal(calls, 1);
});

for (const status of [400, 401, 403, 404, 413, 422, 429, 409, 500]) {
  test(`native HTTP ${status} classified without exposing response contents or retrying internally`, async (t) => {
    const f = fixture(t),
      batch = f.batch();
    let calls = 0;
    const kin = new NativeKindroid(f.store, 'secret', {
      now: () => 0,
      fetch: async () => {
        calls++;
        return new Response('sensitive text', {
          status,
          headers: { 'retry-after': '42' },
        });
      },
    });
    await assert.rejects(kin.send('kin', batch), (e) => {
      assert.ok(!e.message.includes('sensitive'));
      if (status === 429) {
        assert.ok(e instanceof RejectedRequest);
        assert.equal(e.retryAfterMs, 42000);
      } else if ([409, 500].includes(status))
        assert.ok(
          !(e instanceof PermanentFailure || e instanceof RejectedRequest),
        );
      else assert.ok(e instanceof PermanentFailure);
      return true;
    });
    assert.equal(calls, 1);
  });
}

for (const text of ['', ' \n', '<<ERROR>> failed', ' <<HTTP_ERROR>> failed']) {
  test(`generation error/empty reply remains uncertain: ${JSON.stringify(text)}`, async (t) => {
    const f = fixture(t),
      batch = f.batch();
    const kin = new NativeKindroid(f.store, 'secret', {
      fetch: async () => new Response(text),
    });
    await assert.rejects(kin.send('kin', batch), /outcome unknown/);
  });
}

test('network failure is ambiguous, including accepted send followed by dropped response', async (t) => {
  const f = fixture(t),
    batch = f.batch();
  const kin = new NativeKindroid(f.store, 'secret', {
    fetch: async () => {
      throw Error('secret network detail');
    },
  });
  await assert.rejects(
    kin.send('kin', batch),
    (e) => e.message.includes('unknown') && !e.message.includes('secret'),
  );
});

test('account limiter shares send/history reservations, survives restart, and honors persisted cooldown', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 10; i++)
    assert.equal(f.store.reserveApiRequest(1000, i % 2 === 0), 0);
  assert.equal(f.store.reserveApiRequest(1000, false), 30000);
  f.reopen();
  assert.equal(f.store.reserveApiRequest(2000, true), 29000);
  assert.equal(f.store.reserveApiRequest(31000, true), 0);
  f.store.deferApiUntil(90000);
  f.reopen();
  assert.equal(f.store.reserveApiRequest(32000, false), 58000);
});

test('history daily quota is independent of the short account window', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 600; i++)
    assert.equal(f.store.reserveApiRequest(i * 31000, true), 0);
  assert.equal(
    f.store.reserveApiRequest(600 * 31000, true),
    86400000 - 600 * 31000,
  );
  assert.equal(f.store.reserveApiRequest(600 * 31000, false), 0);
});

test('exact batch history match and adjacent Kin reply work across pages and restart', async (t) => {
  const f = fixture(t),
    batch = f.batch();
  let calls = 0;
  const kin = new NativeKindroid(f.store, 'secret', {
    now: () => 1000,
    fetch: async () => {
      calls++;
      if (calls === 1)
        return page([historyMessage('u', 'user', batch.payload, 123)], true);
      throw Error('history interrupted');
    },
  });
  await assert.rejects(kin.reconcile('kin', batch), /unknown/);
  f.reopen();
  const restarted = new NativeKindroid(f.store, 'secret', {
    now: () => 32000,
    fetch: async (url) => {
      assert.equal(
        new URL(url).searchParams.get('start_after_timestamp'),
        '123',
      );
      return page([historyMessage('a', 'kin', 'caught up!', 124)]);
    },
  });
  assert.deepEqual(await restarted.reconcile('kin', batch), {
    status: 'found',
    result: { text: 'caught up!', nativeId: 'a' },
  });
});

test('absent or pending native response stays unknown; intervening user message blocks association', async (t) => {
  const f = fixture(t),
    batch = f.batch();
  let messages = [historyMessage('other', 'user', 'unrelated', 1)];
  const kin = new NativeKindroid(f.store, 'secret', {
    fetch: async () => page(messages),
  });
  assert.deepEqual(await kin.reconcile('kin', batch), { status: 'unknown' });
  messages = [historyMessage('u', 'user', batch.payload, 2)];
  assert.deepEqual(await kin.reconcile('kin', batch), { status: 'unknown' });
  messages = [
    historyMessage('u2', 'user', 'new turn', 3),
    historyMessage('a', 'kin', 'wrong reply', 4),
  ];
  await assert.rejects(kin.reconcile('kin', batch), PermanentFailure);
});

test('malformed, nonchronological, or stalled history never confirms a batch', async (t) => {
  assert.throws(() => parseHistory({ messages: [] }), /Invalid/);
  assert.throws(
    () =>
      parseHistory({
        messages: [
          historyMessage('1', 'kin', 'x', 2),
          historyMessage('2', 'kin', 'y', 1),
        ],
        pagination: { hasMore: false, lastTimestamp: 1 },
      }),
    /chronological/,
  );
  const f = fixture(t),
    batch = f.batch();
  const kin = new NativeKindroid(f.store, 'secret', {
    fetch: async () => page([], true),
  });
  await assert.rejects(kin.reconcile('kin', batch), /stalled/);
});

test('long history scan persists its cursor and rate-limit waits do not burn reconciliation checks', async (t) => {
  const f = fixture(t),
    batch = f.batch();
  let count = 0;
  const kin = new NativeKindroid(f.store, 'secret', {
    now: () => 0,
    fetch: async () =>
      page(
        [historyMessage(String(++count), 'user', 'older chat', count)],
        true,
      ),
  });
  await assert.rejects(kin.reconcile('kin', batch), RetryLater);
  assert.equal(f.store.nativeRecovery(batch.id).cursor, 10);
  f.reopen();
  const clock = new FakeClock();
  const throttled = new NativeKindroid(f.store, 'secret', {
    now: () => 0,
    fetch: async () => {
      throw Error('must not issue HTTP');
    },
  });
  const loop = new DeliveryLoop(
    f.store,
    'b',
    throttled,
    new FakeDiscord(clock),
    clock,
  );
  try {
    loop.start();
    await loop.settled();
    assert.equal(f.store.activeBatch('b').state, 'uncertain');
    assert.equal(f.store.activeBatch('b').checks, 0);
  } finally {
    await loop.stop();
  }
});

function discordFake(f, chunk) {
  let sends = 0,
    history = [],
    reply;
  const makeMessage = (extra = {}) => ({
    id: '20',
    channelId: '800',
    author: { id: '900', username: 'Kin' },
    content: chunk.content,
    nonce: chunk.nonce,
    createdTimestamp: 20,
    editedTimestamp: null,
    inGuild: () => true,
    ...extra,
  });
  const client = {
    user: { id: '900' },
    isReady: () => true,
    channels: {
      async fetch() {
        return {
          isTextBased: () => true,
          isDMBased: () => false,
          isThread: () => false,
          permissionsFor: () => ({ has: () => true }),
          async send(options) {
            sends++;
            assert.equal(options.enforceNonce, true);
            assert.equal(options.nonce, chunk.nonce);
            assert.deepEqual(
              options.allowedMentions,
              JSON.parse(chunk.allowed_mentions),
            );
            return reply ?? makeMessage();
          },
          messages: {
            async fetch() {
              return new Map(history.map((m) => [m.id, m]));
            },
          },
        };
      },
    },
  };
  return {
    client,
    makeMessage,
    get sends() {
      return sends;
    },
    setHistory(value) {
      history = value;
    },
    setReply(value) {
      reply = value;
    },
  };
}

test('Discord posts persisted chunks with nonce enforcement and disabled mass mentions', async (t) => {
  const f = fixture(t),
    chunk = f.chunk('hello <@700> @everyone');
  const fake = discordFake(f, chunk);
  const posting = new DiscordPosting(f.store, 'b', fake.client);
  assert.deepEqual(await posting.post('800', chunk), { messageId: '20' });
  assert.equal(fake.sends, 1);
  assert.equal(f.store.discordReceipt(chunk.nonce), '20');
  assert.equal(f.store.pending('b').length, 0);
  await assert.rejects(posting.post('801', chunk), PermanentFailure);
});

test('gateway nonce receipt survives lost HTTP acknowledgment and restart', async (t) => {
  const f = fixture(t),
    chunk = f.chunk();
  f.store.ingest(
    'b',
    message(20, {
      authorId: '900',
      content: chunk.content,
      nonce: chunk.nonce,
    }),
  );
  f.reopen();
  const posting = new DiscordPosting(f.store, 'b', {
    channels: {
      fetch() {
        throw Error('no network needed');
      },
    },
  });
  assert.deepEqual(await posting.reconcile('800', chunk), {
    status: 'found',
    result: { messageId: '20' },
  });
});

test('Discord reconciliation requires exact nonce, author and content; never reposts an unknown chunk', async (t) => {
  const f = fixture(t),
    chunk = f.chunk(),
    fake = discordFake(f, chunk);
  const posting = new DiscordPosting(f.store, 'b', fake.client);
  for (const mismatch of [
    { nonce: null },
    { author: { id: '701' } },
    { content: 'different' },
  ]) {
    fake.setHistory([fake.makeMessage(mismatch)]);
    assert.deepEqual(await posting.reconcile('800', chunk), {
      status: 'unknown',
    });
  }
  fake.setHistory([fake.makeMessage()]);
  assert.deepEqual(await posting.reconcile('800', chunk), {
    status: 'found',
    result: { messageId: '20' },
  });
  assert.equal(fake.sends, 0);
});

test('v2 migration preserves pending queue and existing configuration', (t) => {
  const f = fixture(t);
  f.store.ingest('b', message(10));
  const db = new DatabaseSync(f.path);
  db.exec(
    'DROP TABLE discord_receipts; DROP TABLE native_recovery; DROP TABLE api_cooldown; DROP TABLE api_requests; PRAGMA user_version=2;',
  );
  db.close();
  f.reopen();
  assert.equal(f.store.pending('b').length, 1);
  assert.equal(f.store.reserveApiRequest(0, false), 0);
});

test('Retry-After accepts seconds and HTTP dates', () => {
  assert.equal(retryAfter('42', 0), 42000);
  assert.equal(retryAfter('Thu, 01 Jan 1970 00:01:00 GMT', 0), 60000);
  assert.equal(retryAfter('bad', 0), 30000);
});

test('real adapters and delivery loop recover lost native and Discord acknowledgments across restarts', async (t) => {
  const f = fixture(t),
    clock = new FakeClock();
  let nativeSends = 0,
    payload,
    discordSends = 0;
  const longReply = 'a'.repeat(2500);
  const transportFetch = async (_url, init) => {
    if (init.method === 'POST') {
      nativeSends++;
      payload = JSON.parse(init.body).message;
      throw Error('accepted, response lost');
    }
    return page([
      historyMessage('u', 'user', payload, 1),
      historyMessage('a', 'kin', longReply, 2),
    ]);
  };
  const client = {
    user: { id: '900' },
    isReady: () => true,
    channels: {
      async fetch() {
        return {
          isTextBased: () => true,
          isDMBased: () => false,
          isThread: () => false,
          permissionsFor: () => ({ has: () => true }),
          async send(options) {
            discordSends++;
            const result = {
              id: String(20 + discordSends),
              channelId: '800',
              author: { id: '900', username: 'Kin' },
              content: options.content,
              nonce: options.nonce,
              createdTimestamp: 20,
              editedTimestamp: null,
              inGuild: () => true,
            };
            if (discordSends === 2) {
              f.store.ingest(
                'b',
                message(result.id, {
                  authorId: '900',
                  content: options.content,
                  nonce: options.nonce,
                }),
              );
              throw Error('posted, acknowledgment lost');
            }
            return result;
          },
        };
      },
    },
  };
  const makeLoop = () =>
    new DeliveryLoop(
      f.store,
      'b',
      new NativeKindroid(f.store, 'secret', {
        fetch: transportFetch,
        now: () => clock.now(),
      }),
      new DiscordPosting(f.store, 'b', client),
      clock,
    );
  f.store.ingest('b', message(10));
  let loop = makeLoop();
  try {
    loop.start();
    await loop.settled();
    assert.equal(f.store.activeBatch('b').state, 'uncertain');
  } finally {
    await loop.stop();
  }
  f.reopen();
  clock.advance(1000);
  loop = makeLoop();
  try {
    loop.start();
    await loop.settled();
    assert.equal(f.store.nextChunk('b').state, 'uncertain');
    assert.equal(discordSends, 2);
  } finally {
    await loop.stop();
  }
  f.reopen();
  clock.advance(1000);
  loop = makeLoop();
  try {
    loop.start();
    await loop.settled();
    assert.equal(f.store.nextChunk('b'), undefined);
    assert.equal(f.store.pending('b').length, 0);
  } finally {
    await loop.stop();
  }
  assert.equal(nativeSends, 1);
  assert.equal(discordSends, 2);
  assert.equal(
    f.store
      .chunks(f.store.batches('b')[0].id)
      .map((c) => c.content)
      .join(''),
    longReply,
  );
});

test('HTTP success without an echoed nonce still saves a durable Discord receipt', async (t) => {
  const f = fixture(t),
    chunk = f.chunk(),
    fake = discordFake(f, chunk);
  fake.setReply(fake.makeMessage({ nonce: undefined }));
  await new DiscordPosting(f.store, 'b', fake.client).post('800', chunk);
  f.reopen();
  assert.equal(f.store.discordReceipt(chunk.nonce), '20');
});

test('native JSON success bodies are not posted as speech', async (t) => {
  const f = fixture(t),
    batch = f.batch();
  const kin = new NativeKindroid(f.store, 'secret', {
    fetch: async () => Response.json({ error: 'not speech' }),
  });
  await assert.rejects(kin.send('kin', batch), /JSON instead of reply/);
});

test('abort is ambiguous and triggers no hidden retry', async (t) => {
  const f = fixture(t),
    batch = f.batch(),
    abort = new AbortController();
  let calls = 0;
  const kin = new NativeKindroid(f.store, 'secret', {
    signal: abort.signal,
    fetch: async (_url, init) => {
      calls++;
      return new Promise((_resolve, reject) =>
        init.signal.addEventListener('abort', () => reject(Error('aborted')), {
          once: true,
        }),
      );
    },
  });
  const pending = kin.send('kin', batch);
  abort.abort();
  await assert.rejects(pending, /outcome unknown/);
  assert.equal(calls, 1);
});
