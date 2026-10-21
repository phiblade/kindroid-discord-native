# Milestone 2: Discord home-room ingestion

The native bridge can now collect live Discord messages into SQLite and recover missed history on startup or reconnect. Kindroid delivery and public Discord posting still use fake adapters in tests. The live ingestion command **only queues messages**; it never marks them delivered using a fake Kin.

## Run ingestion

Use Node 22.13 or later, run `npm install`, and supply these settings in `.env`:

```dotenv
DISCORD_BOT_TOKEN=your-bot-token
DISCORD_BOT_ID=your-bot-user-id
DISCORD_HOME_CHANNEL_ID=your-home-room-id
KINDROID_AI_ID=your-dedicated-kin-id
BRIDGE_DATABASE_PATH=data/native.sqlite
```

The existing native configuration defaults also apply (see [milestone 1](milestone-1.md)). Then run:

```sh
npm run ingest:native
```

Enable the bot's Message Content privileged intent in the Discord Developer Portal. Give it View Channel and Read Message History in its home room. The adapter validates channel access and the bot identity at readiness. It requests guild message events, not DM events, and filters by the exact home-channel ID. A thread is a separate channel; configure its ID if that is the intended home. Invitations and channel access remain administrator-managed.

`npm start` remains the inherited bridge until milestone 3. Do not deploy it expecting the new behavior. Keep the SQLite file and its journals together on persistent storage. Do not run multiple owners against the same database.

## Boundary and recovery

Only the first eligible newly observed message establishes the boundary. An empty installation does not import old history, and edits or the bot's own messages cannot establish that boundary. Other bots' messages are eligible; no mention is required.

On startup and gateway disconnect, native delivery is gated. Recovery fetches pages of up to 100 messages backwards from the current tail, stopping at the last completed recovery cursor (or initial boundary). Each page commits to SQLite, but the cursor advances only after the entire gap is complete. Live events persist immediately and never advance that cursor. Delivery then reads the complete queue in snowflake order.

Interrupted scans repeat from the tail after retry or restart, deduplicating already saved pages. Reconnects invalidate outstanding responses and begin a fresh scan. Empty history and deleted cursor messages are supported. A fetch failure leaves delivery gated; the live adapter retries while connected using `RETRY_MAX_MS` (default 60 seconds). Logs show fetched, cached, and pending counts without message contents.

Own bot messages are stored as delivered, so an echo arriving before its posting acknowledgment never re-enters the Kin queue. The coordinator accepts a delivery wake callback; integration tests use it with the milestone 1 fake transports. No delivery loop is started by the live ingestion CLI.

## Edits and deletes

Unattempted messages accept newer edits. Prepared batches and any source already fragmented remain immutable; later edits are retained separately for a future correction policy. Partial update events fetch the complete message. Deletes, including bulk deletes, leave persistent tombstones so overlapping history responses cannot resurrect them. A deleted, unattempted message is excluded from pending delivery. Once batching has begun, the immutable source continues through its remaining fragments; the deletion does not rewrite the attempted conversation.

SQLite schema version 2 adds deletion tombstones and automatically upgrades version 1 databases. Back up persistent databases before upgrading. Existing queue contents and boundaries are retained.

Discord cannot replay messages deleted while the bot was offline. Recovery handles available messages, not a complete audit log; edits/deletes to older messages outside the recovered range may also be unobservable after downtime. Attachments, embeds and reactions are not serialized yet; ingestion currently records textual content. Post-delivery corrections remain deferred.

## Verification and formatting

```sh
npm test
npm run lint
npm run simulate:native
npm run format:check
```

Tests exercise fresh boundaries, multiple recovery pages, overlapping live events, restarts, failed pages, reconnects during a fetch, edits/deletes, and schema upgrades. Live credentials are not needed for the tests.

Prettier is pinned as a development dependency. `npm run format` formats the repository. `npm install` installs the Husky pre-commit hook; the hook runs Prettier through lint-staged, including safe handling of partially staged files. Run `npm run prepare` to reinstall hooks in an existing checkout. Production installs can omit development dependencies. All future commits should pass the hook; avoid bypassing it with `--no-verify` or `HUSKY=0`.
