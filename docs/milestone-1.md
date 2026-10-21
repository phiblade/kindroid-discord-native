# SQLite storage and delivery simulation

Milestone 1 is implemented as an isolated native bridge core. It uses real SQLite files and fake remote APIs. The existing `npm start` entry point still runs the inherited Discord-endpoint connector; no native network adapter or Railway deployment has been enabled.

## Run locally

Use Node.js 22.13 or newer, then install the locked dependencies:

```sh
npm ci
npm run test:native
npm run simulate:native
```

`npm test` runs both inherited and native tests. `npm run lint` checks all TypeScript sources. The SQLite driver is Node's built-in `node:sqlite`, using the synchronous `DatabaseSync` API for compatibility with Node 22. It is experimental on Node 22. There is no additional production database dependency or separate database server.

The simulator ignores real API credentials. It creates a temporary database, saves five messages during generation, simulates a lost Discord posting acknowledgment, reopens SQLite, reconciles the fake post, and deletes the temporary database. Expected final counts: two native requests, one Discord post, one reconciliation, no pending messages or unfinished replies.

## Modules

| Module                   | Responsibility                                                                    |
| ------------------------ | --------------------------------------------------------------------------------- |
| `src/native/config.ts`   | Validate native identity, batch budget and retry settings                         |
| `src/native/types.ts`    | Transport contracts, states and explicit rejection errors                         |
| `src/native/store.ts`    | Schema migration, transactions, immutable batches, chunks, receipts and retention |
| `src/native/batching.ts` | Fit the complete batch into its character budget and split replies safely         |
| `src/native/delivery.ts` | One asynchronous delivery loop per kin, wakeups, retries and reconciliation       |
| `src/native/fakes.ts`    | Controllable clock and fake remote acceptance/history                             |
| `src/native/simulate.ts` | Executable demonstration without live APIs                                        |

## Native configuration

These settings are consumed by `loadNativeConfig`, not by the inherited live entry point. No tokens are needed by the core or simulator.

| Variable                     | Meaning                                    | Default   |
| ---------------------------- | ------------------------------------------ | --------- |
| `BRIDGE_ID`                  | Stable local bridge identity               | `default` |
| `DISCORD_BOT_ID`             | Own bot author ID, to prevent feedback     | Required  |
| `DISCORD_HOME_CHANNEL_ID`    | Only channel whose messages are accepted   | Required  |
| `KINDROID_AI_ID`             | Dedicated native kin identity              | Required  |
| `KINDROID_MESSAGE_MAX_CHARS` | Complete batch budget in UTF-16 code units | `4000`    |
| `RETRY_BASE_MS`              | Initial retry/reconciliation delay         | `2000`    |
| `RETRY_MAX_MS`               | Maximum exponential delay                  | `60000`   |
| `MAX_RECONCILE_CHECKS`       | Unknown-outcome checks before blocking     | `5`       |

The batch budget is validated from 256 to 100,000 for testing and future tuning; this is a local configuration range, not a statement of the API's accepted size. The native API limit still needs verification. An envelope or speaker label too large to fit even one character halts delivery visibly and preserves the pending text.

A `BridgeStore` is constructed with a database path; its parent directory must already exist. Existing bridge configuration is immutable in this milestone: changed values require an explicit migration rather than silently rerouting queued messages. A kin ID cannot be registered twice in one database. Only one store may own a database path in this process, and only one loop may own a registered kin. Railway isolation remains necessary across processes.

## Persistence and lifecycle

Schema version 1 includes bridges, messages, deferred edits, batches, batch membership, reply chunks and pruned-message receipts. WAL, full commit synchronization and foreign keys are enabled on the connection. Each operation uses a short transaction. Network calls happen outside transactions.

Messages include their material content version and newest observed event version. An unsent edit can replace pending content. Once included in a prepared batch, its snapshot stays immutable; later edits are retained for a future correction policy. Old edit events cannot overwrite a newer observed version. Deletion handling is not implemented yet.

