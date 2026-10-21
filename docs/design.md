# Native Discord bridge design

Status: agreed behavior and proposed implementation, recorded October 21, 2026. Native behavior is not implemented yet; the repository still contains the original Discord-endpoint connector.

The bridge connects one Discord bot and its home channel to one dedicated Kindroid conversation. It saves incoming messages durably, delivers pending messages in order, and lets the kin decide when to speak. The user manages exclusive use of the kin and its personality configuration.

## Agreed behavior

- Ignore DMs and messages outside the configured home channel. Do not send a DM redirect initially. Threads have distinct channel IDs and are outside the home channel unless explicitly configured later.
- Observe every message in the home channel, not only mentions. Other participants and bots can contribute. The bridge's own replies are recorded as already synchronized and never sent back as new input.
- Establish the permanent history boundary at the first incoming message handled when a new bridge begins. Do not import older room history. Persist the boundary across restarts; clearing it is an explicit reset, not a startup action.
- Keep incoming messages and delivery metadata in SQLite. A boolean alone cannot represent a request whose remote outcome is unknown.
- Maintain one asynchronous delivery loop per kin inside the Node process. It continues draining pending work after each response and wakes after startup or a retry timer. No additional Railway worker service is needed.
- Normally send one new message. During generation, outages, or rate-limit waits, accumulate messages and send ordered batches that fit the input budget.
- After trimming surrounding whitespace, only exact `none.` and `more.` are control replies. Post every other valid, nonempty generated reply, including replies generated during catch-up. Personality instructions guide turn-taking; the bridge does not suppress substantive speech because more messages remain.
- Implement full restart recovery for replies awaiting Discord posting. Split oversized replies rather than truncate them.

## Message format and personality

Standing protocol instructions belong in the kin's personality configuration, installed manually by the user. They explain the home room, speaker labels, remaining-message count, and control replies. The bridge never automatically overwrites the kin's personality, resets its chat, or rewinds it.

Proposed batch envelope:

```text
Batch: 019-example-batch-id
Channel: #homeroom
Messages remaining after this batch: 23

[bob]: Hello everyone.
[phil]: Hi, Bob.
```

The remaining count is a snapshot when the batch is assembled. More messages can arrive during generation. `more.` does not cause an empty request; the delivery loop follows the durable pending queue. `none.` still counts as a successful exchange. API errors and empty responses are operational outcomes, not public speech.

The proposed batch marker supports uncertain-delivery reconciliation. Verify that native history preserves it before depending on matching. Display names are presentation labels; Discord author and message IDs remain the durable identities. Content must be represented so participants cannot accidentally impersonate envelope metadata or another speaker through line breaks; finalize escaping with protocol tests.

## Input budget

Proposed setting: `KINDROID_MESSAGE_MAX_CHARS=4000`. This applies to the complete native `message` string, including the envelope, labels, separators, and continuation markers. It is a project budget inferred from the announced chat input limit, not a verified native API maximum. See [API findings](api-findings.md).

Pack pending messages oldest-first. Prefer whole messages; split a single oversized message into labeled fragments without losing text. Persist fragment membership, and mark the source version delivered only when all of its fragments have been confirmed. Proposed initial counting uses JavaScript UTF-16 code units and avoids splitting surrogate pairs; verify Unicode behavior against the API before a live release. No numeric limit should silently truncate text. Count unfinished source messages consistently in the remaining-message field.

The old `KINDROID_MESSAGE_CONTEXT` snapshot size is not a native delivery limit. Do not repeatedly resend the last 200 messages, or discard pending work because it lies outside a recent window. `DISCORD_FETCH_BATCH` may remain useful for Discord recovery pagination. Speaker labeling carries forward; old share-code, content-filter, and Discord-endpoint settings must not be presented as native API settings without support.

## SQLite storage

Proposed implementation: SQLite on a persistent volume, WAL mode, `synchronous=FULL`, short transactions, foreign keys, and schema migrations. SQLite is the source of truth, not a periodic export of a JavaScript map. A synchronous driver briefly occupies Node's event loop during each database operation; no transaction spans a network request. Revisit a database thread only if measured disk latency warrants it.

Proposed logical records:

| Record | Purpose |
| --- | --- |
| Bridge | Bot, home channel, kin, permanent starting message, recovery cursor |
| Message | Discord ID, author, speaker label, content/version, timestamp, deletion state, origin, delivery state |
| Batch and members | Immutable exact payload, member versions/fragments, attempts, retry time, state, recovered native IDs |
| Reply and chunks | Full native reply, ordered Discord chunks, persisted nonce per chunk, posting state, confirmed Discord IDs |

Messages and delivery state live in the same database. Batch records preserve the exact bytes and versions involved in each attempted exchange; they do not duplicate a separate authoritative message cache.

Delivery states include `pending`, `in_flight`, `delivered`, and `uncertain`. Posting states distinguish prepared, posting, posted, and uncertain. A crash with an operation in flight becomes uncertain on restart. Definitively rejected attempts may return to pending with a retry schedule; ambiguous failures must be reconciled first.

Keep at most 1,000 messages in the ordinary recent cache per bridge. Pending or uncertain messages, unrecovered replies, and the metadata needed to recover them are exempt from pruning. Durable storage can therefore exceed 1,000 rows. Never silently discard undelivered data to satisfy the cache cap. Finalize completed-record retention separately.

