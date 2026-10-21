import {
  Client,
  DiscordAPIError,
  Message,
  PermissionFlagsBits,
} from 'discord.js';
import { BridgeStore } from './store';
import { discordMessage } from './discord-ingestion';
import {
  Chunk,
  DiscordTransport,
  PermanentFailure,
  Reconciliation,
  RejectedRequest,
} from './types';

/** Uses the client's rate limiter, but disables automatic 5xx/network retries in the runtime. */
export class DiscordPosting implements DiscordTransport {
  private readonly config;
  constructor(
    private readonly store: BridgeStore,
    private readonly bridgeId: string,
    private readonly client: Client,
  ) {
    this.config = store.config(bridgeId);
  }
  private async channel(id: string) {
    if (id !== this.config.channelId)
      throw new PermanentFailure('Refusing to post outside the home room');
    if (this.client.user?.id !== this.config.botId)
      throw new PermanentFailure(
        'Discord bot identity does not match configuration',
      );
    if (!this.client.isReady())
      throw new RejectedRequest('Discord gateway not ready', 2000);
    const channel = await this.client.channels.fetch(id);
    if (
      !channel ||
      !channel.isTextBased() ||
      channel.isDMBased() ||
      !('send' in channel)
    )
      throw new PermanentFailure('Home room is not a writable guild channel');
    return channel;
  }
  private remember(message: Message, chunk: Chunk): boolean {
    if (
      message.channelId !== this.config.channelId ||
      message.author.id !== this.config.botId ||
      String(message.nonce) !== chunk.nonce ||
      message.content !== chunk.content
    )
      return false;
    this.store.ingest(this.bridgeId, discordMessage(message));
    return true;
  }
  async post(channelId: string, chunk: Chunk): Promise<{ messageId: string }> {
    try {
      const channel = await this.channel(channelId);
      const permission = channel.isThread()
        ? PermissionFlagsBits.SendMessagesInThreads
        : PermissionFlagsBits.SendMessages;
      if (!channel.permissionsFor(this.client.user!)?.has(permission))
        throw new PermanentFailure('Missing Discord send permission');
      const message = await channel.send({
        content: chunk.content,
        nonce: chunk.nonce,
        enforceNonce: true,
        allowedMentions: JSON.parse(chunk.allowed_mentions),
      });
      if (
        message.author.id !== this.config.botId ||
        message.channelId !== channelId ||
        message.content !== chunk.content
      )
        throw new Error('Discord returned an unexpected message');
      // The HTTP ID is authoritative even if Discord omits the nonce from its response.
      this.store.ingest(this.bridgeId, {
        ...discordMessage(message),
        nonce: chunk.nonce,
      });
      return { messageId: message.id };
    } catch (error) {
      if (error instanceof PermanentFailure || error instanceof RejectedRequest)
        throw error;
      if (
        error instanceof DiscordAPIError &&
        [400, 401, 403, 404].includes(error.status)
      )
        throw new PermanentFailure(
          `Discord HTTP ${error.status}; check permissions or message configuration`,
        );
      throw new Error('Discord post failed; outcome unknown');
    }
  }
  async reconcile(
    channelId: string,
    chunk: Chunk,
  ): Promise<Reconciliation<{ messageId: string }>> {
    if (channelId !== this.config.channelId)
      throw new PermanentFailure('Refusing to reconcile outside the home room');
    const receipt = this.store.discordReceipt(chunk.nonce);
    if (receipt) return { status: 'found', result: { messageId: receipt } };
    const channel = await this.channel(channelId);
    let before: string | undefined;
    for (let page = 0; page < 10; page++) {
      const messages = await channel.messages.fetch({
        limit: 100,
        before,
        cache: false,
      });
      if (!messages.size) break;
      for (const message of messages.values()) {
        if (this.remember(message, chunk))
          return { status: 'found', result: { messageId: message.id } };
      }
      const oldest = [...messages.keys()].sort((a, b) =>
        BigInt(a) < BigInt(b) ? -1 : 1,
      )[0];
      if (before && BigInt(oldest) >= BigInt(before)) break;
      before = oldest;
      if (messages.size < 100) break;
    }
    // Never resend based on a missing history match: nonce deduplication is time-limited.
    return { status: 'unknown' };
  }
}
