const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { BridgeStore } = require('../dist/native/store');
const { HomeRoomIngestion } = require('../dist/native/ingestion');
const { DeliveryLoop } = require('../dist/native/delivery');
const { FakeClock, FakeKin, FakeDiscord } = require('../dist/native/fakes');
const { DatabaseSync } = require('node:sqlite');
const cfg = {
  id: 'b',
  botId: '900',
  channelId: '800',
  kinId: 'kin',
  maxChars: 4000,
  retryBaseMs: 100,
  retryMaxMs: 1000,
  maxReconcileChecks: 3,
};
const msg = (id, extra = {}) => ({
  id: String(id),
  channelId: '800',
  authorId: '700',
  speaker: 'Bob',
  content: `hello ${id}`,
  timestamp: Number(id),
  ...extra,
});
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'intake-'));
  const path = join(dir, 'db.sqlite');
  let store = new BridgeStore(path);
  store.register(cfg);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    get store() {
      return store;
    },
    path,
    reopen(fault) {
      store.close();
      store = new BridgeStore(path, fault);
      store.register(cfg);
    },
  };
}
function gate() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test('fresh room ignores history, DMs, other rooms, own initial messages and edits', async (t) => {
  const f = fixture(t);
  const intake = new HomeRoomIngestion(f.store, 'b', {
    fetch() {
      throw Error('must not backfill before boundary');
    },
  });
  intake.edit(msg(5));
  intake.create(msg(6, { isDM: true }));
  intake.create(msg(7, { channelId: '801' }));
  intake.create(msg(8, { authorId: '900' }));
  await intake.ready();
  assert.equal(f.store.bridge('b').boundary, null);
  intake.create(msg(10));
  intake.create(msg(10));
  intake.create(msg(11, { authorId: '900' }));
  assert.equal(f.store.bridge('b').boundary, '10');
  assert.deepEqual(
    f.store.pending('b').map((m) => m.id),
    ['10'],
  );
});

test('multiple descending pages plus overlapping live events are delivered chronologically only after catchup', async (t) => {
  const f = fixture(t);
  f.store.ingest('b', msg(10));
  const clock = new FakeClock(),
    kin = new FakeKin(),
    discord = new FakeDiscord(clock);
  const pause = gate();
  const calls = [];
  let loop;
  const intake = new HomeRoomIngestion(
    f.store,
    'b',
    {
      async fetch(before) {
        calls.push(before);
        if (!before) {
          await pause.promise;
          return [msg(14), msg(13)];
        }
        if (before === '13') return [msg(12), msg(11)];
        return [msg(10), msg(9)];
      },
    },
    () => loop?.wake(),
  );
  loop = new DeliveryLoop(f.store, 'b', kin, discord, clock);
  try {
    loop.start();
    const recovery = intake.ready();
    intake.create(msg(15));
    intake.create(msg(13));
    await loop.settled();
    assert.equal(kin.calls.length, 0);
    assert.equal(f.store.bridge('b').recovery_cursor, null);
    pause.resolve();
    await recovery;
    await loop.settled();
    assert.deepEqual(calls, [undefined, '13', '11']);
    const entries = kin.calls.flatMap((b) =>
      b.payload.split('\n\n')[1].split('\n').map(JSON.parse),
    );
    assert.deepEqual(
      entries.map((m) => m.id),
      ['10', '11', '12', '13', '14', '15'],
    );
    assert.equal(f.store.bridge('b').recovery_cursor, '14');
  } finally {
    await loop.stop();
  }
});

test('failed page keeps delivery gated and restart safely repeats durable pages', async (t) => {
  const f = fixture(t);
  f.store.ingest('b', msg(10));
  const first = new HomeRoomIngestion(f.store, 'b', {
    async fetch(before) {
      if (!before) return [msg(14), msg(13)];
      throw Error('network outage');
    },
  });
  await assert.rejects(first.ready(), /outage/);
  assert.equal(f.store.bridge('b').recovery_cursor, null);
  assert.equal(f.store.prepare('b', 1), undefined);
  f.reopen();
  const second = new HomeRoomIngestion(f.store, 'b', {
    async fetch(before) {
      return before ? [msg(12), msg(11), msg(10)] : [msg(14), msg(13)];
    },
  });
  await second.ready();
  assert.deepEqual(
    f.store.pending('b').map((m) => m.id),
    ['10', '11', '12', '13', '14'],
  );
});

