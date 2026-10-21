const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { BridgeStore } = require('../dist/native/store');
const { DeliveryLoop } = require('../dist/native/delivery');
const { FakeClock, FakeKin, FakeDiscord } = require('../dist/native/fakes');
const { RejectedRequest, PermanentFailure } = require('../dist/native/types');
const { loadNativeConfig } = require('../dist/native/config');
const { splitReply } = require('../dist/native/batching');

function config(overrides = {}) {
  return { id: 'bridge', botId: '900', channelId: '800', kinId: 'kin', maxChars: 4000,
    retryBaseMs: 100, retryMaxMs: 1000, maxReconcileChecks: 3, ...overrides };
}
function message(id, content = `message ${id}`, extra = {}) {
  return { id: String(id), channelId: '800', authorId: '700', speaker: 'Alice', content, timestamp: Number(id), ...extra };
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function tick() { await new Promise(resolve => setImmediate(resolve)); }
function fixture(t, overrides = {}, fault = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'native-bridge-'));
  const path = join(dir, 'bridge.sqlite');
  let store = new BridgeStore(path, fault);
  const cfg = config(overrides);
  store.register(cfg);
  const clock = new FakeClock();
  const kin = new FakeKin();
  const discord = new FakeDiscord(clock);
  let loops = [];
  const f = { path, cfg, clock, kin, discord,
    get store() { return store; },
    loop() { const loop = new DeliveryLoop(store, cfg.id, kin, discord, clock); loops.push(loop); return loop; },
    async reopen() {
      for (const loop of loops) await loop.stop();
      loops = []; store.close(); store = new BridgeStore(path, fault); store.register(cfg);
    },
  };
  t.after(async () => {
    for (const loop of loops) await loop.stop();
    store.close(); rmSync(dir, { recursive: true, force: true });
  });
  return f;
}
const entries = batch => batch.payload.split('\n\n')[1].split('\n').map(JSON.parse);

test('native config validates IDs, budgets, retry limits and defaults', () => {
  const env = { DISCORD_BOT_ID: '1', DISCORD_HOME_CHANNEL_ID: '2', KINDROID_AI_ID: 'kin' };
  assert.equal(loadNativeConfig(env).maxChars, 4000);
  for (const value of ['', '0', '255', '1.5', 'NaN']) {
    assert.throws(() => loadNativeConfig({ ...env, KINDROID_MESSAGE_MAX_CHARS: value }), /integer/);
  }
  assert.throws(() => loadNativeConfig({}), /required/);
  assert.throws(() => loadNativeConfig({ ...env, RETRY_BASE_MS: '500', RETRY_MAX_MS: '100' }), /integer/);
});

