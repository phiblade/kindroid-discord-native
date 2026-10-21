import { Batch, Chunk, Clock, DiscordTransport, KinTransport, NativeReply, Reconciliation } from './types';

export class FakeClock implements Clock {
  private time = 0;
  private tasks = new Map<number, { at: number; callback: () => void }>();
  private sequence = 0;
  now(): number { return this.time; }
  schedule(delay: number, callback: () => void): () => void {
    const id = ++this.sequence;
    this.tasks.set(id, { at: this.time + delay, callback });
    return () => { this.tasks.delete(id); };
  }
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new Error('Clock cannot move backwards');
    this.time += ms;
    const due = [...this.tasks.entries()].filter(([, task]) => task.at <= this.time).sort((a, b) => a[1].at - b[1].at);
    for (const [id, task] of due) if (this.tasks.delete(id)) task.callback();
  }
  get scheduled(): number { return this.tasks.size; }
}

export class FakeKin implements KinTransport {
  readonly calls: Batch[] = [];
  readonly checks: string[] = [];
  readonly history = new Map<string, NativeReply>();
  active = 0;
  maxActive = 0;
  onSend: (batch: Batch) => Promise<NativeReply> = async () => ({ text: 'none.' });
  onReconcile?: (batch: Batch) => Promise<Reconciliation<NativeReply>>;
  async send(_kinId: string, batch: Batch): Promise<NativeReply> {
    this.calls.push({ ...batch });
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      const reply = await this.onSend(batch);
      this.history.set(batch.id, reply);
      return reply;
    } finally { this.active--; }
  }
  async reconcile(_kinId: string, batch: Batch): Promise<Reconciliation<NativeReply>> {
    this.checks.push(batch.id);
    if (this.onReconcile) return this.onReconcile(batch);
    const result = this.history.get(batch.id);
    return result ? { status: 'found', result } : { status: 'unknown' };
  }
}

export class FakeDiscord implements DiscordTransport {
  readonly calls: Chunk[] = [];
  readonly checks: string[] = [];
  readonly posts: { messageId: string; nonce: string; content: string; at: number }[] = [];
  onPost?: (chunk: Chunk) => Promise<{ messageId: string }>;
  onReconcile?: (chunk: Chunk) => Promise<Reconciliation<{ messageId: string }>>;
  constructor(private readonly clock: Clock = new FakeClock()) {}
  // Models a short nonce window; it is deliberately not permanent idempotency.
  accept(chunk: Chunk): { messageId: string } {
    const prior = this.posts.find(p => p.nonce === chunk.nonce && this.clock.now() - p.at < 180000);
    if (prior) return { messageId: prior.messageId };
    const post = { messageId: String(100000 + this.posts.length), nonce: chunk.nonce, content: chunk.content, at: this.clock.now() };
    this.posts.push(post);
    return { messageId: post.messageId };
  }
  async post(_channelId: string, chunk: Chunk): Promise<{ messageId: string }> {
    this.calls.push({ ...chunk });
    return this.onPost ? this.onPost(chunk) : this.accept(chunk);
  }
  async reconcile(_channelId: string, chunk: Chunk): Promise<Reconciliation<{ messageId: string }>> {
    this.checks.push(chunk.id);
    if (this.onReconcile) return this.onReconcile(chunk);
    const found = this.posts.find(p => p.nonce === chunk.nonce);
    return found ? { status: 'found', result: { messageId: found.messageId } } : { status: 'unknown' };
  }
}