## Incoming events and recovery

Each eligible Discord event commits an insert or update keyed by message ID, then wakes the delivery loop. Repeated events must not duplicate pending work. Incoming handlers finish after persistence; they do not wait for generation or start competing delivery loops.

On reconnect or restart, fetch history after the saved recovery cursor and within the permanent boundary. Drain all missed pages, rather than applying the recent-cache cap to catch-up. Commit messages and cursor progress together. Gateway delivery and pagination can overlap, so deduplicate by ID and maintain a cursor representing completed recovery, not merely the highest event observed during an interrupted scan.

Live events arriving during recovery are persisted, but outbound delivery waits until older missing history is accounted for. Initial activation needs a tested boundary procedure so startup races neither import old history nor omit the first eligible message.

Our own bot's Discord events are stored without queuing delivery, even if the event precedes the posting HTTP response. Correlate to the outgoing chunk by nonce or confirmed ID where available. Replies from other bots remain ordinary input; use a controlled room to evaluate the risk of automated bot-to-bot conversations.

## Delivery loop

```text
Persist incoming event and wake loop
  → recover any uncertain operation or unfinished outgoing reply
  → select oldest pending versions fitting the budget
  → persist exact batch and mark in flight
  → await native response while new events continue being saved
  → atomically record delivery outcome and full reply
  → consume control reply or persist and post ordered reply chunks
  → repeat until empty, then atomically become idle
```

A running flag prevents duplicate loops for a kin. The empty-to-idle transition and wake mechanism must not strand a message arriving at that boundary. Persist retry deadlines so restart does not bypass backoff. Authentication/configuration failures need operator action rather than rapid retries. Use one account-level request limiter shared by its kins and recovery calls.

Example: the first of five messages arrives and starts generation; the other four are saved over the next two seconds. When the response is handled, the loop delivers those four together if they fit. An optional burst delay is not required for the first version.

## Uncertain native delivery

A timeout or server failure is not proof that a batch was rejected. Persist the batch marker, exact payload, and attempt metadata before the network call. Never automatically retry a non-idempotent send merely because its response was lost.

Proposed recovery uses native conversation history and a persisted cursor with overlap/deduplication to avoid timestamp-boundary omissions. Match the exact marked user batch and its associated reply. If both exist, recover the reply. If only the user batch exists, wait for completion; if neither appears, a single check is not proof of absence. Use bounded checks and flag unresolved cases instead of guessing. Freeze later sends for that kin while its previous outcome remains uncertain; continue saving Discord input.

No exactly-once guarantee is claimed. History visibility delay, marker preservation, response association, and partial generation failures require controlled API verification. Restoring an older backup may resurrect already completed work, so recovery must reconcile remote state before resuming sends.

## Discord posting and restart recovery

Persist the full native reply, stable chunk boundaries, and one nonce per chunk before posting. Send chunks sequentially through a helper in the same delivery loop; normally there is one chunk. Respect Discord's 2,000-character content limit without losing text, breaking Unicode, or accidentally changing mention syntax. Track successful chunk IDs individually.

Use `enforceNonce: true` and reuse the stored nonce for retries of the same chunk. It provides short-window deduplication, not permanent idempotency. On restart, skip confirmed chunks, post unattempted ones, and reconcile uncertain ones. For older uncertain posts, inspect available Discord events/history and local identifiers; matching identical content alone is not conclusive. Leave ambiguous cases visible for operator resolution.

Recover unfinished replies before generating another response for that kin. Discord posting failure must not cause regeneration. If posting is blocked, new inbound messages remain durable and the logs show the backlog.

Support deliberate Discord mentions through explicit `allowedMentions` configuration. Proposed initial policy permits known room participants and disables role/everyone notifications; confirm the exact policy before the live trial. Save the policy with outgoing chunks so retries do not change their effect.

## Hosting and operations

Use one Railway service, one application process, and one attached persistent volume, for example `/data/bridge.sqlite`. The SQLite journal files must be on the volume too. Configure backups and test restoration. A volume survives deployments but is not itself a backup.

Railway's volume restrictions provide deployment isolation for this topology; do not run a second local copy or separate service with the same bot/kin credentials. Handle termination by stopping new outbound work, saving known outcomes, and leaving interrupted operations recoverable. Keep reconnect backfill and retry scheduling active after startup.

Log counts and identifiers for received messages, pending backlog, batch length, remaining work, generation duration, retries, uncertain outcomes, and posted chunks. Do not log credentials or conversation bodies by default. Persistence includes private conversation content and needs appropriate volume/backup access controls.

## Decisions still to finalize

- Verify the assumed 4,000-character native input budget, Unicode counting, rejection behavior, and recovery markers.
- Specify edits/deletions after delivery. Pending edits can replace unsent text; in-flight snapshots must remain immutable. Corrections to delivered messages need a separate agreed policy. Offline deletions may be unrecoverable.
- Specify attachment, embed, sticker, and non-text message representation; first milestone tests text only.
- Choose configuration names for home channel, Kin ID, database path, mentions, retries, and pruning. These are proposals until implementation.
- Account for proactive/native app activity if enabled. Exclusive use is the user's operating responsibility; the initial bridge is not a general two-way mirror of all native chat activity.
