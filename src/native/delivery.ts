import { BridgeStore } from './store';
import { Batch, Chunk, Clock, DiscordTransport, IncomingMessage, KinTransport, NativeReply, PermanentFailure, RejectedRequest } from './types';

export const systemClock: Clock = {
  now: () => Date.now(),
  schedule(delay, callback) {
    const timer = setTimeout(callback, delay);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

/** An async loop in the main process, not a thread or a Railway service. */
export class DeliveryLoop {
  private running?: Promise<void>;
  private cancelTimer?: () => void;
  private dirty = false;
  private stopped = false;
  private fatal?: unknown;
  private readonly release: () => void;
  private readonly config;

  constructor(private readonly store: BridgeStore, private readonly bridgeId: string,
    private readonly kin: KinTransport, private readonly discord: DiscordTransport,
    private readonly clock: Clock = systemClock) {
    this.config = store.config(bridgeId);
    this.release = store.claimWorker(bridgeId);
  }

  start(): void { this.wake(); }
  ingest(event: IncomingMessage): ReturnType<BridgeStore['ingest']> {
    if (this.stopped) throw new Error('Delivery loop is stopped');
    const result = this.store.ingest(this.bridgeId, event);
    if (result !== 'ignored') this.wake();
    return result;
  }
  wake(): void {
    if (this.stopped || this.fatal) return;
    this.dirty = true;
    if (this.running) return;
    this.cancelTimer?.(); this.cancelTimer = undefined;
    this.running = Promise.resolve().then(async () => {
      do {
        this.dirty = false;
        await this.drain();
      } while (this.dirty && !this.stopped);
    }).catch(error => { this.fatal = error; }).finally(() => {
      this.running = undefined;
      // Also covers a wake queued between drain resolution and this finally.
      if (this.dirty && !this.stopped && !this.fatal) this.wake();
    });
  }
  /** Wait until the loop is idle or waiting on its clock; useful in simulations. */
  async settled(): Promise<void> {
    while (this.running) await this.running;
    if (this.fatal) throw this.fatal;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelTimer?.(); this.cancelTimer = undefined;
    await this.running;
    this.release();
  }

  private waitUntil(time: number): void {
    if (this.stopped) return;
    this.cancelTimer?.();
    this.cancelTimer = this.clock.schedule(Math.max(1, time - this.clock.now()), () => this.wake());
  }
  private delay(attempt: number): number {
    return Math.min(this.config.retryMaxMs, this.config.retryBaseMs * 2 ** Math.min(30, Math.max(0, attempt - 1)));
  }
  private validReply(reply: NativeReply): void {
    if (typeof reply.text !== 'string' || !reply.text.trim() || /^\s*<<(HTTP_)?ERROR>>/.test(reply.text)) {
      throw new Error('Native response was empty or an API error marker');
    }
  }
  private failed(kind: 'batch' | 'chunk', operation: Batch | Chunk, error: unknown, reconciliation = false): void {
    const description = error instanceof Error ? error.message : String(error);
    let state: 'prepared' | 'uncertain' | 'blocked' = 'uncertain';
    let delay = this.delay(reconciliation ? operation.checks + 1 : operation.attempts);
    if (error instanceof PermanentFailure || (reconciliation && operation.checks + 1 >= this.config.maxReconcileChecks)) state = 'blocked';
    else if (!reconciliation && error instanceof RejectedRequest) {
      state = 'prepared';
      if (error.retryAfterMs !== undefined && Number.isFinite(error.retryAfterMs)) delay = Math.max(delay, error.retryAfterMs);
    }
    const next = this.clock.now() + delay;
    this.store.defer(kind, operation, state, next, description, reconciliation);
    if (state !== 'blocked') this.waitUntil(next);
  }

  private async drain(): Promise<void> {
    while (!this.stopped) {
      const chunk = this.store.nextChunk(this.bridgeId);
      if (chunk) {
        if (chunk.state === 'blocked') return;
        if (chunk.retry_at > this.clock.now()) { this.waitUntil(chunk.retry_at); return; }
        if (!await this.deliverChunk(chunk)) return;
        continue;
      }
      if (this.store.bridge(this.bridgeId).recovering) return;
      const batch = this.store.activeBatch(this.bridgeId) ?? this.store.prepare(this.bridgeId, this.clock.now());
      if (!batch) { this.store.prune(this.bridgeId); return; }
      if (batch.state === 'blocked') return;
      if (batch.retry_at > this.clock.now()) { this.waitUntil(batch.retry_at); return; }
      if (!await this.deliverBatch(batch)) return;
    }
  }

  private async deliverBatch(batch: Batch): Promise<boolean> {
    let reply: NativeReply;
    const uncertain = batch.state === 'uncertain' || batch.state === 'in_flight';
    const operation = uncertain ? batch : this.store.beginBatch(batch);
    try {
      if (uncertain) {
        const recovered = await this.kin.reconcile(this.config.kinId, operation);
        if (recovered.status !== 'found') throw new Error('Native delivery outcome is still unknown');
        reply = recovered.result;
      } else reply = await this.kin.send(this.config.kinId, operation);
      this.validReply(reply);
    } catch (error) { this.failed('batch', operation, error, uncertain); return false; }
    // Database failures must halt the loop, not masquerade as transport rejection.
    this.store.finishBatch(operation, reply);
    return true;
  }

  private async deliverChunk(chunk: Chunk): Promise<boolean> {
    const uncertain = chunk.state === 'uncertain' || chunk.state === 'in_flight';
    const operation = uncertain ? chunk : this.store.beginChunk(chunk);
    let messageId: string;
    try {
      if (uncertain) {
        const recovered = await this.discord.reconcile(this.config.channelId, operation);
        if (recovered.status !== 'found') throw new Error('Discord posting outcome is still unknown');
        messageId = recovered.result.messageId;
      } else messageId = (await this.discord.post(this.config.channelId, operation)).messageId;
      if (!messageId) throw new Error('Discord returned no message ID');
    } catch (error) { this.failed('chunk', operation, error, uncertain); return false; }
    this.store.finishChunk(operation, messageId);
    return true;
  }
}
