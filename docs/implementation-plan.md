# Native bridge implementation plan

This plan implements [the agreed design](design.md) incrementally. The existing runtime is still the inherited Discord-endpoint bridge. Milestone 1 is implemented and tested against fake APIs; see [its runbook](milestone-1.md). Do not deploy the inherited entry point expecting native behavior.

## Milestone 1 Storage and delivery simulation

Status: complete for the simulated core. Real API adapters and account-wide throttling remain in later milestones.

Build the SQLite schema, migrations, configuration validation, message boundary, immutable batches, retry state, and one delivery loop per kin. Inject fake Discord and Kindroid transports and a controllable clock. Implement batch sizing with a configurable 4,000-character default assumption, including headers and oversized-message fragments.

Acceptance checks:

- Five incoming messages during one generation are committed immediately and delivered later in order, with only one active request per kin.
- Duplicate events do not duplicate messages; a wake at the idle transition cannot strand work.
- DMs and other channels are excluded. The first eligible incoming message establishes a persistent boundary; old history is not imported.
- Control replies stay private, while substantive catch-up replies are queued for posting.
- Pending and uncertain records survive pruning beyond 1,000 cached messages.
- Failures before send, during send, after response, and around every commit produce recoverable states.
- Reply text, chunk boundaries, nonces, retry deadlines, and confirmed IDs survive restart.
- Unicode and oversized source messages are preserved and delivered only once per confirmed fragment.

Review the simulated lifecycle before connecting live services.

## Milestone 2 Discord ingestion

Connect the home-room event handler and recovery pagination. Persist every eligible message, deduplicate overlapping gateway/history events, and keep the boundary and cursor crash-safe. Observe edits/deletions without silently rewriting attempted batches. Resolve their post-delivery policy before enabling correction delivery.

Test restart after missed messages, multiple pages of backlog, events during backfill, bot-authored messages, and gateway events arriving before posting acknowledgments. A recovered gap must not reorder outbound history.

## Milestone 3 Native delivery and public replies

Replace share-code calls with native Kin ID delivery. Add the shared account limiter, error classification, history reconciliation, and exact reply protocol. Complete durable Discord chunk posting in the existing loop, with nonce enforcement and uncertain-post recovery.

Verify that all substantive replies are posted even when backlog remains. Resume unfinished replies before new generation. API errors are never treated as public speech, and ambiguous posts are never blindly repeated.

Update package identity, runtime README, environment examples, and logs. Remove obsolete Discord-endpoint settings and snapshot assumptions only when their replacements exist. The native repository is published at `pzentt/kindroid-discord-native`.

## Milestone 4 Controlled Railway trial

Create the native project's deployment separately from the original bridge. Configure one process and a persistent volume; enable backups and verify restore behavior. Install the agreed kin personality instructions manually and ignore DMs. Use a dedicated test channel and kin.

Run the [API verification checks](api-findings.md#controlled-verification-before-live-use), then exercise redeploys, interrupted generation, posting failures, partial replies, downtime backfill, and burst traffic. Inspect counts and recovery status without logging message contents.

## Milestone 5 Operational review

Resolve remaining edit/deletion, mention, attachment, and completed-record retention policies. Document configuration, recovery actions, backups, and known limitations. Consider a database thread, a separate posting loop, or a larger native batch budget only when measured behavior warrants them.

Milestone 1 makes no live API calls, deployment changes, or personality updates. Review its simulation before starting Milestone 2.
