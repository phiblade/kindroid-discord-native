import { Presentation, defaultPresentation } from './presentation';
import { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { assembleBatch, splitReply } from './batching';
import { validateConfig } from './config';
import {
  Batch,
  BridgeConfig,
  Chunk,
  IncomingMessage,
  NativeReply,
  StoredMessage,
} from './types';

type FaultHook = (point: string) => void;
const openStores = new Set<string>();

/** One owner per database in this process. Cross-process isolation is a deployment constraint. */
export class BridgeStore {
  private db: DatabaseSync;
  private readonly key: string;
  private readonly presentation = new Map<string, Presentation>();
  private readonly roomLabels = new Map<string, string>();
  configurePresentation(id: string, options: Presentation): void {
    this.presentation.set(id, { ...options });
  }
  setRoomLabel(id: string, label: string): void {
    this.roomLabels.set(id, label);
  }
  private readonly workers = new Set<string>();
  constructor(
    path: string,
    private readonly fault: FaultHook = () => {},
  ) {
    this.key = path === ':memory:' ? randomUUID() : resolve(path);
    if (openStores.has(this.key))
      throw new Error('Database already owned by this process');
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(
        'PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;',
      );
      this.migrate();
      this.transaction('recover', () => {
        this.db
          .exec(`UPDATE batches SET state='uncertain' WHERE state='in_flight';
          UPDATE chunks SET state='uncertain' WHERE state='in_flight';
          UPDATE messages SET state='uncertain' WHERE state='in_flight';`);
      });
      openStores.add(this.key);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private migrate(): void {
    const version = this.one<{ user_version: number }>(
      'PRAGMA user_version',
    )!.user_version;
    if (version > 3)
      throw new Error('Database schema is newer than this bridge');
    if (version === 3) return;
    if (version === 2) {
      this.transaction('migration3', () =>
        this.db.exec(`
        CREATE TABLE api_requests (at INTEGER NOT NULL, history INTEGER NOT NULL) STRICT;
        CREATE INDEX api_request_time ON api_requests(at);
        CREATE TABLE api_cooldown (id INTEGER PRIMARY KEY CHECK(id=1), until INTEGER NOT NULL) STRICT;
        CREATE TABLE native_recovery (batch_id TEXT PRIMARY KEY REFERENCES batches(id), cursor REAL, matched_id TEXT) STRICT;
        CREATE TABLE discord_receipts (nonce TEXT PRIMARY KEY REFERENCES chunks(nonce), message_id TEXT NOT NULL) STRICT;
        PRAGMA user_version=3;
      `),
      );
      return;
    }
    if (version === 1) {
      this.transaction('migration2', () =>
        this.db.exec(`CREATE TABLE message_deletions (
        bridge_id TEXT NOT NULL REFERENCES bridges(id), id TEXT NOT NULL,
        PRIMARY KEY(bridge_id,id)) STRICT; PRAGMA user_version=2;`),
      );
      this.migrate();
      return;
    }
    this.transaction('migration', () =>
      this.db.exec(`
      CREATE TABLE bridges (
        id TEXT PRIMARY KEY, config TEXT NOT NULL, kin_id TEXT NOT NULL UNIQUE,
        boundary TEXT, recovery_cursor TEXT, recovering INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE messages (
        bridge_id TEXT NOT NULL REFERENCES bridges(id), id TEXT NOT NULL,
        author_id TEXT NOT NULL, speaker TEXT NOT NULL, content TEXT NOT NULL,
        timestamp INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 0, observed_version INTEGER NOT NULL DEFAULT 0,
        offset INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL CHECK(state IN ('pending','in_flight','uncertain','delivered')),
        PRIMARY KEY(bridge_id,id)
      ) STRICT;
      CREATE TABLE deferred_edits (
        bridge_id TEXT NOT NULL, message_id TEXT NOT NULL, version INTEGER NOT NULL,
        content TEXT NOT NULL, speaker TEXT NOT NULL,
        PRIMARY KEY(bridge_id,message_id,version),
        FOREIGN KEY(bridge_id,message_id) REFERENCES messages(bridge_id,id)
      ) STRICT;
      CREATE TABLE pruned_messages (
        bridge_id TEXT NOT NULL REFERENCES bridges(id), id TEXT NOT NULL,
        PRIMARY KEY(bridge_id,id)
      ) STRICT;
      CREATE TABLE batches (
        id TEXT PRIMARY KEY, bridge_id TEXT NOT NULL REFERENCES bridges(id), payload TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('prepared','in_flight','uncertain','confirmed','blocked')),
        attempts INTEGER NOT NULL DEFAULT 0, checks INTEGER NOT NULL DEFAULT 0,
        retry_at INTEGER NOT NULL DEFAULT 0, error TEXT, reply TEXT, native_id TEXT,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX one_active_batch ON batches(bridge_id) WHERE state!='confirmed';
      CREATE TABLE batch_members (
        batch_id TEXT NOT NULL REFERENCES batches(id), bridge_id TEXT NOT NULL,
        message_id TEXT NOT NULL, version INTEGER NOT NULL, start_offset INTEGER NOT NULL,
        end_offset INTEGER NOT NULL, PRIMARY KEY(batch_id,message_id)
      ) STRICT;
      CREATE TABLE chunks (
        id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES batches(id), position INTEGER NOT NULL,
        content TEXT NOT NULL, nonce TEXT NOT NULL UNIQUE, allowed_mentions TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('prepared','in_flight','uncertain','confirmed','blocked')),
        attempts INTEGER NOT NULL DEFAULT 0, checks INTEGER NOT NULL DEFAULT 0,
        retry_at INTEGER NOT NULL DEFAULT 0, error TEXT, discord_id TEXT,
        UNIQUE(batch_id,position)
      ) STRICT;
      CREATE INDEX pending_messages ON messages(bridge_id,state);
      CREATE TABLE message_deletions (
        bridge_id TEXT NOT NULL REFERENCES bridges(id), id TEXT NOT NULL,
        PRIMARY KEY(bridge_id,id)) STRICT;
      PRAGMA user_version=2;
    `),
    );
    this.migrate();
  }

  private one<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }
  private all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }
  private run(sql: string, ...params: SQLInputValue[]): void {
    this.db.prepare(sql).run(...params);
  }
  private transaction<T>(name: string, action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    let result: T;
    try {
      result = action();
      this.fault(`${name}:beforeCommit`);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    // An error here simulates losing the local acknowledgment after durable commit.
    this.fault(`${name}:afterCommit`);
    return result;
  }

  register(config: BridgeConfig): void {
    validateConfig(config);
    this.transaction('register', () => {
      const prior = this.one<{ config: string; boundary: string | null }>(
        'SELECT config,boundary FROM bridges WHERE id=?',
        config.id,
      );
      if (prior) {
        const saved = JSON.parse(prior.config) as BridgeConfig;
        const changed = (Object.keys(config) as (keyof BridgeConfig)[]).filter(
          (key) => saved[key] !== config[key],
        );
        if (!changed.length) return;
        const hasHistory =
          prior.boundary !== null ||
          this.one(
            'SELECT 1 FROM messages WHERE bridge_id=? LIMIT 1',
            config.id,
          ) ||
          this.one(
            'SELECT 1 FROM batches WHERE bridge_id=? LIMIT 1',
            config.id,
          );
        if (hasHistory || this.workers.has(config.id)) {
          throw new Error(
            `Bridge configuration changed (${changed.join(', ')}); explicit migration required because the bridge has recorded history or an active delivery loop`,
          );
        }
        // Setup may fail after registration but before the first eligible message.
        this.run(
          'UPDATE bridges SET config=?,kin_id=? WHERE id=?',
          JSON.stringify(config),
          config.kinId,
          config.id,
        );
        return;
      }
      this.run(
        'INSERT INTO bridges(id,config,kin_id) VALUES(?,?,?)',
        config.id,
        JSON.stringify(config),
        config.kinId,
      );
    });
  }

  config(id: string): BridgeConfig {
    const row = this.one<{ config: string }>(
      'SELECT config FROM bridges WHERE id=?',
      id,
    );
    if (!row) throw new Error('Unknown bridge');
    return JSON.parse(row.config) as BridgeConfig;
  }
  claimWorker(id: string): () => void {
    if (this.workers.has(id))
      throw new Error('Delivery loop already exists for this kin');
    this.workers.add(id);
    return () => this.workers.delete(id);
  }
  bridge(id: string): {
    boundary: string | null;
    recovery_cursor: string | null;
    recovering: number;
  } {
    const row = this.one<{
      boundary: string | null;
      recovery_cursor: string | null;
      recovering: number;
    }>(
      'SELECT boundary,recovery_cursor,recovering FROM bridges WHERE id=?',
      id,
    );
    if (!row) throw new Error('Unknown bridge');
    return row;
  }
  messages(id: string): StoredMessage[] {
    return this.all(
      'SELECT * FROM messages WHERE bridge_id=? ORDER BY length(id),id',
      id,
    );
  }
  pending(id: string): StoredMessage[] {
    return this.messages(id).filter(
      (m) =>
        m.state === 'pending' &&
        (!this.isDeleted(id, m.id) ||
          !!this.one(
            'SELECT 1 FROM batch_members WHERE bridge_id=? AND message_id=?',
            id,
            m.id,
          )),
    );
  }
  batches(id: string): Batch[] {
    return this.all(
      'SELECT * FROM batches WHERE bridge_id=? ORDER BY rowid',
      id,
    );
  }
  chunks(batch: string): Chunk[] {
    return this.all(
      'SELECT * FROM chunks WHERE batch_id=? ORDER BY position',
      batch,
    );
  }
  members(batch: string): {
    message_id: string;
    version: number;
    start_offset: number;
    end_offset: number;
  }[] {
    return this.all(
      'SELECT message_id,version,start_offset,end_offset FROM batch_members WHERE batch_id=? ORDER BY length(message_id),message_id',
      batch,
    );
  }

  ingest(
    id: string,
    event: IncomingMessage,
  ): 'ignored' | 'duplicate' | 'saved' | 'deferred_edit' {
    return this.transaction('ingest', () => this.saveMessage(id, event));
  }
  private saveMessage(
    id: string,
    event: IncomingMessage,
  ): 'ignored' | 'duplicate' | 'saved' | 'deferred_edit' {
    const config = this.config(id);
    if (event.isDM || event.channelId !== config.channelId) return 'ignored';
    if (!/^[1-9]\d{0,19}$/.test(event.id))
      throw new Error('Message ID must be a positive Discord snowflake');
    if (
      !Number.isSafeInteger(event.timestamp) ||
      !Number.isSafeInteger(event.version ?? 0) ||
      (event.version ?? 0) < 0
    )
      throw new Error('Invalid message timestamp or version');
    if (event.authorId === config.botId && event.nonce) {
      const chunk = this.one<{ content: string }>(
        `SELECT c.content FROM chunks c JOIN batches b ON b.id=c.batch_id WHERE c.nonce=? AND b.bridge_id=? AND c.attempts>0`,
        event.nonce,
        id,
      );
      if (chunk && chunk.content === event.content)
        this.run(
          'INSERT OR IGNORE INTO discord_receipts VALUES(?,?)',
          event.nonce,
          event.id,
        );
    }
    const bridge = this.bridge(id);
    if (this.isDeleted(id, event.id)) return 'ignored';
    if (bridge.boundary && BigInt(event.id) < BigInt(bridge.boundary))
      return 'ignored';
    if (
      this.one(
        'SELECT 1 FROM pruned_messages WHERE bridge_id=? AND id=?',
        id,
        event.id,
      )
    )
      return 'duplicate';
    if (!bridge.boundary) {
      if (event.authorId === config.botId) return 'ignored';
      this.run('UPDATE bridges SET boundary=? WHERE id=?', event.id, id);
    }
    const existing = this.one<StoredMessage>(
      'SELECT * FROM messages WHERE bridge_id=? AND id=?',
      id,
      event.id,
    );
    if (existing) {
      if ((event.version ?? 0) <= existing.observed_version) return 'duplicate';
      this.run(
        'UPDATE messages SET observed_version=? WHERE bridge_id=? AND id=?',
        event.version!,
        id,
        event.id,
      );
      if (
        event.content === existing.content &&
        event.speaker === existing.speaker
      )
        return 'duplicate';
      const attempted = this.one(
        'SELECT 1 FROM batch_members WHERE bridge_id=? AND message_id=? LIMIT 1',
        id,
        event.id,
      );
      if (existing.state !== 'pending' || existing.offset > 0 || attempted) {
        this.run(
          'INSERT OR IGNORE INTO deferred_edits VALUES(?,?,?,?,?)',
          id,
          event.id,
          event.version!,
          event.content,
          event.speaker,
        );
        return 'deferred_edit';
      }
      this.run(
        'UPDATE messages SET content=?,speaker=?,version=? WHERE bridge_id=? AND id=?',
        event.content,
        event.speaker,
        event.version!,
        id,
        event.id,
      );
      return 'saved';
    }
    this.run(
      'INSERT INTO messages(bridge_id,id,author_id,speaker,content,timestamp,version,observed_version,state) VALUES(?,?,?,?,?,?,?,?,?)',
      id,
      event.id,
      event.authorId,
      event.speaker,
      event.content,
      event.timestamp,
      event.version ?? 0,
      event.version ?? 0,
      event.authorId === config.botId ? 'delivered' : 'pending',
    );
    return 'saved';
  }

  setRecovering(id: string): void {
    this.transaction('recoveryStart', () =>
      this.run('UPDATE bridges SET recovering=1 WHERE id=?', id),
    );
  }
  /** The adapter must supply completed chronological pages; live events never advance this cursor. */
  recoverPage(
    id: string,
    events: IncomingMessage[],
    cursor: string,
    done: boolean,
  ): void {
    this.transaction('recoveryPage', () => {
      if (!this.bridge(id).boundary)
        throw new Error('Cannot backfill before the initial boundary');
      if (!this.bridge(id).recovering)
        throw new Error('Recovery has not started');
      const old = this.bridge(id).recovery_cursor;
      if (
        !/^[1-9]\d{0,19}$/.test(cursor) ||
        (old && BigInt(cursor) < BigInt(old))
      )
        throw new Error('Recovery cursor moved backwards');
      if (BigInt(cursor) < BigInt(this.bridge(id).boundary!))
        throw new Error('Recovery cursor precedes boundary');
      for (const event of events) {
        if (
          !/^[1-9]\d{0,19}$/.test(event.id) ||
          BigInt(event.id) > BigInt(cursor)
        )
          throw new Error('Recovery page extends beyond cursor');
      }
      for (const event of events) this.saveMessage(id, event);
      this.run(
        'UPDATE bridges SET recovery_cursor=?,recovering=? WHERE id=?',
        cursor,
        done ? 0 : 1,
        id,
      );
    });
  }

  /** Account-wide within this database; reserve before issuing HTTP, including failed calls. */
  reserveApiRequest(now: number, history: boolean): number {
    return this.transaction('apiReserve', () => {
      this.run('DELETE FROM api_requests WHERE at<=?', now - 86400000);
      const cooldown =
        this.one<{ until: number }>('SELECT until FROM api_cooldown WHERE id=1')
          ?.until ?? 0;
      const recent = this.all<{ at: number }>(
        'SELECT at FROM api_requests WHERE at>? ORDER BY at',
        now - 30000,
      );
      const daily = history
        ? this.all<{ at: number }>(
            'SELECT at FROM api_requests WHERE history=1 ORDER BY at',
          )
        : [];
      const until = Math.max(
        cooldown,
        recent.length >= 10 ? recent[recent.length - 10].at + 30000 : 0,
        daily.length >= 600 ? daily[daily.length - 600].at + 86400000 : 0,
      );
      if (until > now) return until - now;
      this.run('INSERT INTO api_requests VALUES(?,?)', now, history ? 1 : 0);
      return 0;
    });
  }
  deferApiUntil(until: number): void {
    this.transaction('apiCooldown', () =>
      this.run(
        'INSERT INTO api_cooldown VALUES(1,?) ON CONFLICT(id) DO UPDATE SET until=max(until,excluded.until)',
        until,
      ),
    );
  }
  nativeRecovery(batchId: string): {
    cursor: number | null;
    matched_id: string | null;
  } {
    return (
      this.one(
        'SELECT cursor,matched_id FROM native_recovery WHERE batch_id=?',
        batchId,
      ) ?? { cursor: null, matched_id: null }
    );
  }
  saveNativeRecovery(
    batchId: string,
    cursor: number | null,
    matchedId: string | null,
  ): void {
    this.transaction('nativeRecovery', () =>
      this.run(
        'INSERT INTO native_recovery VALUES(?,?,?) ON CONFLICT(batch_id) DO UPDATE SET cursor=excluded.cursor,matched_id=excluded.matched_id',
        batchId,
        cursor,
        matchedId,
      ),
    );
  }
  discordReceipt(nonce: string): string | undefined {
    return this.one<{ message_id: string }>(
      'SELECT message_id FROM discord_receipts WHERE nonce=?',
      nonce,
    )?.message_id;
  }

  isDeleted(id: string, messageId: string): boolean {
    return !!this.one(
      'SELECT 1 FROM message_deletions WHERE bridge_id=? AND id=?',
      id,
      messageId,
    );
  }
  observeDeletion(id: string, messageIds: string[]): void {
    this.transaction('deletion', () => {
      const boundary = this.bridge(id).boundary;
      if (!boundary) return;
      for (const messageId of messageIds) {
        if (!/^[1-9]\d{0,19}$/.test(messageId))
          throw new Error('Invalid deletion ID');
        if (BigInt(messageId) >= BigInt(boundary))
          this.run(
            'INSERT OR IGNORE INTO message_deletions VALUES(?,?)',
            id,
            messageId,
          );
      }
    });
  }
  /** Descending scan pages are durable, but never advance the completed cursor. */
  stageRecovery(id: string, events: IncomingMessage[]): void {
    this.transaction('stageRecovery', () => {
      if (!this.bridge(id).recovering || !this.bridge(id).boundary)
        throw new Error('Recovery has not started');
      for (const event of events) this.saveMessage(id, event);
    });
  }
  completeRecovery(id: string, cursor: string | null): void {
    this.transaction('completeRecovery', () => {
      const bridge = this.bridge(id);
      if (!bridge.recovering) throw new Error('Recovery has not started');
      if (
        bridge.boundary &&
        (!cursor || BigInt(cursor) < BigInt(bridge.boundary))
      )
        throw new Error('Invalid recovery cursor');
      if (
        bridge.recovery_cursor &&
        (!cursor || BigInt(cursor) < BigInt(bridge.recovery_cursor))
      )
        throw new Error('Recovery cursor moved backwards');
      this.run(
        'UPDATE bridges SET recovery_cursor=?,recovering=0 WHERE id=?',
        cursor,
        id,
      );
    });
  }

  activeBatch(id: string): Batch | undefined {
    return this.one(
      "SELECT * FROM batches WHERE bridge_id=? AND state!='confirmed' ORDER BY rowid LIMIT 1",
      id,
    );
  }
  nextChunk(id: string): Chunk | undefined {
    return this.one(
      `SELECT c.* FROM chunks c JOIN batches b ON b.id=c.batch_id
      WHERE b.bridge_id=? AND c.state!='confirmed' ORDER BY b.rowid,c.position LIMIT 1`,
      id,
    );
  }
  prepare(id: string, now: number): Batch | undefined {
    return this.transaction('prepare', () => {
      const existing = this.activeBatch(id);
      if (existing) return existing;
      if (this.nextChunk(id) || this.bridge(id).recovering) return undefined;
      const pending = this.pending(id);
      if (!pending.length) return undefined;
      const batchId = randomUUID();
      const config = this.config(id);
      const assembled = assembleBatch(
        batchId,
        config.channelId,
        pending,
        config.maxChars,
        this.presentation.get(id) ?? defaultPresentation,
        this.roomLabels.get(id),
      );
      this.run(
        "INSERT INTO batches(id,bridge_id,payload,state,created_at) VALUES(?,?,?,'prepared',?)",
        batchId,
        id,
        assembled.payload,
        now,
      );
      for (const member of assembled.members) {
        this.run(
          'INSERT INTO batch_members VALUES(?,?,?,?,?,?)',
          batchId,
          id,
          member.messageId,
          member.version,
          member.start,
          member.end,
        );
      }
      return this.activeBatch(id);
    });
  }
  beginBatch(batch: Batch): Batch {
    this.transaction('beginBatch', () => {
      this.run(
        "UPDATE batches SET state='in_flight',attempts=attempts+1 WHERE id=? AND state='prepared'",
        batch.id,
      );
      for (const member of this.members(batch.id))
        this.run(
          "UPDATE messages SET state='in_flight' WHERE bridge_id=? AND id=?",
          batch.bridge_id,
          member.message_id,
        );
    });
    return this.one<Batch>('SELECT * FROM batches WHERE id=?', batch.id)!;
  }
  finishBatch(batch: Batch, reply: NativeReply): void {
    if (!reply.text.trim() || /^\s*<<(HTTP_)?ERROR>>/.test(reply.text))
      throw new Error('Native reply is empty or an error marker');
    this.transaction('finishBatch', () => {
      const current = this.one<Batch>(
        'SELECT * FROM batches WHERE id=?',
        batch.id,
      )!;
      if (current.state === 'confirmed') return;
      this.run(
        "UPDATE batches SET state='confirmed',reply=?,native_id=?,error=NULL,retry_at=0 WHERE id=?",
        reply.text,
        reply.nativeId ?? null,
        batch.id,
      );
      for (const member of this.members(batch.id)) {
        const message = this.one<StoredMessage>(
          'SELECT * FROM messages WHERE bridge_id=? AND id=?',
          batch.bridge_id,
          member.message_id,
        )!;
        this.run(
          'UPDATE messages SET offset=?,state=? WHERE bridge_id=? AND id=?',
          member.end_offset,
          member.end_offset >= message.content.length ? 'delivered' : 'pending',
          batch.bridge_id,
          member.message_id,
        );
      }
      if (['none.', 'more.'].includes(reply.text.trim())) return;
      // Snapshot allowed recipients. Role/everyone parsing stays disabled.
      const knownUsers = new Set(
        this.messages(batch.bridge_id).map((m) => m.author_id),
      );
      splitReply(reply.text).forEach((content, position) => {
        const users = [
          ...new Set(
            [...content.matchAll(/<@!?(\d+)>/g)].map((match) => match[1]),
          ),
        ]
          .filter((id) => knownUsers.has(id))
          .slice(0, 100);
        const mentions = JSON.stringify({
          parse: [],
          users,
          repliedUser: false,
        });
        this.run(
          "INSERT INTO chunks(id,batch_id,position,content,nonce,allowed_mentions,state) VALUES(?,?,?,?,?,?,'prepared')",
          randomUUID(),
          batch.id,
          position,
          content,
          randomUUID().replace(/-/g, '').slice(0, 25),
          mentions,
        );
      });
    });
  }
  beginChunk(chunk: Chunk): Chunk {
    this.transaction('beginChunk', () =>
      this.run(
        "UPDATE chunks SET state='in_flight',attempts=attempts+1 WHERE id=? AND state='prepared'",
        chunk.id,
      ),
    );
    return this.one<Chunk>('SELECT * FROM chunks WHERE id=?', chunk.id)!;
  }
  finishChunk(chunk: Chunk, discordId: string): void {
    this.transaction('finishChunk', () => {
      this.run(
        "UPDATE chunks SET state='confirmed',discord_id=?,error=NULL,retry_at=0 WHERE id=?",
        discordId,
        chunk.id,
      );
    });
  }

  defer(
    kind: 'batch' | 'chunk',
    operation: Batch | Chunk,
    state: 'prepared' | 'uncertain' | 'blocked',
    retryAt: number,
    error: string,
    checked = false,
  ): void {
    this.transaction('defer', () => {
      const table = kind === 'batch' ? 'batches' : 'chunks';
      this.run(
        `UPDATE ${table} SET state=?,retry_at=?,error=?,checks=checks+? WHERE id=?`,
        state,
        retryAt,
        error,
        checked ? 1 : 0,
        operation.id,
      );
      if (kind === 'batch') {
        const batch = operation as Batch;
        for (const member of this.members(batch.id))
          this.run(
            'UPDATE messages SET state=? WHERE bridge_id=? AND id=?',
            state === 'prepared' ? 'pending' : 'uncertain',
            batch.bridge_id,
            member.message_id,
          );
      }
    });
  }

  prune(id: string, keep = 1000): number {
    if (!Number.isInteger(keep) || keep < 0)
      throw new Error('Invalid retention count');
    return this.transaction('prune', () => {
      const removable = this.messages(id).filter(
        (m) =>
          (m.state === 'delivered' ||
            (this.isDeleted(id, m.id) &&
              !this.one(
                'SELECT 1 FROM batch_members WHERE bridge_id=? AND message_id=?',
                id,
                m.id,
              ))) &&
          !this.one(
            `SELECT 1 FROM batch_members bm JOIN batches b ON b.id=bm.batch_id
          WHERE bm.bridge_id=? AND bm.message_id=? AND (b.state!='confirmed' OR EXISTS
          (SELECT 1 FROM chunks c WHERE c.batch_id=b.id AND c.state!='confirmed')) LIMIT 1`,
            id,
            m.id,
          ) &&
          !this.one(
            'SELECT 1 FROM deferred_edits WHERE bridge_id=? AND message_id=?',
            id,
            m.id,
          ),
      );
      const excess = Math.max(0, this.messages(id).length - keep);
      const removed = removable.slice(0, excess);
      for (const message of removed) {
        this.run('INSERT INTO pruned_messages VALUES(?,?)', id, message.id);
        this.run(
          'DELETE FROM messages WHERE bridge_id=? AND id=?',
          id,
          message.id,
        );
      }
      return removed.length;
    });
  }
  close(): void {
    if (this.workers.size)
      throw new Error('Stop delivery loops before closing the store');
    this.db.close();
    openStores.delete(this.key);
  }
}
