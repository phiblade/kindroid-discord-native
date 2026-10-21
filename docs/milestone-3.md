# Milestone 3: Native Kindroid delivery

The default `npm start` entry point now connects Discord ingestion, SQLite delivery state, the native Kindroid API, and public Discord posting. `npm run ingest:native` remains intake-only. The original project's Railway deployment is not changed by this work.

## Configuration and first run

Use the settings in [`.env.example`](../.env.example). The new requirement beyond ingestion is `KINDROID_API_KEY`, the native Bearer key (`kn_...`) from Kindroid's API & Integrations settings. Use `KINDROID_AI_ID`, not a shared character code. `KINDROID_REQUEST_TIMEOUT_MS` defaults to 180000 and supports 1000–900000 milliseconds. All other native configuration defaults remain as in milestone 1.

The runtime verifies the logged-in bot ID and home-room read/send permissions before unblocking native delivery. Message Content Intent must be enabled in the Discord Developer Portal. A thread needs Send Messages in Threads.

Stop the ingestion command before running `npm start`. Starting native delivery drains existing queued messages after catch-up; it does not start an empty conversation or reset the SQLite boundary. Use a dedicated Kin and avoid another connector or human conversation in the same Kin. A separate test bot avoids simultaneous replies from the old Railway connector. No personality settings or remote conversations are automatically reset or edited.

## Kin instructions

Install equivalent instructions in the Kin's personality/configuration yourself; the bridge does not repeat them with every request:

> You participate in a Discord room through a bridge. Each delivery starts with an ISO 8601 UTC timestamp: when the bridge prepared the batch. Next is an optional room line showing `#name`, a numeric room ID, or `#name | ID`. The following line is `batch-ID | messages-remaining`. After a blank line comes the speaker list, then another blank line and the messages.
>
> Each speaker-list line is `ID Name`: the numeric author ID comes first, followed by one space, then the full display name. Everything after the first space belongs to the name, including spaces, semicolons, equals signs, quotes and backslashes. No extra quoting or escaping is applied in this list. Line breaks in names become spaces. A blank line ends the list. Duplicate display names belonging to different authors receive distinct labels, used consistently in the list and message headers.

Only exact, case-sensitive, trimmed `none.` and `more.` are suppressed. Quoted controls, `None.`, or extra prose are public replies. There is no empty-message polling loop: after a control reply, the bridge continues only if pending source messages remain.

## API and durable recovery

Native requests use `POST https://api.kindroid.ai/v1/send-message` with `{ ai_id, message, stream: false }` and Bearer authentication. The batch envelope and complete payload are saved before sending. Plain-text success is saved with the outgoing chunks atomically. Empty replies, JSON bodies, `<<ERROR>>`/`<<HTTP_ERROR>>` prefixes, network failures, and server errors never become public speech.