test('reconnect invalidates an outstanding history response and scans a fresh upper boundary', async (t) => {
  const f = fixture(t);
  f.store.ingest('b', msg(10));
  const pause = gate();
  let count = 0;
  const intake = new HomeRoomIngestion(f.store, 'b', {
    async fetch() {
      if (++count === 1) {
        await pause.promise;
        return [msg(12), msg(10)];
      }
      return [msg(14), msg(13), msg(12), msg(11), msg(10)];
    },
  });
  const first = intake.ready();
  await new Promise((resolve) => setImmediate(resolve));
  intake.disconnect();
  const next = intake.ready();
  pause.resolve();
  await Promise.all([first, next]);
  assert.equal(count, 2);
  assert.equal(f.store.bridge('b').recovery_cursor, '14');
  assert.deepEqual(
    f.store.pending('b').map((m) => m.id),
    ['10', '11', '12', '13', '14'],
  );
});

test('edits and deletions cannot rewrite prepared payloads or resurrect deleted messages', async (t) => {
  const f = fixture(t);
  const intake = new HomeRoomIngestion(f.store, 'b', {
    async fetch() {
      return [];
    },
  });
  await intake.ready();
  intake.create(msg(10));
  intake.create(msg(11));
  intake.edit(msg(10, { content: 'edited', version: 1 }));
  intake.delete('801', ['10']);
  intake.delete('800', ['11', '12']);
  intake.create(msg(12));
  assert.equal(f.store.messages('b')[0].content, 'edited');
  assert.deepEqual(
    f.store.pending('b').map((m) => m.id),
    ['10'],
  );
  const batch = f.store.prepare('b', 1);
  intake.edit(msg(10, { content: 'late edit', version: 2 }));
  intake.delete('800', ['10']);
  assert.equal(f.store.activeBatch('b').payload, batch.payload);
  f.reopen();
  assert.equal(f.store.isDeleted('b', '12'), true);
  assert.equal(f.store.messages('b')[0].content, 'edited');
});

test('empty history after deletions does not move completed cursor backward', async (t) => {
  const f = fixture(t);
  f.store.ingest('b', msg(10));
  f.store.setRecovering('b');
  f.store.recoverPage('b', [msg(20)], '20', true);
  const intake = new HomeRoomIngestion(f.store, 'b', {
    async fetch() {
      return [];
    },
  });
  await intake.ready();
  assert.equal(f.store.bridge('b').recovery_cursor, '20');
});

test('v1 databases upgrade without losing queued messages or boundaries', (t) => {
  const f = fixture(t);
  f.store.ingest('b', msg(10));
  const db = new DatabaseSync(f.path);
  db.exec('DROP TABLE message_deletions; PRAGMA user_version=1;');
  db.close();
  f.reopen();
  assert.equal(f.store.bridge('b').boundary, '10');
  assert.equal(f.store.pending('b').length, 1);
  f.store.observeDeletion('b', ['10']);
  assert.equal(f.store.pending('b').length, 0);
});

