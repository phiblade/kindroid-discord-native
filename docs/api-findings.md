# API limits and recovery findings

Checked October 21, 2026. These findings separate published behavior from assumptions for the native bridge.

## Kindroid message size

Kindroid's October 30, 2024 announcement increased **user chat messages to 4,000 characters**. This is an input limit, not merely an AI response limit. [Kindroid announcement](https://www.reddit.com/r/KindroidAI/comments/1gfyqla/)

The current native API reference describes `/send-message` input as a string but does not publish a length maximum or character-counting convention. Use **4,000 characters for the complete outgoing message as the initial configurable project budget**, based on the chat limit. Equality between chat and API limits remains an inference. No live API size tests were run and no conversation was modified. [Native API reference](https://kindroid.ai/v2/docs/api-documentation/)

Include headers, batch ID, labels, and separators in the budget. A batch may contain several short messages or fragments of one long message. Do not equate a number of Discord messages with an API length limit.

## Native API contract

The API uses Bearer authentication. `POST /v1/send-message` takes `ai_id`, `message`, and `stream`; non-streaming replies are plain text. A successful HTTP status can still carry a generation error prefixed `<<ERROR>>`. The documented account-wide rate limit is 10 requests per 30 seconds.

`GET /v1/get-chat-messages` provides history with sender metadata and message IDs, oldest-first, using timestamp pagination. Its additional limit is 600 requests per 24 hours. Use it for uncertain-outcome recovery rather than continual polling. No send-message idempotency parameter is documented. [Native API reference](https://kindroid.ai/v2/docs/api-documentation/)

## Discord posting

Discord message content is limited to 2,000 characters. A nonce can identify the resulting message event. With nonce enforcement, a repeated nonce from the same author returns the existing message within a window described as the past few minutes. Do not assume permanent deduplication or a history lookup API by nonce. [Discord message reference](https://docs.discord.com/developers/resources/message#create-message)

## Railway and SQLite

Railway volumes do not support replicas and prevent simultaneous active deployments mounted to the same service, introducing some redeployment downtime. This supports the proposed single-process architecture. Railway backups cover volume contents, including SQLite. These are documented platform capabilities, not confirmation of this project's deployed settings. [Volume restrictions](https://docs.railway.com/volumes/reference), [backups](https://docs.railway.com/volumes/backups)

SQLite WAL commits changes to a journal before checkpointing them into the main database. `synchronous=FULL` adds commit synchronization for durability. Keep transactions short and use SQLite-aware backups or a coordinated snapshot rather than copying only the database file while writes are active. [WAL documentation](https://sqlite.org/wal.html), [synchronous setting](https://sqlite.org/pragma.html#pragma_synchronous)

## Controlled verification before live use

1. Use a dedicated test kin; sending a test changes its conversation.
2. Test complete payloads near 4,000 characters, including Unicode and envelope overhead. Confirm rejection behavior without assuming a particular status or silently truncating.
3. Verify exact batch-marker retention and history association for replies, including control replies and delayed generation.
4. Exercise interrupted responses and ensure unknown outcomes do not trigger automatic duplicate sends.
5. Test Discord chunk nonces, gateway/HTTP acknowledgment races, and a restart after partial posting.

A higher API limit is an optional optimization. The initial design does not depend on finding one.
