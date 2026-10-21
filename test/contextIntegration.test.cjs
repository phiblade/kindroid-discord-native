const { test } = require('node:test');
const assert = require('node:assert/strict');
const discord = require('discord.js');
const clients = [];
class FakeClient {
  constructor() {
    this.user = { id: 'bot', username: 'testbot' };
    this.handlers = {};
    clients.push(this);
  }
  once() {}
  on(event, handler) {
    this.handlers[event] = handler;
  }
  async login() {}
}
class FakeDMChannel {
  async sendTyping() {}
}
require.cache[require.resolve('discord.js')].exports = {
  ...discord,
  Client: FakeClient,
  DMChannel: FakeDMChannel,
};
let payload;
require('axios').post = async (_url, body) => {
  payload = body.conversation;
  return { data: { success: true, reply: 'ok' } };
};
const { initializeAllBots } = require('../dist/discordManager');

test('environment reaches paginated fetch and Kindroid payload in both servers and DMs', async () => {
  process.env.DISCORD_FETCH_BATCH = '7';
  for (const value of ['1', '200', '1000', undefined]) {
    if (value === undefined) delete process.env.KINDROID_MESSAGE_CONTEXT;
    else process.env.KINDROID_MESSAGE_CONTEXT = value;
    await initializeAllBots([
      { id: 'test', discordBotToken: 'fake', sharedAiCode: 'fake' },
    ]);
    for (const isDM of [true, false]) {
      let replied = false;
      payload = undefined;
      const history = Array.from({ length: 1100 }, (_, i) => ({
        id: String(1100 - i),
        author: { id: 'bot' },
        createdAt: new Date(1100 - i),
        content: String(1100 - i),
      }));
      const channel = Object.assign(isDM ? new FakeDMChannel() : {}, {
        id: `${value}-${isDM}`,
        type: isDM ? discord.ChannelType.DM : discord.ChannelType.GuildText,
        isTextBased: () => true,
        isDMBased: () => isDM,
        isThread: () => false,
        permissionsFor: () => ({ has: () => true }),
        client: clients.at(-1),
        messages: {
          fetch: async ({ limit, before }) => {
            assert.ok(limit >= 1 && limit <= 7);
            return new Map(
              history
                .filter((m) => !before || Number(m.id) < Number(before))
                .slice(0, limit)
                .map((m) => [m.id, m]),
            );
          },
        },
      });
      await clients.at(-1).handlers.messageCreate({
        channel,
        author: { id: 'human', bot: false },
        mentions: { users: { has: () => true } },
        content: 'testbot',
        reply: async () => {
          replied = true;
        },
      });
      assert.equal(payload.length, Number(value ?? 200));
      assert.equal(payload.at(-1).text, '[{{ai}}]: 1100');
      assert.equal(replied, true);
    }
  }
});

test('invalid environment settings fail before bot login', async () => {
  for (const value of ['', '0', '1001', '1.5', 'bad']) {
    process.env.KINDROID_MESSAGE_CONTEXT = value;
    await assert.rejects(initializeAllBots([]), /KINDROID_MESSAGE_CONTEXT/);
  }
  delete process.env.KINDROID_MESSAGE_CONTEXT;
  for (const value of ['', '0', '101', '1.5', 'bad']) {
    process.env.DISCORD_FETCH_BATCH = value;
    await assert.rejects(initializeAllBots([]), /DISCORD_FETCH_BATCH/);
  }
  delete process.env.DISCORD_FETCH_BATCH;
});
