export interface BridgeConfig {
  id: string;
  botId: string;
  channelId: string;
  kinId: string;
  maxChars: number;
  retryBaseMs: number;
  retryMaxMs: number;
  maxReconcileChecks: number;
}

export interface IncomingMessage {
  id: string;
  channelId: string;
  authorId: string;
  speaker: string;
  content: string;
  timestamp: number;
  isDM?: boolean;
  version?: number;
  nonce?: string;
}

export interface StoredMessage {
  bridge_id: string;
  id: string;
  author_id: string;
  speaker: string;
  content: string;
  timestamp: number;
  version: number;
  observed_version: number;
  offset: number;
  state: 'pending' | 'in_flight' | 'uncertain' | 'delivered';
}

export type OperationState =
  'prepared' | 'in_flight' | 'uncertain' | 'confirmed' | 'blocked';
export interface Batch {
  id: string;
  bridge_id: string;
  payload: string;
  state: OperationState;
  attempts: number;
  checks: number;
  retry_at: number;
  error: string | null;
  reply: string | null;
  native_id: string | null;
  created_at: number;
}
export interface Chunk {
  id: string;
  batch_id: string;
  position: number;
  content: string;
  nonce: string;
  allowed_mentions: string;
  state: OperationState;
  attempts: number;
  checks: number;
  retry_at: number;
  error: string | null;
  discord_id: string | null;
}
export interface BatchMember {
  messageId: string;
  version: number;
  start: number;
  end: number;
}
export interface NativeReply {
  text: string;
  nativeId?: string;
}
// A missing history match is deliberately NOT evidence that sending is safe.
export type Reconciliation<T> =
  { status: 'found'; result: T } | { status: 'unknown' };
export interface KinTransport {
  send(kinId: string, batch: Batch): Promise<NativeReply>;
  reconcile(kinId: string, batch: Batch): Promise<Reconciliation<NativeReply>>;
}
export interface DiscordTransport {
  post(channelId: string, chunk: Chunk): Promise<{ messageId: string }>;
  reconcile(
    channelId: string,
    chunk: Chunk,
  ): Promise<Reconciliation<{ messageId: string }>>;
}
export interface Clock {
  now(): number;
  schedule(delayMs: number, callback: () => void): () => void;
}
// Only transports that can prove rejection should use RejectedRequest.
export class RejectedRequest extends Error {
  constructor(
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}
export class PermanentFailure extends Error {}

/** Local rate/catch-up scheduling; no remote outcome inference. */
export class RetryLater extends RejectedRequest {}
