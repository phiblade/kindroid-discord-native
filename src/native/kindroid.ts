import { BridgeStore } from './store';
import {
  Batch,
  KinTransport,
  NativeReply,
  PermanentFailure,
  Reconciliation,
  RejectedRequest,
  RetryLater,
} from './types';

type HistoryMessage = {
  id: string;
  sender: string;
  sender_type: string;
  timestamp: number;
  message: string;
};
type HistoryPage = {
  messages: HistoryMessage[];
  pagination: { hasMore: boolean; lastTimestamp: number | null };
};

export function parseHistory(value: unknown): HistoryPage {
  const page = value as HistoryPage;
  if (
    !page ||
    !Array.isArray(page.messages) ||
    !page.pagination ||
    typeof page.pagination.hasMore !== 'boolean'
  )
    throw new Error('Invalid Kindroid history response');
  for (const m of page.messages) {
    if (
      !m ||
      typeof m.id !== 'string' ||
      !m.id ||
      typeof m.sender !== 'string' ||
      typeof m.sender_type !== 'string' ||
      typeof m.message !== 'string' ||
      !Number.isFinite(m.timestamp)
    )
      throw new Error('Invalid Kindroid history message');
  }
  if (
    page.messages.some(
      (m, i) => i > 0 && m.timestamp < page.messages[i - 1].timestamp,
    )
  )
    throw new Error('Kindroid history is not chronological');
  if (
    page.messages.length &&
    (!Number.isFinite(page.pagination.lastTimestamp) ||
      page.pagination.lastTimestamp !==
        page.messages[page.messages.length - 1].timestamp)
  )
    throw new Error('Invalid Kindroid history cursor');
  return page;
}

export function retryAfter(value: string | null, now: number): number {
  if (value === null) return 30000;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - now;
  return Number.isFinite(delay) && delay >= 0 ? Math.max(1000, delay) : 30000;
}

/** One account per SQLite database. No automatic HTTP retries or conversation mutations on recovery. */
export class NativeKindroid implements KinTransport {
  constructor(
    private readonly store: BridgeStore,
    private readonly apiKey: string,
    private readonly options: {
      fetch?: typeof fetch;
      now?: () => number;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ) {
    if (!apiKey.trim()) throw new Error('KINDROID_API_KEY is required');
  }
  private async request(path: string, body?: object): Promise<Response> {
    const now = this.options.now?.() ?? Date.now();
    const wait = this.store.reserveApiRequest(now, body === undefined);
    if (wait)
      throw new RetryLater('Kindroid account rate limit; waiting', wait);
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 180000);
    const signal = this.options.signal
      ? AbortSignal.any([timeout, this.options.signal])
      : timeout;
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(
        `https://api.kindroid.ai/v1/${path}`,
        {
          method: body === undefined ? 'GET' : 'POST',
          redirect: 'error',
          signal,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
    } catch {
      throw new Error('Kindroid request interrupted; outcome unknown');
    }
    if (response.status === 429) {
      const delay = retryAfter(response.headers.get('retry-after'), now);
      this.store.deferApiUntil(now + delay);
      await response.body?.cancel();
      throw new RejectedRequest('Kindroid HTTP 429', delay);
    }
    if (!response.ok) {
      await response.body?.cancel();
      if ([400, 401, 403, 404, 413, 422].includes(response.status))
        throw new PermanentFailure(
          `Kindroid HTTP ${response.status}; check configuration or request budget`,
        );
      throw new Error(`Kindroid HTTP ${response.status}; outcome unknown`);
    }
    return response;
  }
  async send(kinId: string, batch: Batch): Promise<NativeReply> {
    const response = await this.request('send-message', {
      ai_id: kinId,
      message: batch.payload,
      stream: false,
    });
    if (response.headers.get('content-type')?.includes('application/json')) {
      await response.body?.cancel();
      throw new Error(
        'Kindroid returned JSON instead of reply text; outcome unknown',
      );
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new Error('Kindroid reply interrupted; outcome unknown');
    }
    if (!text.trim() || /^\s*<<(HTTP_)?ERROR>>/.test(text))
      throw new Error(
        'Kindroid returned an empty reply or generation error; outcome unknown',
      );
    return { text };
  }
  async reconcile(
    kinId: string,
    batch: Batch,
  ): Promise<Reconciliation<NativeReply>> {
    let { cursor, matched_id: matched } = this.store.nativeRecovery(batch.id);
    // Bound each turn; continuation uses persisted progress without consuming an uncertainty check.
    for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
      const query = new URLSearchParams({ ai_id: kinId, limit: '100' });
      if (cursor !== null) query.set('start_after_timestamp', String(cursor));
      const response = await this.request(`get-chat-messages?${query}`);
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new Error('Invalid Kindroid history JSON');
      }
      const page = parseHistory(data);
      for (const message of page.messages) {
        if (cursor !== null && message.timestamp <= cursor)
          throw new Error('Kindroid history cursor did not advance');
        if (message.id === matched) continue;
        if (matched) {
          // Only the immediately following reply, positively attributed to this Kin, is evidence.
          if (message.sender !== kinId || message.message === batch.payload)
            throw new PermanentFailure(
              'Kindroid history changed after the batch; manual reconciliation required',
            );
          if (
            !message.message.trim() ||
            /^\s*<<(HTTP_)?ERROR>>/.test(message.message)
          )
            return { status: 'unknown' };
          return {
            status: 'found',
            result: { text: message.message, nativeId: message.id },
          };
        }
        if (message.message === batch.payload && message.sender !== kinId)
          matched = message.id;
      }
      if (page.messages.length) cursor = page.pagination.lastTimestamp;
      this.store.saveNativeRecovery(batch.id, cursor, matched);
      if (!page.pagination.hasMore) return { status: 'unknown' };
      if (!page.messages.length)
        throw new Error('Kindroid history pagination stalled');
    }
    throw new RetryLater('Kindroid history scan continues on next turn', 30000);
  }
}