The first eligible incoming message establishes the permanent boundary. DMs, other channels, and earlier IDs are ignored. Own-bot messages after that boundary are recorded as delivered. On-disk receipts prevent replaying delivered messages after their cached content has been pruned.

Recovery-page insertion and cursor advancement are atomic. `setRecovering` gates new native sends; `recoverPage` commits completed pages and clears the gate when done. Live events do not advance the recovery cursor. The actual Discord history adapter will supply completed chronological pages in Milestone 2.

The loop is awakened by ingestion, startup, or an injected clock. Multiple wakeups do not create competing loops. `settled()` waits until it is idle or waiting on a scheduled retry; `stop()` stops new attempts and awaits any current call before releasing ownership. Close the store only after stopping its loops. Database errors halt delivery and are surfaced by `settled()`; they are never converted into proof of remote rejection.

## Payloads and replies

Each batch carries an ID, home-channel ID, and remaining-message count. Message entries are one JSON object per line, carrying ID, speaker, version, fragment offset, continuation flag, and text. JSON escaping keeps newlines and apparent protocol headers inside their text fields. This defines syntax, not a guarantee that a language model cannot be influenced by participant content.

Batch membership records exact source ranges. On confirmation, offsets advance atomically with the saved reply and outgoing chunks. A long source message is delivered only after all fragments complete. Confirmed fragments are not resent.

Only exact `none.` and `more.` after trimming surrounding whitespace are suppressed. `None.` is ordinary speech. Every substantive catch-up reply is posted. Empty responses or documented-style API error markers are uncertain outcomes, not speech.

Replies are divided into chunks of at most 2,000 UTF-16 code units, preserving all text, surrogate pairs and Discord mention tokens. Markdown formatting across chunks is not normalized yet. Each chunk has a saved nonce and mention policy. The simulated policy permits explicitly mentioned known participant IDs (up to 100 per chunk) and disables role/everyone and implicit reply pings. The live adapter must map these fields to Discord's options and enforce the nonce.

## Retry and recovery rules

A transport may throw `RejectedRequest` only when it can establish that the operation was not accepted. The same saved operation can then retry after its deadline, honoring a longer reported retry delay. `PermanentFailure` blocks automatic work. Generic errors are uncertain, including timeouts and malformed generation responses.

In-flight operations become uncertain when a store reopens. Reconciliation returns either a recovered result or unknown. Unknown is never interpreted as permission to resend. After the configured number of checks, the operation becomes blocked and requires operator resolution. Incoming messages remain storable. There is no operator-resolution CLI yet.

Saved replies finish posting before another native generation. Confirmed chunks are skipped on restart. An uncertain chunk is reconciled before any retry; the fake Discord history supplies evidence by nonce. A missing record never triggers a blind repost. Reconciliation adapters for actual Kindroid and Discord history are Milestone 3 work; fake history lookup is not proof that real APIs expose equivalent guarantees.

## Retention and remaining scope

Pruning removes old delivered content until the recent cache is at most 1,000 messages, when enough removable records exist. Pending/uncertain messages, messages tied to unfinished replies, and unresolved edits are protected. Batch history, reply records and minimal replay receipts remain durable; total database size is not bounded by 1,000 rows. A completed-record archival policy remains open.

Still required before live use: gateway recovery adapters, native history matching, account-wide rate limiting, live reply posting with nonce enforcement, shutdown time limits, backup/restore operations, explicit administrative resolution, and the agreed edit/deletion/media policies. SQLite checkpointing and durable transactions do not replace backups. The simulator intentionally does not run automatic retries against real services.

## Verification

Native tests use file-backed temporary databases, injected clocks and fake transports. Coverage includes rapid input, wake races, exact control replies, substantive catch-up speech, Unicode fragments, edits, restart deadlines, partial posting, unknown outcomes, commit failure injection, pruning receipts, and multiple kin isolation. A child-process test exits during a transaction to exercise actual rollback and reopening, beyond mocked exceptions. The ordinary runtime and inherited tests remain separate.
