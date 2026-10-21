import { BridgeStore } from './store';
import { IncomingMessage } from './types';

export interface RoomHistory {
  fetch(before?: string): Promise<IncomingMessage[]>;
}

/** One coordinator per home room. Network waits never hold a SQLite transaction. */
export class HomeRoomIngestion {
  private epoch = 0;
  private online = false;
  private requested = false;
  private running?: Promise<void>;
  private readonly config;
  constructor(
    private readonly store: BridgeStore,
    private readonly id: string,
    private readonly history: RoomHistory,
    private readonly wake: () => void = () => {},
    private readonly log: (
      event: string,
      counts: Record<string, number>,
    ) => void = () => {},
  ) {
    this.config = store.config(id);
    store.setRecovering(id); // Install before starting a delivery loop or logging in.
  }
  private counts(): Record<string, number> {
    return {
      cached: this.store.messages(this.id).length,
      pending: this.store.pending(this.id).length,
    };
  }
  create(message: IncomingMessage): void {
    const result = this.store.ingest(this.id, message);
    if (result !== 'ignored') {
      this.log('ingested', this.counts());
      this.wake();
    }
  }
  edit(message: IncomingMessage): void {
    if (!this.store.bridge(this.id).boundary) return;
    const result = this.store.ingest(this.id, message);
    if (result === 'ignored') return;
    const event =
      result === 'deferred_edit'
        ? 'edit_deferred'
        : result === 'duplicate'
          ? 'edit_unchanged'
          : 'edited';
    this.log(event, this.counts());
    this.wake();
  }
  delete(channelId: string, ids: string[]): void {
    if (channelId !== this.config.channelId) return;
    const boundary = this.store.bridge(this.id).boundary;
    if (!boundary) return;
    const eligible = [...new Set(ids)].filter(
      (id) =>
        BigInt(id) >= BigInt(boundary) && !this.store.isDeleted(this.id, id),
    );
    this.store.observeDeletion(this.id, eligible);
    if (eligible.length)
      this.log('deleted', { messages: eligible.length, ...this.counts() });
  }
  disconnect(): void {
    this.online = false;
    this.epoch++;
    this.store.setRecovering(this.id);
  }
  ready(): Promise<void> {
    this.online = true;
    this.requested = true;
    this.epoch++;
    this.store.setRecovering(this.id);
    if (!this.running) {
      this.running = Promise.resolve()
        .then(async () => {
          do {
            this.requested = false;
            await this.recover();
          } while (this.requested && this.online);
        })
        .finally(() => {
          this.running = undefined;
        });
    }
    return this.running.then(() => {
      // A ready event can arrive after the drain resolves but before its finally.
      if (this.online && this.store.bridge(this.id).recovering)
        return this.ready();
    });
  }
  async stop(): Promise<void> {
    this.disconnect();
    await this.running?.catch(() => {});
  }
  private async recover(): Promise<void> {
    while (this.online) {
      this.requested = false;
      const epoch = this.epoch;
      const bridge = this.store.bridge(this.id);
      // Only a new gateway message may establish a fresh installation's boundary.
      if (!bridge.boundary) {
        this.store.completeRecovery(this.id, null);
        this.wake();
        return;
      }
      const lower = bridge.recovery_cursor ?? bridge.boundary;
      let upper = lower;
      let before: string | undefined;
      while (this.online && epoch === this.epoch) {
        const page = await this.history.fetch(before);
        if (!this.online || epoch !== this.epoch) break;
        for (const message of page) {
          if (
            message.channelId !== this.config.channelId ||
            message.isDM ||
            !/^[1-9]\d{0,19}$/.test(message.id)
          )
            throw new Error('Invalid home-room history page');
          if (before && BigInt(message.id) >= BigInt(before))
            throw new Error('History pagination did not advance');
        }
        page.sort((a, b) =>
          BigInt(a.id) < BigInt(b.id)
            ? -1
            : BigInt(a.id) > BigInt(b.id)
              ? 1
              : 0,
        );
        if (
          !before &&
          page.length &&
          BigInt(page[page.length - 1].id) > BigInt(upper)
        )
          upper = page[page.length - 1].id;
        this.store.stageRecovery(
          this.id,
          page.filter((m) => BigInt(m.id) >= BigInt(lower)),
        );
        this.log('backfill', {
          fetched: page.length,
          cached: this.store.messages(this.id).length,
          pending: this.store.pending(this.id).length,
        });
        if (!page.length || BigInt(page[0].id) <= BigInt(lower)) {
          this.store.completeRecovery(this.id, upper);
          this.wake();
          return;
        }
        before = page[0].id;
      }
    }
  }
}
