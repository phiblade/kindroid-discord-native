const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ephemeralFetchConversation: fetchHistory } = require('../dist/messageFetch');
process.env.CONTENT_PREPEND_SPEAKER = 'no';
let channelId = 0;
function fixture(count, botId = 'bot') {
  const calls = [];
  let history = [];
  let failOn;
  const channel = {
    id: String(++channelId), client: { user: { id: botId } },
    messages: { fetch: async (options) => {
      calls.push(options);
      if (calls.length === failOn) throw new Error('fetch failed');
      const page = history.filter(m => !options.before || BigInt(m.id) < BigInt(options.before))
        .sort((a, b) => Number(BigInt(b.id) - BigInt(a.id))).slice(0, options.limit);
      return new Map(page.map(m => [m.id, m]));
    } },
  };
  const append = (n) => {
    const start = history.length;
    for (let i = start + 1; i <= start + n; i++) history.push({
      id: String(i), author: { id: 'bot', username: 'Other bot' },
      content: String(i), createdAt: new Date(i), createdTimestamp: i,
    });
  };
  append(count);
  return { channel, calls, append, failAt: n => { failOn = n; } };
}
const texts = messages => messages.map(m => Number(m.text));

test('fills 200 using two pages, keeps chronological order, then checks just 10', async () => {
  const f = fixture(250);
  assert.deepEqual(texts(await fetchHistory(f.channel, 200)), Array.from({length: 200}, (_, i) => i + 51));
  assert.deepEqual(f.calls.map(c => [c.limit, c.before]), [[100, undefined], [100, '151']]);
  assert.equal((await fetchHistory(f.channel, 200)).length, 200);
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[2].limit, 10);
});

test('merges partial overlap and trims oldest messages', async () => {
  const f = fixture(200);
  await fetchHistory(f.channel, 200);
  f.append(3);
  const result = texts(await fetchHistory(f.channel, 200));
  assert.equal(result[0], 4);
  assert.equal(result.at(-1), 203);
  assert.equal(new Set(result).size, 200);
  assert.equal(f.calls.length, 3);
});

test('pages through multiple all-new batches until overlap', async () => {
  const f = fixture(200);
  await fetchHistory(f.channel, 200);
  f.append(25);
  const result = texts(await fetchHistory(f.channel, 200));
  assert.deepEqual(f.calls.slice(2).map(c => [c.limit, c.before]), [[10, undefined], [10, '216'], [10, '206']]);
  assert.equal(result[0], 26);
  assert.equal(result.at(-1), 225);
});

test('short and empty channels use incremental checks after reaching history end', async () => {
  for (const count of [0, 7, 100]) {
    const f = fixture(count);
    assert.equal((await fetchHistory(f.channel, 200)).length, count);
    const initialCalls = f.calls.length;
    f.append(2);
    assert.equal((await fetchHistory(f.channel, 200)).length, count + 2);
    assert.equal(f.calls.length, initialCalls + 1);
    assert.equal(f.calls.at(-1).limit, 10);
  }
});

test('large gap stops at a whole new context without retaining stale messages', async () => {
  const f = fixture(200);
  await fetchHistory(f.channel, 200);
  f.append(300);
  const result = texts(await fetchHistory(f.channel, 200));
  assert.equal(result[0], 301);
  assert.equal(result.at(-1), 500);
  assert.equal(f.calls.length, 22);
});

test('supports bounds, rejects invalid sizes, and refills after context change', async () => {
  for (const size of [1, 1000]) {
    const f = fixture(1100);
    assert.equal((await fetchHistory(f.channel, size)).length, size);
    assert.ok(f.calls.every(c => c.limit <= 100));
  }
  for (const size of [0, 1001, 1.5, NaN]) {
    await assert.rejects(fetchHistory(fixture(1).channel, size), /KINDROID_MESSAGE_CONTEXT/);
  }
  const f = fixture(250);
  await fetchHistory(f.channel, 10);
  assert.equal((await fetchHistory(f.channel, 200)).length, 200);
});

test('failed incremental pages do not partially commit; retry catches all new messages', async () => {
  const f = fixture(200);
  await fetchHistory(f.channel, 200);
  f.append(25);
  f.failAt(4);
  await assert.rejects(fetchHistory(f.channel, 200), /fetch failed/);
  const result = texts(await fetchHistory(f.channel, 200));
  assert.deepEqual(result, Array.from({length: 200}, (_, i) => i + 26));
});