test('schema, WAL, full sync, exclusive process owner, and durable boundary', async t => {
  const f = fixture(t);
  assert.throws(() => new BridgeStore(f.path), /already owned/);
  assert.equal(f.store.ingest('bridge', message(10, 'dm', { isDM: true })), 'ignored');
  assert.equal(f.store.ingest('bridge', message(11, 'other', { channelId: '801' })), 'ignored');
  assert.equal(f.store.ingest('bridge', message(12, 'own', { authorId: '900' })), 'ignored');
  assert.equal(f.store.bridge('bridge').boundary, null);
  assert.equal(f.store.ingest('bridge', message(20)), 'saved');
  assert.equal(f.store.ingest('bridge', message(20)), 'duplicate');
  f.store.ingest('bridge', message(21, 'own', { authorId: '900' }));
  assert.equal(f.store.pending('bridge').length, 1);
  await f.reopen();
  assert.equal(f.store.bridge('bridge').boundary, '20');
  assert.equal(f.store.ingest('bridge', message(19)), 'ignored');
  assert.equal(f.store.ingest('bridge', message(20)), 'duplicate');
  const db = new DatabaseSync(f.path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  db.close();
});

test('five messages during generation persist immediately and drain with one request at a time', async t => {
  const f = fixture(t);
  const gate = deferred();
  f.kin.onSend = async () => f.kin.calls.length === 1 ? gate.promise : { text: 'none.' };
  const loop = f.loop();
  loop.ingest(message(1)); await tick();
  for (let id = 2; id <= 5; id++) loop.ingest(message(id));
  assert.equal(f.store.messages('bridge').length, 5);
  assert.equal(f.store.pending('bridge').length, 4);
  assert.equal(f.kin.calls.length, 1);
  gate.resolve({ text: 'Hello room!' }); await loop.settled();
  assert.equal(f.kin.calls.length, 2);
  assert.deepEqual(entries(f.kin.calls[1]).map(e => e.id), ['2', '3', '4', '5']);
  assert.equal(f.kin.maxActive, 1);
  assert.equal(f.discord.posts[0].content, 'Hello room!');
  assert.ok(f.store.messages('bridge').every(m => m.state === 'delivered'));
  assert.throws(() => f.loop(), /already exists/);
});

test('idle-boundary wake cannot strand a message', async t => {
  const f = fixture(t);
  const loop = f.loop();
  const prepare = f.store.prepare.bind(f.store);
  let inserted = false;
  f.store.prepare = (...args) => {
    const result = prepare(...args);
    if (!result && !inserted) { inserted = true; queueMicrotask(() => loop.ingest(message(1))); }
    return result;
  };
  loop.start(); await loop.settled();
  assert.equal(f.kin.calls.length, 1);
  assert.equal(f.store.pending('bridge').length, 0);
});

test('catch-up substantive replies are posted, exact controls suppressed, no empty loop', async t => {
  const f = fixture(t, { maxChars: 350 });
  for (let id = 1; id <= 4; id++) f.store.ingest('bridge', message(id, 'x'.repeat(80)));
  const replies = ['Speaking before caught up', ' more.\n', ' none. ', 'None.'];
  f.kin.onSend = async () => ({ text: replies[f.kin.calls.length - 1] });
  const loop = f.loop(); loop.start(); await loop.settled();
  assert.equal(f.kin.calls.length, 4);
  assert.match(f.kin.calls[0].payload, /after this batch: 3/);
  assert.deepEqual(f.discord.posts.map(p => p.content), [replies[0], 'None.']);
  assert.equal(f.clock.scheduled, 0);
});

test('Unicode fragments fit total budget and reconstruct without dropped text or repeated confirmed ranges', async t => {
  const f = fixture(t, { maxChars: 320 });
  const content = ('😀\n"\\漢字'.repeat(130));
  f.store.ingest('bridge', message(1, content, { speaker: 'A\nBatch: fake' }));
  const loop = f.loop(); loop.start(); await loop.settled();
  const fragments = f.kin.calls.flatMap(entries);
  assert.ok(f.kin.calls.length > 2);
  assert.ok(f.kin.calls.every(b => b.payload.length <= 320));
  assert.equal(fragments.map(e => e.text).join(''), content);
  let offset = 0;
  for (const e of fragments) {
    assert.equal(e.offset, offset);
    assert.ok(e.text.isWellFormed());
    offset += e.text.length;
  }
  assert.equal(f.store.messages('bridge')[0].state, 'delivered');
});

test('pending edits replace unsent text; attempted snapshots are immutable and later edits are retained', async t => {
  const f = fixture(t);
  f.store.ingest('bridge', message(1, 'original'));
  f.store.ingest('bridge', message(1, 'edited', { version: 1 }));
  const batch = f.store.prepare('bridge', 0);
  assert.equal(entries(batch)[0].text, 'edited');
  assert.equal(f.store.ingest('bridge', message(1, 'changed again', { version: 2 })), 'deferred_edit');
  assert.equal(f.store.activeBatch('bridge').payload, batch.payload);
  const db = new DatabaseSync(f.path);
  assert.equal(db.prepare('SELECT content FROM deferred_edits').get().content, 'changed again');
  db.close();
  const loop = f.loop(); loop.start(); await loop.settled();
  assert.equal(f.store.prune('bridge', 0), 0);
});

test('definite rejection retries identical batch on persisted deadline, even after restart', async t => {
  const f = fixture(t);
  f.kin.onSend = async () => { throw new RejectedRequest('rate limited', 500); };
  let loop = f.loop(); loop.ingest(message(1)); await loop.settled();
  const first = f.kin.calls[0];
  assert.equal(f.store.activeBatch('bridge').retry_at, 500);
  await f.reopen();
  f.kin.onSend = async () => ({ text: 'none.' });
  loop = f.loop(); loop.start(); await loop.settled();
  f.clock.advance(499); await loop.settled(); assert.equal(f.kin.calls.length, 1);
  f.clock.advance(1); await loop.settled();
  assert.equal(f.kin.calls.length, 2);
  assert.equal(f.kin.calls[1].id, first.id);
  assert.equal(f.kin.calls[1].payload, first.payload);
});

test('lost native acknowledgment reconciles accepted batch without duplicate send', async t => {
  const f = fixture(t);
  f.kin.onSend = async batch => {
    f.kin.history.set(batch.id, { text: 'Recovered reply', nativeId: 'native-1' });
    throw new Error('connection lost after acceptance');
  };
  let loop = f.loop(); loop.ingest(message(1)); await loop.settled();
  assert.equal(f.store.activeBatch('bridge').state, 'uncertain');
  await f.reopen();
  loop = f.loop(); loop.start(); await loop.settled();
  f.clock.advance(100); await loop.settled();
  assert.equal(f.kin.calls.length, 1);
  assert.equal(f.kin.checks.length, 1);
  assert.equal(f.discord.posts[0].content, 'Recovered reply');
  assert.equal(f.store.batches('bridge')[0].native_id, 'native-1');
});

test('unknown history blocks after bounded checks without resending; intake stays available', async t => {
  const f = fixture(t);
  f.kin.onSend = async () => { throw new Error('timeout'); };
  const loop = f.loop(); loop.ingest(message(1)); await loop.settled();
  for (let i = 0; i < 3; i++) { f.clock.advance(1000); await loop.settled(); }
  assert.equal(f.kin.calls.length, 1);
  assert.equal(f.kin.checks.length, 3);
  assert.equal(f.store.activeBatch('bridge').state, 'blocked');
  assert.equal(f.clock.scheduled, 0);
  loop.ingest(message(2)); await loop.settled();
  assert.equal(f.store.pending('bridge').length, 1);
  assert.equal(f.kin.calls.length, 1);
});

test('auth failures block, and empty/API-error replies are never posted or blindly retried', async t => {
  for (const outcome of [new PermanentFailure('unauthorized'), { text: '' }, { text: '<<ERROR>> generation failed' }]) {
    await t.test(String(outcome.text ?? outcome.message), async t => {
      const f = fixture(t);
      f.kin.onSend = async () => { if (outcome instanceof Error) throw outcome; return outcome; };
      const loop = f.loop(); loop.ingest(message(1)); await loop.settled();
      assert.equal(f.discord.posts.length, 0);
      assert.equal(f.store.activeBatch('bridge').state, outcome instanceof Error ? 'blocked' : 'uncertain');
    });
  }
});

test('long replies preserve Unicode/mentions; partial posting resumes after lost acknowledgment and restart', async t => {
  const f = fixture(t);
  const text = 'a'.repeat(1998) + '😀<@123456789>' + 'b'.repeat(2300);
  f.kin.onSend = async () => ({ text });
  f.discord.onPost = async chunk => {
    const result = f.discord.accept(chunk);
    if (chunk.position === 1) throw new Error('post accepted but acknowledgment lost');
    return result;
  };
  let loop = f.loop(); loop.ingest(message(1)); await loop.settled();
  const batch = f.store.batches('bridge')[0];
  const before = f.store.chunks(batch.id);
  assert.equal(before[0].state, 'confirmed');
  assert.equal(before[1].state, 'uncertain');
  assert.equal(before[2].state, 'prepared');
  assert.ok(before.every(c => c.content.length <= 2000 && c.content.isWellFormed() && c.nonce.length <= 25));
  assert.equal(before.map(c => c.content).join(''), text);
  await f.reopen();
  f.discord.onPost = undefined;
  loop = f.loop(); loop.start(); await loop.settled();
  f.clock.advance(100); await loop.settled();
  assert.equal(f.kin.calls.length, 1);
  assert.equal(f.discord.calls.length, 3);
  assert.equal(f.discord.posts.map(p => p.content).join(''), text);
  assert.deepEqual(f.store.chunks(batch.id).map(c => c.nonce), before.map(c => c.nonce));
  assert.ok(f.store.chunks(batch.id).every(c => c.state === 'confirmed'));
  const mentionSplit = splitReply('a'.repeat(1998) + '<@123456789>' + 'z');
  assert.equal(mentionSplit[1], '<@123456789>z');
});

test('pending Discord replies finish before a new native generation', async t => {
  const f = fixture(t);
  f.kin.onSend = async () => ({ text: 'A reply' });
  f.discord.onPost = async () => { throw new RejectedRequest('Discord unavailable'); };
  const loop = f.loop(); loop.ingest(message(1)); await loop.settled();
  loop.ingest(message(2)); await loop.settled();
  assert.equal(f.kin.calls.length, 1);
  f.discord.onPost = undefined;
  f.clock.advance(100); await loop.settled();
  assert.equal(f.kin.calls.length, 2);
  assert.equal(f.discord.posts.length, 2);
});

test('recovery cursor and page inserts commit together; backfill gate preserves order', async t => {
  let fail = false;
  const f = fixture(t, {}, point => { if (fail && point === 'recoveryPage:beforeCommit') throw new Error('crash'); });
  f.store.ingest('bridge', message(10));
  f.store.setRecovering('bridge');
  const loop = f.loop(); loop.ingest(message(13)); await loop.settled();
  assert.equal(f.kin.calls.length, 0);
  fail = true;
  assert.throws(() => f.store.recoverPage('bridge', [message(11), message(12)], '12', true), /crash/);
  assert.equal(f.store.bridge('bridge').recovery_cursor, null);
  assert.deepEqual(f.store.messages('bridge').map(m => m.id), ['10', '13']);
  fail = false;
  f.store.recoverPage('bridge', [message(11), message(12)], '12', true);
  loop.wake(); await loop.settled();
  assert.deepEqual(entries(f.kin.calls[0]).map(e => e.id), ['10', '11', '12', '13']);
  await f.reopen(); assert.equal(f.store.bridge('bridge').recovery_cursor, '12');
});

test('pruning retains pending/uncertain work beyond 1000, and tombstones prevent old replay', async t => {
  const f = fixture(t);
  for (let id = 1; id <= 1005; id++) f.store.ingest('bridge', message(id));
  assert.equal(f.store.prune('bridge'), 0);
  const b = f.store.beginBatch(f.store.prepare('bridge', 0));
  f.store.defer('batch', b, 'uncertain', 100, 'timeout');
  assert.equal(f.store.prune('bridge'), 0);
  assert.equal(f.store.messages('bridge').length, 1005);
  f.store.finishBatch(b, { text: 'none.' });
  assert.equal(f.store.prune('bridge'), 5);
  assert.equal(f.store.messages('bridge').length, 1000);
  assert.equal(f.store.ingest('bridge', message(1)), 'duplicate');
  await f.reopen(); assert.equal(f.store.ingest('bridge', message(1)), 'duplicate');
});

for (const point of ['prepare:beforeCommit', 'prepare:afterCommit', 'beginBatch:beforeCommit', 'beginBatch:afterCommit', 'finishBatch:beforeCommit', 'finishBatch:afterCommit', 'beginChunk:beforeCommit', 'beginChunk:afterCommit', 'finishChunk:beforeCommit', 'finishChunk:afterCommit']) {
  test(`restart recovery at ${point}`, async t => {
    let enabled = true;
    const f = fixture(t, {}, at => { if (enabled && at === point) throw new Error('simulated crash'); });
    f.kin.onSend = async () => ({ text: 'Durable reply' });
    let loop = f.loop(); loop.ingest(message(1));
    await assert.rejects(loop.settled(), /simulated crash/);
    enabled = false;
    await f.reopen();
    loop = f.loop(); loop.start(); await loop.settled();
    // If the crash happened after marking in-flight but before sending, no remote
    // evidence exists. Conservatively block rather than presume it was not sent.
    if (point === 'beginBatch:afterCommit' || point === 'beginChunk:afterCommit') {
      assert.equal(f.store.activeBatch('bridge')?.state ?? f.store.nextChunk('bridge').state, 'uncertain');
    } else {
      assert.equal(f.kin.calls.length, 1);
      assert.equal(f.discord.posts.length, 1);
      assert.equal(f.store.nextChunk('bridge'), undefined);
      assert.equal(f.store.activeBatch('bridge'), undefined);
    }
  });
}

test('real process exit inside a transaction rolls back; restart recovers in-flight work', async t => {
  const f = fixture(t);
  // Use a second database so this process does not hold the tested connection.
  const path = join(require('node:path').dirname(f.path), 'crash.sqlite');
  const modulePath = require.resolve('../dist/native/store');
  const script = `const {BridgeStore}=require(${JSON.stringify(modulePath)});
    const s=new BridgeStore(process.argv[1], p=>{if(p==='finishBatch:beforeCommit') process.exit(77)});
    s.register(${JSON.stringify(config())}); s.ingest('bridge',${JSON.stringify(message(1))});
    const b=s.beginBatch(s.prepare('bridge',0)); s.finishBatch(b,{text:'remote response'});`;
  const child = spawnSync(process.execPath, ['-e', script, path], { encoding: 'utf8' });
  assert.equal(child.status, 77, child.stderr);
  const recovered = new BridgeStore(path);
  try {
    assert.equal(recovered.activeBatch('bridge').state, 'uncertain');
    assert.equal(recovered.activeBatch('bridge').reply, null);
    assert.equal(recovered.messages('bridge')[0].state, 'uncertain');
    assert.equal(recovered.chunks(recovered.activeBatch('bridge').id).length, 0);
  } finally { recovered.close(); }
});

test('late stale edits cannot overwrite a more recently observed version', t => {
  const f = fixture(t);
  f.store.ingest('bridge', message(1, 'current', { version: 10 }));
  f.store.ingest('bridge', message(1, 'current', { version: 30 }));
  assert.equal(f.store.ingest('bridge', message(1, 'stale change', { version: 20 })), 'duplicate');
  assert.equal(f.store.messages('bridge')[0].content, 'current');
});

test('own Discord event during posting never reenters the native queue', async t => {
  const f = fixture(t);
  f.kin.onSend = async () => ({ text: 'Hello <@700> and @everyone' });
  const loop = f.loop();
  f.discord.onPost = async chunk => {
    const receipt = f.discord.accept(chunk);
    assert.deepEqual(JSON.parse(chunk.allowed_mentions), { parse: [], users: ['700'], repliedUser: false });
    loop.ingest(message(receipt.messageId, chunk.content, { authorId: '900' }));
    return receipt;
  };
  loop.ingest(message(1)); await loop.settled();
  assert.equal(f.kin.calls.length, 1);
  assert.equal(f.store.messages('bridge').length, 2);
  assert.ok(f.store.messages('bridge').every(m => m.state === 'delivered'));
});

test('one kin cannot be registered twice, distinct kins can run independently', async t => {
  const f = fixture(t);
  assert.throws(() => f.store.register(config({ id: 'duplicate' })), /UNIQUE/);
  const otherConfig = config({ id: 'other', channelId: '801', kinId: 'other-kin' });
  f.store.register(otherConfig);
  const otherKin = new FakeKin();
  const otherLoop = new DeliveryLoop(f.store, 'other', otherKin, new FakeDiscord(), f.clock);
  try {
    const loop = f.loop();
    loop.ingest(message(1));
    otherLoop.ingest(message(1, 'other room', { channelId: '801' }));
    await Promise.all([loop.settled(), otherLoop.settled()]);
    assert.equal(f.kin.calls.length, 1);
    assert.equal(otherKin.calls.length, 1);
    assert.equal(entries(otherKin.calls[0])[0].text, 'other room');
  } finally { await otherLoop.stop(); }
});

test('uncertain old Discord posts with unavailable evidence are blocked, never duplicated', async t => {
  const f = fixture(t);
  f.kin.onSend = async () => ({ text: 'Keep this reply' });
  f.discord.onPost = async c => { f.discord.accept(c); throw new Error('lost ack'); };
  f.discord.onReconcile = async () => ({ status: 'unknown' });
  const loop = f.loop(); loop.ingest(message(1)); await loop.settled();
  for (let i = 0; i < 3; i++) { f.clock.advance(200000); await loop.settled(); }
  assert.equal(f.store.nextChunk('bridge').state, 'blocked');
  assert.equal(f.discord.posts.length, 1);
  assert.equal(f.discord.calls.length, 1);
});

test('a confirmed fragment is not replayed after a later fragment fails and restarts', async t => {
  const f = fixture(t, { maxChars: 320 });
  const text = '😀'.repeat(100);
  f.kin.onSend = async () => {
    if (f.kin.calls.length === 2) throw new RejectedRequest('not accepted');
    return { text: 'none.' };
  };
  let loop = f.loop(); loop.ingest(message(1, text)); await loop.settled();
  const confirmedText = entries(f.kin.calls[0])[0].text;
  const failedId = f.kin.calls[1].id;
  assert.equal(f.store.messages('bridge')[0].offset, confirmedText.length);
  await f.reopen(); f.kin.onSend = async () => ({ text: 'none.' });
  loop = f.loop(); loop.start(); await loop.settled();
  f.clock.advance(100); await loop.settled();
  assert.equal(f.kin.calls[2].id, failedId);
  const uniqueBatches = [...new Map(f.kin.calls.map(b => [b.id, b])).values()];
  assert.equal(uniqueBatches.flatMap(entries).map(e => e.text).join(''), text);
});

for (const when of ['beforeCommit', 'afterCommit']) {
  test(`ingest ${when} is atomic and safe to repeat after reopen`, async t => {
    let enabled = true;
    const f = fixture(t, {}, point => { if (enabled && point === `ingest:${when}`) throw new Error('crash'); });
    assert.throws(() => f.store.ingest('bridge', message(1)), /crash/);
    enabled = false; await f.reopen();
    assert.equal(f.store.messages('bridge').length, when === 'beforeCommit' ? 0 : 1);
    f.store.ingest('bridge', message(1));
    assert.equal(f.store.messages('bridge').length, 1);
    assert.equal(f.store.bridge('bridge').boundary, '1');
  });
  test(`retry-state ${when} cannot cause blind resend after accepted request`, async t => {
    let enabled = true;
    const f = fixture(t, {}, point => { if (enabled && point === `defer:${when}`) throw new Error('crash'); });
    f.kin.onSend = async batch => {
      f.kin.history.set(batch.id, { text: 'Recovered' });
      throw new Error('lost acknowledgment');
    };
    let loop = f.loop(); loop.ingest(message(1)); await assert.rejects(loop.settled(), /crash/);
    enabled = false; await f.reopen();
    loop = f.loop(); loop.start(); await loop.settled();
    f.clock.advance(100); await loop.settled();
    assert.equal(f.kin.calls.length, 1);
    assert.equal(f.discord.posts.length, 1);
  });
}

test('prune rollback never loses replay receipts or durable messages', t => {
  let enabled = false;
  const f = fixture(t, {}, point => { if (enabled && point === 'prune:beforeCommit') throw new Error('crash'); });
  f.store.ingest('bridge', message(1));
  const batch = f.store.beginBatch(f.store.prepare('bridge', 0));
  f.store.finishBatch(batch, { text: 'none.' });
  enabled = true;
  assert.throws(() => f.store.prune('bridge', 0), /crash/);
  assert.equal(f.store.messages('bridge').length, 1);
  enabled = false;
  assert.equal(f.store.prune('bridge', 0), 1);
  assert.equal(f.store.ingest('bridge', message(1)), 'duplicate');
});
