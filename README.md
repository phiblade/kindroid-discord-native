# Kindroid Discord Native

A durable Discord home-room connector for one dedicated Kindroid, using the native Kindroid API. Every home-room message is queued in SQLite. The Kin chooses whether to speak; mentions are not required. DMs and other rooms are ignored.

## Setup

Use Node **22.13 or later**:

```sh
npm install
cp .env.example .env
```

Fill in `.env` with your Discord token, numeric bot user ID, numeric home-channel ID, native Kin ID, and native Kindroid API key. If `.env` already exists, update it rather than replacing it. Native API keys are available in Kindroid under Profile → Preferences → API & Integrations. Old share codes, numbered bot tokens, and the Discord-dedicated inference URL are not used by this runtime.

Enable Message Content Intent in the Discord Developer Portal. Grant the bot View Channel, Read Message History, and Send Messages in its home room (Send Messages in Threads for a thread).

Configure the Kin with the [bridge instructions](docs/milestone-3.md#kin-instructions). Use a dedicated Kin conversation and only one process for this bot/Kin. The original connector is a separate project: stop its use of the same bot in this room, or use a separate test bot, before testing public replies.

```sh
npm start
```

**This sends real messages.** After Discord catch-up completes, it delivers existing pending SQLite messages to Kindroid and posts substantive replies to the home room. To collect messages without sending them, use:

```sh
npm run ingest:native
```

Stop ingestion before starting native delivery. Do not run both commands against the same database. `.env` and local SQLite files are excluded from Git. On Railway, use one service/process and a persistent volume; deployment and backup/restore verification remain milestone 4.

## Behavior

- The first new eligible message establishes a permanent boundary; older room history is excluded.
- Startup/reconnect backfill fills the gap before new Kindroid requests. SQLite deduplicates overlapping events.
- One asynchronous delivery loop sends the oldest pending messages within a configurable batch budget. New arrivals persist while generation runs.
- Exact trimmed `none.` and `more.` replies stay private. Other replies are posted, even during catch-up, in persisted chunks of at most 2,000 UTF-16 units.
- Edits replace unattempted queued text. Attempted snapshots stay immutable; later edits are retained but not redelivered. Live deletes cancel unattempted work. Offline deletion reconciliation is deferred.
- Known participant mentions are allowed; role and everyone notifications are disabled.
- Unknown send/post outcomes are reconciled conservatively and eventually blocked if evidence is insufficient. The bridge never treats “not found” as permission to resend.

See [milestone 3](docs/milestone-3.md) for configuration, recovery limitations, and the live test procedure. The API wire shapes are tested with mocked HTTP/Discord responses; no automated test modifies a real Kin or Discord channel.

## Development

```sh
npm test
npm run lint
npm run simulate:native
npm run format:check
```

Prettier runs on staged files before every commit through Husky/lint-staged. `npm run format` formats the repository; `npm run prepare` reinstalls the hook.

The inherited connector source and tests remain for reference. It is only started explicitly with `npm run start:legacy`; native startup never falls back to the old endpoint.

- [Design](docs/design.md)
- [Milestones](docs/implementation-plan.md)
- [API findings and verification checklist](docs/api-findings.md)
- [Storage simulation](docs/milestone-1.md)
- [Discord ingestion](docs/milestone-2.md)
