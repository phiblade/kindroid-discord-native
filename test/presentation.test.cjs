const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assembleBatch } = require('../dist/native/batching');
const {
  loadPresentation,
  defaultPresentation,
} = require('../dist/native/presentation');
const now = Date.UTC(2026, 9, 22, 9, 42, 15);
const message = (extra = {}) => ({
  bridge_id: 'b',
  id: '123',
  author_id: '700',
  speaker: 'Bob',
  content: 'Hi!\n\nHow are you?',
  timestamp: Date.UTC(2026, 9, 21, 9, 41),
  version: 0,
  observed_version: 0,
  offset: 0,
  state: 'pending',
  ...extra,
});
const batch = (messages, options = defaultPresentation, max = 4000) =>
  assembleBatch('batch-uuid', '800', messages, max, now, options, 'general');

test('default compact payload has positional metadata, line-based mapping and compacted body text', () => {
  assert.equal(
    batch([message()]).payload,
    '2026-10-22T09:42:15Z\nbatch-uuid | 0\n\n700 Bob\n\n09:41 **Bob**\nHi!\nHow are you?',
  );
});

test('all 32 combinations independently control optional metadata in the agreed order', () => {
  const keys = ['messageId', 'date', 'time', 'roomLabel', 'roomId'];
  for (let mask = 0; mask < 32; mask++) {
    const options = Object.fromEntries(
      keys.map((key, i) => [key, !!(mask & (1 << i))]),
    );
    const result = batch([message()], options).payload;
    const room = [
      options.roomLabel ? '#general' : '',
      options.roomId ? '800' : '',
    ]
      .filter(Boolean)
      .join(' | ');
    assert.equal(
      result.split('\n\n')[0],
      ['2026-10-22T09:42:15Z', ...(room ? [room] : []), 'batch-uuid | 0'].join(
        '\n',
      ),
    );
    const heading = [
      options.messageId ? '123' : '',
      options.date ? '10/21' : '',
      options.time ? '09:41' : '',
      '**Bob**',
    ]
      .filter(Boolean)
      .join(' ');
    assert.ok(result.includes('\n\n' + heading + '\nHi!\nHow are you?'));
  }
});

test('speaker names preserve spaces and symbols verbatim while normalizing newlines', () => {
  const names = [
    'First Last',
    'Bob; the Builder=Boss',
    'Alice "Ace"',
    'Back\\Slash',
    'Two\nLines',
  ];
  const messages = names.map((speaker, i) =>
    message({ id: String(100 + i), author_id: String(700 + i), speaker }),
  );
  const result = batch(messages).payload;
  assert.equal(
    result.split('\n\n')[1],
    names.map((name, i) => `${700 + i} ${name.replace('\n', ' ')}`).join('\n'),
  );
});

test('speaker mapping deduplicates names and disambiguates different authors with the same name', () => {
  const result = batch([
    message(),
    message({ id: '124' }),
    message({ id: '125', author_id: '701' }),
  ]).payload;
  assert.equal(result.split('\n\n')[1], '700 Bob (700)\n701 Bob (701)');
  assert.equal(result.split('**Bob \\(700\\)**').length - 1, 2);
});

test('mapping only includes included speakers and all metadata counts toward the batch budget', () => {
  const one = batch([message({ content: 'a'.repeat(200) })]);
  const second = message({
    id: '124',
    author_id: '701',
    speaker: 'Phil',
    content: 'b'.repeat(200),
  });
  const result = batch(
    [message({ content: 'a'.repeat(200) }), second],
    defaultPresentation,
    one.payload.length,
  );
  assert.equal(result.members.length, 1);
  assert.ok(!result.payload.includes('Phil'));
  assert.ok(result.payload.length <= one.payload.length);
  const all = Object.fromEntries(
    Object.keys(defaultPresentation).map((k) => [k, true]),
  );
  const fragment = batch(
    [message({ content: '😀\n'.repeat(500), version: now })],
    all,
    300,
  );
  assert.ok(fragment.payload.length <= 300);
  assert.ok(fragment.payload.isWellFormed());
  assert.match(fragment.payload, /\[0\|more\]/);
});

test('presentation environment defaults, parsing and invalid values are explicit', () => {
  assert.deepEqual(loadPresentation({}), defaultPresentation);
  const env = {
    CONTENT_PREPEND_MESSAGE_ID: 'YES',
    CONTENT_PREPEND_DATE: 'yes',
    CONTENT_PREPEND_TIME: 'no',
    CONTENT_PREPEND_ROOM_LABEL: 'yes',
    CONTENT_PREPEND_ROOM_ID: 'yes',
  };
  assert.deepEqual(loadPresentation(env), {
    messageId: true,
    date: true,
    time: false,
    roomLabel: true,
    roomId: true,
  });
  for (const key of Object.keys(env))
    assert.throws(
      () => loadPresentation({ [key]: 'maybe' }),
      /must be yes or no/,
    );
});

test('body newline compaction handles CRLF and CR without changing section separators or source', () => {
  const source = message({ content: 'one\r\n\r\ntwo\r\rthree\n\nfour' });
  const result = batch([source, message({ id: '124', content: 'next' })]);
  assert.ok(
    result.payload.endsWith(
      '09:41 **Bob**\none\ntwo\nthree\nfour\n\n09:41 **Bob**\nnext',
    ),
  );
  assert.equal(source.content, 'one\r\n\r\ntwo\r\rthree\n\nfour');
  assert.equal(result.members[0].end, source.content.length);
});

test('fragment ranges preserve source offsets while collapsing a newline run across a boundary', () => {
  const content = 'hello\r\n\r\nworld';
  const source = message({ content, offset: 6 }); // earlier saved fragment ended after CR
  const result = batch([source]);
  assert.ok(result.payload.endsWith('[6|end]\nworld'));
  assert.equal(result.members[0].start, 6);
  assert.equal(result.members[0].end, content.length);
});
