# Kindroid Discord Native

Connect one Discord home room to a dedicated Kindroid through its native API. The bridge stores incoming messages in SQLite, delivers them in batches, and posts the Kin's replies back to the room. Messages do not need to mention the bot. DMs and other rooms are ignored.

## Setup

Use Node **22.13 or later**. Install dependencies and create `.env` if it does not already exist:

```sh
npm install
test -f .env || cp .env.example .env
```

Set these values in `.env`:

| Variable                  | Value                                         |
| ------------------------- | --------------------------------------------- |
| `DISCORD_BOT_TOKEN`       | Discord bot token                             |
| `DISCORD_BOT_ID`          | Numeric bot user ID, without `@`              |
| `DISCORD_HOME_CHANNEL_ID` | Numeric home-channel ID, without `#`          |
| `KINDROID_AI_ID`          | Native Kin ID                                 |
| `KINDROID_API_KEY`        | Native Kindroid API key                       |
| `BRIDGE_DATABASE_PATH`    | SQLite path; defaults to `data/native.sqlite` |

Enable **Message Content Intent** for the Discord bot. Give it **View Channel**, **Read Message History**, and **Send Messages** permissions in its home room. A thread needs **Send Messages in Threads**.

Give the Kin the [bridge instructions](docs/milestone-3.md#kin-instructions), then start:

```sh
npm start
```

This builds the application, catches up on missed Discord messages, delivers queued messages to Kindroid, and posts replies. Use one process for this bot/Kin/database; stop a local instance before starting it on another host.

For intake only, without Kindroid requests or Discord replies:

```sh
npm run ingest:native
```

Run either intake or full delivery, not both against the same database. `.env` and local database files are excluded from Git.

## Conversation format

A default delivery looks like this:

```text
9c78273d-48e1-4e84-b7fd-4f0a92b51366
234567890123456789 Bob
345678901234567890 Phil

2026-10-21 09:41 UTC **Bob**
Hey, how's everyone doing?

2026-10-21 09:42 UTC **Phil**
Pretty good. What do you think?

0
```

The header contains the unique batch ID and one `author-ID Name` line per speaker. Double newlines separate the header, messages, and final remaining-message count. Message dates/times are original Discord posting times in UTC. Repeated line breaks in delivered message bodies collapse to one; original text remains in SQLite.

The Kin chooses whether to speak:

- Exact lowercase `none.` means no public reply.
- Exact lowercase `more.` continues catch-up when messages remain.
- Other nonempty, non-error replies are posted, even during catch-up. Replies longer than 2,000 UTF-16 units are split into ordered chunks.

Control replies tolerate surrounding whitespace, but quotation marks or additional text make them public speech. Deliberate `<@ID>` mentions can notify known participants; role and everyone notifications are disabled.

## Presentation settings

These `.env` switches accept `yes` or `no`:

```dotenv
CONTENT_PREPEND_MESSAGE_ID=no
CONTENT_PREPEND_DATE=yes
CONTENT_PREPEND_TIME=yes
CONTENT_PREPEND_ROOM_LABEL=no
CONTENT_PREPEND_ROOM_ID=no
```

Message headers put enabled fields in this order: message ID, `YYYY-MM-DD`, `HH:mm UTC`, then the bold speaker name. Enabled room metadata appears immediately after the batch ID. Restart after changing settings; only newly prepared batches use the new format. Saved batches keep their original text for retries and recovery.

See [`.env.example`](.env.example) for batch-size, timeout, and retry settings. The default complete-message budget is 4,000 UTF-16 units, including metadata; this is an initial assumption based on the chat limit, not a verified native API maximum.

## Persistence and recovery

The first new eligible message establishes a permanent history boundary. Older room history is excluded. Startup/reconnect backfill recovers available messages after that boundary before new Kindroid requests begin. Repeated events are deduplicated by Discord ID, and the bot's own messages are not sent back to the Kin.

New arrivals are saved while generation is in progress. Edits update unattempted queued text; prepared snapshots stay immutable and later edits are not redelivered. Live deletions cancel unattempted work. Deletions that happen while the bridge is offline are not reconciled yet.

SQLite preserves pending input, exact outgoing batches, replies, and posting receipts. Unknown request outcomes are reconciled conservatively and eventually blocked when evidence is insufficient; absence from history never authorizes a blind resend. See the [recovery runbook](docs/milestone-3.md#api-and-durable-recovery) before resolving blocked work or restoring a backup.

Keep the database and its journals on persistent storage and back them up together using a SQLite-aware backup or coordinated snapshot. For Railway, configure one process and a volume mounted at `/data`, with `BRIDGE_DATABASE_PATH=/data/native.sqlite`. Moving the existing database preserves its boundary and delivery history; a fresh database starts a new boundary. Deployment configuration and restore verification are separate operational steps, not performed by `npm start`.

## Current scope

The bridge handles text messages, embed text, live edits/deletions, and one home room. Embed titles, descriptions, fields (`Name: value`), and destination links follow the ordinary message text. Decorative icons, thumbnails, and colors are omitted. Images, attachments, reactions, and room whitelists are not implemented. It does not reset or configure the Kin's personality automatically.

GitHub commit notifications are delivered as readable embed text, including the commit description and links. Restart the bridge after updating to enable new ingestion behavior; messages already delivered to the Kin are not replayed.

Normal delivery has been exercised locally. Automated tests use fake transports or mocked HTTP/Discord responses; live interrupted-generation recovery and backup restoration still need controlled verification.

## Development

```sh
npm test
npm run lint
npm run simulate:native
npm run format:check
```

Prettier runs on staged files before every commit through Husky/lint-staged. `npm run format` formats the repository; `npm run prepare` reinstalls the hook. Tests and simulation do not send live messages.

- [Kin instructions and runtime details](docs/milestone-3.md)
- [Design](docs/design.md)
- [Implementation milestones](docs/implementation-plan.md)
- [API findings and verification checklist](docs/api-findings.md)