test('Discord adapter normalizes speakers, filters events, fetches partial edits and gates reconnects', async (t) => {
  const { EventEmitter } = require('node:events');
  const { Events } = require('discord.js');
  const {
    connectDiscordIngestion,
  } = require('../dist/native/discord-ingestion');
  const f = fixture(t);
  const client = new EventEmitter();
  let connected = true;
  client.user = { id: '900' };
  client.isReady = () => connected;
  client.destroy = () => {
    connected = false;
  };
  let page = [];
  const fetchCalls = [];
  client.channels = {
    async fetch() {
      return {
        isTextBased: () => true,
        isDMBased: () => false,
        permissionsFor: () => ({ has: () => true }),
        messages: {
          async fetch(options) {
            fetchCalls.push(options);
            return new Map(page.map((m) => [m.id, m]));
          },
        },
      };
    },
  };
  const message = (id, extra = {}) => ({
    id: String(id),
    channelId: '800',
    author: { id: '700', username: 'Bob', globalName: 'Robert' },
    member: { displayName: 'Bobby' },
    content: 'hello',
    createdTimestamp: id,
    editedTimestamp: null,
    inGuild: () => true,
    partial: false,
    ...extra,
  });
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const adapter = connectDiscordIngestion(f.store, 'b', () => {}, client);
  try {
    client.emit(Events.ClientReady);
    await tick();
    client.emit(Events.MessageCreate, message(10));
    client.emit(Events.MessageCreate, message(11, { channelId: '801' }));
    assert.equal(f.store.messages('b')[0].speaker, 'Bobby');
    assert.equal(f.store.messages('b').length, 1);
    const pause = gate();
    client.emit(
      Events.MessageUpdate,
      {},
      { ...message(10), partial: true, fetch: () => pause.promise },
    );
    assert.equal(f.store.bridge('b').recovering, 1);
    client.emit(Events.ShardResume);
    await tick();
    assert.equal(f.store.bridge('b').recovering, 1);
    pause.resolve(message(10, { content: 'edited', editedTimestamp: 1 }));
    await tick();
    await tick();
    assert.equal(f.store.messages('b')[0].content, 'edited');
    assert.equal(f.store.bridge('b').recovering, 0);
    client.emit(Events.ShardDisconnect);
    assert.equal(f.store.bridge('b').recovering, 1);
    page = [
      message(12),
      message(10, { content: 'edited', editedTimestamp: 1 }),
    ];
    client.emit(Events.ShardResume);
    await tick();
    await tick();
    assert.equal(f.store.bridge('b').recovery_cursor, '12');
    assert.deepEqual(fetchCalls[0], {
      limit: 100,
      before: undefined,
      cache: false,
    });
    client.emit(
      Events.MessageBulkDelete,
      new Map([
        ['10', {}],
        ['12', {}],
      ]),
      { id: '800' },
    );
    assert.equal(f.store.pending('b').length, 0);
  } finally {
    await adapter.stop();
  }
});

test('delete after the first fragment preserves the immutable remaining source', async (t) => {
  const f = fixture(t);
  f.store.ingest('b', msg(10, { content: 'x'.repeat(8000) }));
  const batch = f.store.prepare('b', 0);
  f.store.beginBatch(batch);
  f.store.observeDeletion('b', ['10']);
  f.store.finishBatch(batch, { text: 'more.' });
  assert.equal(f.store.pending('b').length, 1);
  const next = f.store.prepare('b', 1);
  assert.equal(
    f.store.members(next.id)[0].start_offset,
    f.store.members(batch.id)[0].end_offset,
  );
});

for (const phase of ['beforeCommit', 'afterCommit']) {
  test(`recovery completion ${phase} survives reopening without skipped messages`, (t) => {
    const f = fixture(t);
    f.store.ingest('b', msg(10));
    let armed = true;
    f.reopen((point) => {
      if (armed && point === `completeRecovery:${phase}`) {
        armed = false;
        throw Error('crash');
      }
    });
    f.store.setRecovering('b');
    f.store.stageRecovery('b', [msg(11), msg(12)]);
    assert.throws(() => f.store.completeRecovery('b', '12'), /crash/);
    f.reopen();
    assert.deepEqual(
      f.store.pending('b').map((m) => m.id),
      ['10', '11', '12'],
    );
    assert.equal(
      f.store.bridge('b').recovering,
      phase === 'beforeCommit' ? 1 : 0,
    );
    assert.equal(
      f.store.bridge('b').recovery_cursor,
      phase === 'beforeCommit' ? null : '12',
    );
  });
}

test('duplicate readiness notifications on an empty installation cannot strand the recovery gate', async (t) => {
  const f = fixture(t);
  const intake = new HomeRoomIngestion(f.store, 'b', {
    async fetch() {
      throw Error('no history expected');
    },
  });
  await Promise.all([intake.ready(), intake.ready()]);
  assert.equal(f.store.bridge('b').recovering, 0);
  intake.create(msg(10));
  assert.ok(f.store.prepare('b', 0));
});
