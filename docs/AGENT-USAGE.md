# Native subscription allowance

`SubscriptionUsageSnapshot` in `src/agents/codex-usage.mts` is the read-only owner
display boundary. `application.subscription.usage()` returns a runtime result;
`subscribeUsage(listener)` publishes validated native updates and returns an
unsubscribe function. The desktop owner adapter and UI mount one subscription
per project host; views do not poll per agent or worker.

The runtime prefers an already connected, subscription-authenticated peer. When
none is connected, the access provider uses its existing isolated owner account
launch, verifies configuration and reads the account type before fetching limits.
It starts no thread, resumes no chat and does not alter sign-in or redeem resets.
Concurrent reads share one pending operation. Native failures become fixed,
sanitized unavailable/unsupported errors; the UI retains its last successful
snapshot as stale until a read succeeds.

The snapshot includes host `observedAt`, backend `ordinaryUsageAllowed` when
returned, named limit buckets and their primary/secondary windows. Usage is
account-wide. `usedPercent` is returned usage; remaining percentage is
`max(0, min(100, 100 - usedPercent))`. Reset times are Unix seconds and the UI
formats them in the owner's timezone. No fixed weekly token balance is inferred.

The multi-bucket map takes precedence over the legacy single-bucket view.
Missing/null fields remain unavailable. Sparse updates preserve omitted values;
explicit null clears them. An ambiguous bucket update requests a fresh read.
Reset `availableCount` is authoritative even when details are absent or capped.
Details preserve returned status/expiry, with no opaque credit ID. Account IDs,
auth fields, monetary balances and credit balances never cross this boundary.

Protocol source: [official OpenAI documentation](https://learn.chatgpt.com/docs/app-server),
account rate-limit reads/updates. Actual installed support and real subscription
acceptance must be verified separately from generated schemas and fake peers.