The initial full-payload budget remains 4,000 UTF-16 units, inferred from the chat limit rather than a published native endpoint maximum. See the [API findings](api-findings.md) and [official reference](https://kindroid.ai/v2/docs/api-documentation/).

Schema version 3 adds durable API request reservations, cooldowns, native history scan progress, and Discord nonce receipts. Upgrades from versions 1/2 preserve messages, boundaries, batches, and chunks. Back up persistent state before upgrading. No live database was migrated as part of automated verification.

One database represents one Kindroid account. All native send and history calls share a persisted sliding-window limiter: at most 10 reservations per 30 seconds, plus at most 600 history reservations per 24 hours. Failed calls still consume reservations. API `429` responses persist Retry-After cooldowns. Other processes/clients using that account are outside the local limiter; the server's 429 still applies. Rate-limit waits do not consume uncertainty checks.

A lost send acknowledgment switches the batch to uncertain. Recovery uses `get-chat-messages`, with the documented timestamp cursor and up to 100 rows per page. The first scan starts at the beginning because the docs do not specify timestamp units. Progress is saved; each turn scans at most ten pages. It requires the **exact complete payload**, followed immediately by a reply whose `sender` equals the configured Kin ID. It never guesses from similar text. An intervening message blocks association. A missing batch/reply remains uncertain, and repeated inconclusive checks eventually block delivery. Sender identity values, marker fidelity and timestamp-boundary behavior must still be verified against a real dedicated Kin; undocumented or unexpected shapes cannot establish success. History is used for uncertain recovery only, not ordinary polling.

Authentication and invalid-request HTTP statuses block immediately. Server errors and conflicts remain uncertain. There are no automatic HTTP send retries; only confirmed rejections, such as 429, return an attempted batch to prepared. Native timeout defaults to three minutes; a timeout does not imply rejection.

## Discord replies

Each outgoing chunk retains its content, nonce, position, and allowed-mentions snapshot in SQLite. Posting uses `enforceNonce: true`. Automatic discord.js network/5xx retries are disabled; its ordinary rate-limit scheduling remains active. Only known participant user IDs explicitly mentioned in the generated text may notify; role/everyone parsing is disabled.

Own-message gateway events can save a nonce receipt before HTTP completes. Successful HTTP replies also save the receipt, including when the response omits the nonce. Recovery checks persisted receipts first, then up to 1,000 available room messages for an exact nonce/author/content match. Identical text without a nonce is not proof. Uncertain posts are not automatically resent, even though Discord offers short-window nonce enforcement. If evidence is unavailable, delivery blocks rather than risking a duplicate. Already confirmed chunks are skipped on restart and the full Kin response is never regenerated to repair posting.

No exactly-once guarantee is claimed. Lost receipts, deleted replies, unavailable history nonces, out-of-band conversation changes, and restoring an older backup can require manual investigation. A `blocked` record stays blocked after restart. Keep the database and inspect the affected batch/chunk and remote history before resolving it; do not blindly delete state or mark an uncertain operation prepared. An operator resolution command is not yet implemented.

## Logs and verification

`kindroid_send` logs the number of source messages/fragments in the batch, payload characters, cached count, and remaining pending count. `kindroid_confirmed` reports response length and chunk count. `discord_confirmed` reports chunk/message IDs. Retry, uncertainty, and blocked logs identify the operation and next retry time. Logs omit credentials and conversation bodies.

Automated tests cover request/response contracts, auth/errors, rate limits across restart, pagination and uncertain association, aborts, nonce matching, schema upgrades, and full delivery-loop recovery after both native and Discord acknowledgments are lost. The existing burst, fragmentation, control-response, crash, and ingestion tests continue to pass.

For the controlled live test:

1. Configure the native key and Kin instructions. Isolate the bot from the old connector and stop intake-only mode.
2. Run `npm start`; expect catch-up followed by delivery of existing pending messages.
3. Send a short message. Confirm one Kin turn and either a private control reply or a public Discord reply.
4. Send a burst during generation. Confirm the pending queue drains without concurrent generations.
5. Restart while idle, then after a controlled interruption. Check counts and recovery logs; do not force resend an uncertain batch.
6. Verify live history metadata and nonce recovery before relying on unattended restarts. Railway deployment, backups, and volume verification remain milestone 4.

## Compact transcript format

```text
2026-10-22T09:42:15Z
9c78273d-48e1-4e84-b7fd-4f0a92b51366 | 0

234567890123456789 Bob
345678901234567890 Phil

09:41 **Bob**
Hey, how's everyone doing?

09:42 **Phil**
Pretty good. What do you think, Kin?
```

| Environment variable         | Default | Effect                                                |
| ---------------------------- | ------- | ----------------------------------------------------- |
| `CONTENT_PREPEND_MESSAGE_ID` | `no`    | Prefix message headers with the Discord message ID    |
| `CONTENT_PREPEND_DATE`       | `no`    | Add original message date as MM/DD                    |
| `CONTENT_PREPEND_TIME`       | `yes`   | Add original message time as HH:mm                    |
| `CONTENT_PREPEND_ROOM_LABEL` | `no`    | Include the actual Discord room name, prefixed with # |
| `CONTENT_PREPEND_ROOM_ID`    | `no`    | Include the numeric Discord room ID                   |

Switches accept `yes` or `no` (case-insensitive). The optional room line sits between the preparation timestamp and batch line. If both room switches are on, it reads `#name | ID`. The room name is obtained from Discord during readiness/backfill. Each speaker mapping appears once per batch; only included speakers are listed. All headers, speaker names, optional fields and fragment markers count toward the input budget. Body text is preserved verbatim, without `>` prefixes.

These presentation settings are separate from the durable bridge identity/configuration, so they can change on restart without a configuration migration. They apply only to newly prepared batches. Existing payloads, including earlier JSON/Markdown formats, remain byte-for-byte stable for retries and history reconciliation. Update the Kin instructions when switching formats. No room whitelist or routing change is included.