test('serializes concurrent requests and isolates bots sharing a channel', async () => {
  const f = fixture(200);
  const results = await Promise.all([fetchHistory(f.channel, 200), fetchHistory(f.channel, 200)]);
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(f.calls.map(c => c.limit), [100, 100, 10]);
  const other = fixture(200, 'other');
  other.channel.id = f.channel.id;
  const otherResult = await fetchHistory(other.channel, 200);
  assert.equal(results[0][0].username, '{{ai}}');
  assert.equal(otherResult[0].username, 'Other bot');
  assert.deepEqual(other.calls.map(c => c.limit), [100, 100]);
});

test('configurable Discord batch controls initial pages and caps incremental pages', async () => {
  const f = fixture(25);
  await fetchHistory(f.channel, 20, 7);
  assert.deepEqual(f.calls.map(c => c.limit), [7, 7, 6]);
  f.append(8);
  const result = await fetchHistory(f.channel, 20, 7);
  assert.deepEqual(f.calls.slice(3).map(c => c.limit), [7, 7]);
  assert.equal(result.at(-1).text, '33');
  for (const batch of [0, 101, 1.5, NaN]) {
    await assert.rejects(fetchHistory(f.channel, 20, batch), /DISCORD_FETCH_BATCH/);
  }
});

test('cache grows beyond payload size but retains only the newest 1000 messages', async () => {
  // Inspect private state in an isolated compiled module, without exposing it in production.
  const { readFileSync } = require('node:fs');
  const { createRequire } = require('node:module');
  const { runInNewContext } = require('node:vm');
  const path = require.resolve('../dist/messageFetch');
  const isolated = { exports: {} };
  runInNewContext(readFileSync(path, 'utf8') + '\nexports.cacheForTest = channelCache;', {
    exports: isolated.exports, require: createRequire(path), console, process,
  });
  const { ephemeralFetchConversation: fetch, cacheForTest } = isolated.exports;
  const f = fixture(200);
  await fetch(f.channel, 200);
  f.append(50);
  assert.equal((await fetch(f.channel, 200)).length, 200);
  assert.equal(cacheForTest.get(`bot:${f.channel.id}`).messages.size, 250);
  for (let i = 0; i < 5; i++) {
    f.append(200);
    const result = await fetch(f.channel, 200);
    assert.equal(result.length, 200);
    assert.equal(result.at(-1).text, String(450 + i * 200));
  }
  const cached = cacheForTest.get(`bot:${f.channel.id}`).messages;
  assert.equal(cached.size, 1000);
  assert.equal(Math.min(...Array.from(cached.keys(), Number)), 251);
  assert.equal(Math.max(...Array.from(cached.keys(), Number)), 1250);
});

test('speaker prefixes default on, can be disabled, and never mutate cached content', async () => {
  const { shouldPrependSpeaker } = require('../dist/messageFetch');
  const f = fixture(1);
  try {
    delete process.env.CONTENT_PREPEND_SPEAKER;
    const initial = await fetchHistory(f.channel, 200);
    assert.equal(initial[0].username, '{{ai}}');
    assert.equal(initial[0].text, '[{{ai}}]: 1');
    assert.equal((await fetchHistory(f.channel, 200))[0].text, '[{{ai}}]: 1');
    for (const value of ['no', 'FALSE', '0']) {
      process.env.CONTENT_PREPEND_SPEAKER = value;
      assert.equal((await fetchHistory(f.channel, 200))[0].text, '1');
    }
    for (const value of ['yes', ' TRUE ', '1']) {
      process.env.CONTENT_PREPEND_SPEAKER = value;
      assert.equal((await fetchHistory(f.channel, 200))[0].text, '[{{ai}}]: 1');
    }
    const other = fixture(1, 'other-speaker-test');
    const result = await fetchHistory(other.channel, 200);
    assert.equal(result[0].username, 'Other bot');
    assert.equal(result[0].text, '[Other bot]: 1');
    process.env.CONTENT_PREPEND_SPEAKER = 'maybe';
    assert.throws(shouldPrependSpeaker, /CONTENT_PREPEND_SPEAKER/);
  } finally {
    process.env.CONTENT_PREPEND_SPEAKER = 'no';
  }
});
