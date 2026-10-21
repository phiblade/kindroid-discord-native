import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  Partials,
  PermissionFlagsBits,
} from 'discord.js';
import { BridgeStore } from './store';
import { HomeRoomIngestion } from './ingestion';
import { IncomingMessage } from './types';

export function discordMessage(message: Message): IncomingMessage {
  return {
    id: message.id,
    channelId: message.channelId,
    authorId: message.author.id,
    speaker:
      message.member?.displayName ??
      message.author.globalName ??
      message.author.username,
    content: message.content,
    timestamp: message.createdTimestamp,
    version: message.editedTimestamp ?? 0,
    isDM: !message.inGuild(),
  };
}

/** Intake only: this adapter neither generates Kin replies nor posts Discord messages. */
export function connectDiscordIngestion(
  store: BridgeStore,
  bridgeId: string,
  wake = () => {},
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message],
  }),
) {
  const config = store.config(bridgeId);
  let stopped = false;
  let pendingEdits = 0;
  const editRetries = new Set<ReturnType<typeof setTimeout>>();
  let retry: ReturnType<typeof setTimeout> | undefined;
  const report = (error: unknown) =>
    console.error(
      '[discord-ingestion]',
      error instanceof Error ? error.message : String(error),
    );
  const homeRoom = async () => {
    const channel = await client.channels.fetch(config.channelId);
    if (
      !channel ||
      !channel.isTextBased() ||
      channel.isDMBased() ||
      !('permissionsFor' in channel)
    )
      throw new Error('Home room must be a guild text channel or thread');
    const permissions = channel.permissionsFor(client.user!);
    if (
      !permissions?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
      ])
    )
      throw new Error(
        'Home room requires View Channel and Read Message History permissions',
      );
    return channel;
  };
  const intake = new HomeRoomIngestion(
    store,
    bridgeId,
    {
      async fetch(before) {
        const channel = await homeRoom();
        const page = await channel.messages.fetch({
          limit: 100,
          before,
          cache: false,
        });
        return [...page.values()].map(discordMessage);
      },
    },
    wake,
    (event, counts) => console.log('[discord-ingestion]', event, counts),
  );
  const recover = () => {
    if (stopped || pendingEdits) return;
    if (retry) clearTimeout(retry);
    if (client.user?.id !== config.botId) {
      report(new Error('Logged-in Discord bot does not match DISCORD_BOT_ID'));
      client.destroy();
      return;
    }
    void homeRoom()
      .then(() => {
        if (!stopped && !pendingEdits && client.isReady())
          return intake.ready();
      })
      .catch((error) => {
        report(error);
        if (!stopped && client.isReady())
          retry = setTimeout(recover, config.retryMaxMs);
      });
  };
  const guard = (action: () => void) => {
    if (stopped) return;
    try {
      action();
    } catch (error) {
      // A persistence failure must not permit delivery past an unrecorded event.
      stopped = true;
      try {
        intake.disconnect();
      } catch {
        /* Keep the original persistence error. */
      }
      report(error);
      client.destroy();
    }
  };
  client.on(Events.MessageCreate, (message) =>
    guard(() => intake.create(discordMessage(message))),
  );
  client.on(Events.MessageUpdate, (_old, message) => {
    if (message.channelId !== config.channelId) return;
    if (!message.partial) {
      guard(() => intake.edit(discordMessage(message)));
      return;
    }
    // Hold delivery while resolving partial edits, including transient REST failures.
    pendingEdits++;
    guard(() => intake.disconnect());
    const finish = () => {
      pendingEdits--;
      if (!pendingEdits && !stopped && client.isReady()) recover();
    };
    const fetchEdit = () => {
      if (stopped) return;
      void message
        .fetch()
        .then((full) => {
          if (stopped) return;
          guard(() => intake.edit(discordMessage(full)));
          finish();
        })
        .catch((error) => {
          if (stopped) return;
          if (error?.code === 10008) {
            guard(() => intake.delete(message.channelId, [message.id]));
            finish();
          } else {
            report(error);
            const timer = setTimeout(() => {
              editRetries.delete(timer);
              fetchEdit();
            }, config.retryMaxMs);
            editRetries.add(timer);
          }
        });
    };
    fetchEdit();
  });
  client.on(Events.MessageDelete, (message) =>
    guard(() => intake.delete(message.channelId, [message.id])),
  );
  client.on(Events.MessageBulkDelete, (messages, channel) =>
    guard(() => intake.delete(channel.id, [...messages.keys()])),
  );
  client.on(Events.ClientReady, recover);
  client.on(Events.ShardResume, recover);
  client.on(Events.ShardReady, () => {
    if (client.isReady()) recover();
  });
  client.on(Events.ShardDisconnect, () => guard(() => intake.disconnect()));
  client.on(Events.ShardReconnecting, () => guard(() => intake.disconnect()));
  client.on(Events.Error, report);
  client.on(Events.ShardError, report);
  return {
    client,
    intake,
    async stop() {
      stopped = true;
      for (const timer of editRetries) clearTimeout(timer);
      if (retry) clearTimeout(retry);
      client.destroy();
      await intake.stop();
    },
  };
}
