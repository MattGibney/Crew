# REL-0.17.3 — Settings accept unused lifecycle phases

The human explicitly authorized merging PR75/GH74 and one signed stable patch after published 0.17.2. Settings now accepts the backend's valid null optional project lifecycle phases instead of failing the entire view. Populated project commands and direct hooks stay strictly validated; no backend behavior, configuration migration or user state rewrite is needed. PR54 and unrelated features remain excluded.

Exact Node 24.22.0 strict typing, fresh build and all 753 current tests pass at PR75 head 52e0901. The backend-store/renderer regression covers all six null phases, saving/reopening and malformed non-null commands; compiled browser acceptance covers null phases, edit/save/reload, cancellation, stale edits and narrow layout. Real packaged Settings acceptance and signed publication remain pending.

Preserve immutable previous tags/releases and failed records. Signing credentials remain encrypted GitHub secrets. Use disposable native profiles and synthetic peers, without physical microphone, installed-profile/auth/live-worker or business-service mutations. Independently verify public assets/feed/checksums/signature and tagged-build parity after publication. Keep manual continuity separate from the unresolved automatic portable-root updater relaunch and issue39 limits.
