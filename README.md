# Kindroid Discord Native

This repository is the starting point for a durable Discord home-room bridge to Kindroid's native API. Native behavior is currently in design; the code and setup instructions below still describe the inherited Discord-endpoint connector.

- [Native bridge design](docs/design.md)
- [API limits and recovery findings](docs/api-findings.md)
- [Staged implementation plan](docs/implementation-plan.md)

## Inherited connector documentation

Tutorial on how to use this repo: https://docs.kindroid.ai/official-discord-bot-integration

A Node.js service that manages multiple Discord bots, each tied to a unique Kindroid AI persona. The system uses just-in-time message fetching to provide conversation context without storing large message logs.

## Features

- **Multi-bot** support: Run multiple Discord bots from a single service
- **Kindroid AI integration**: Each bot is tied to a unique AI persona (via `SHARED_AI_CODE_n`)
- **JIT message fetching**: Fetches configurable conversation history for servers and direct messages (default: 200 messages)
- **Caching**: Minimizes redundant Discord API calls
- **Graceful shutdown**: Bots disconnect on SIGINT/SIGTERM
- **Configurable NSFW filtering** via environment variables

## Prerequisites

- Node.js 16.x or higher
- Discord Bot Token(s) from the [Discord Developer Portal](https://discord.com/developers/applications)
- Kindroid AI API access (API key and share code)

## Setup

1. **Clone the repository**:

   ```bash
   git clone https://github.com/KindroidAI/Kindroid-discord.git
   cd Kindroid-discord
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Copy and configure .env:

   ```bash
   cp .env.example .env
   ```

4. Fill in your KINDROID_API_KEY, KINDROID_INFER_URL, and bot tokens (BOT_TOKEN_n).
   Provide SHARED_AI_CODE_n for each bot's AI persona.

5. Run in development mode:

   ```bash
   npm run dev
   ```

   For production:

   ```bash
   npm run build
   npm start
   ```

## Configuration

Use environment variables to configure your bots. The .env.example file shows usage:

- KINDROID_INFER_URL: The Kindroid AI API endpoint, and should not change
- KINDROID_API_KEY: Your Kindroid AI API key
- KINDROID_MESSAGE_CONTEXT: (Optional) Maximum number of recent messages sent to Kindroid in servers and direct messages. Must be an integer from 1 to 1000; defaults to 200. Set it in `.env` or your hosting environment and restart the service. This replaces `CURRENT_MESSAGE_CONTEXT`.
- DISCORD_FETCH_BATCH: (Optional) Discord initial fetch page size, an integer from 1 to 100; defaults to 100. Incremental checks use the smaller of this value and 10. This replaces the old `MESSAGE_FETCH_LIMIT` setting.
- CONTENT_PREPEND_SPEAKER: (Optional) Defaults to `yes`. Prefixes message text sent to Kindroid with the speaker label, for example `[Alex]: Hello` or `[{{ai}}]: Hi`. Set to `no` to send the original text. Also accepts `true`/`false` or `1`/`0`, case-insensitively. Applies to both servers and DMs; the `username` field and cached Discord content remain unchanged.

History is cached in memory separately for each bot and channel. The first request fetches pages of up to `DISCORD_FETCH_BATCH` messages until the context is full or history runs out. Every later request fetches the latest messages and pages backward in batches of up to 10 (capped by `DISCORD_FETCH_BATCH`) until it finds cached messages, reaches the start of history, or gathers a full new context. New messages are merged by Discord message ID, the cache is trimmed to the newest 1,000 messages when it grows beyond that size, and Kindroid receives only the newest `KINDROID_MESSAGE_CONTEXT` messages, oldest-first. Short channels are checked for new messages without repeatedly loading their entire history. Caches refill after a restart. Edits to fetched messages are refreshed; older edits and deletions are not reconciled by this incremental algorithm.

On Railway, set `KINDROID_MESSAGE_CONTEXT=200` and `DISCORD_FETCH_BATCH=100` in the service variables; the local `.env` is ignored by Git.
- SHARED_AI_CODE_n: The share code to identify which AI persona to use for the n-th bot
- BOT_TOKEN_n: Discord bot token for the n-th bot
- ENABLE_FILTER_n: (Optional) true or false to enable NSFW filtering for the n-th bot

You can create as many bots as you want by incrementing the number (\_1, \_2, \_3, etc.).

## Error Handling

Runtime logs include `[History bot=... channel=...]` entries for each Discord page (requested and received counts) and a refresh summary (fetched, new, cached before/after, trimmed, and selected context counts). `[Kindroid bot=... channel=...]` entries report the actual outgoing message count before the request and confirm successful responses. These count logs do not include message contents or credentials. `fetched` includes messages already present in the cache; `new` counts only previously uncached message IDs.

- Failed bot initialization is logged; other bots still initialize
- Conversation fetch failures are caught and logged
- API call errors log diagnostic info and return a friendly user message
- SIGINT or SIGTERM triggers a graceful shutdown of all bots

## Contributing

1. Fork this repository
2. Create your feature branch: `git checkout -b feature/amazing-feature`
3. Commit your changes: `git commit -m 'Add some amazing feature'`
4. Push to the branch: `git push origin feature/amazing-feature`
5. Open a Pull Request

## License

This project is licensed under the MIT License.
