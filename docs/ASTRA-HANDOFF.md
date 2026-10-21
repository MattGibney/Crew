# Renderer implementation handoff

The React/shadcn foundation and manager presentation are implemented. This file retains the historical handoff filename for compatibility and describes the durable engineering boundaries for later renderer work.

## Foundation to preserve

- `renderer/src/manager/useCrewManager.js`: stable SSE subscriber, prepared account state, saved voice/catalog, manager turns, native transcript state and targeted Review/approval/Stop callbacks.
- `renderer/src/manager/useVoiceSession.js`: owns peer/stream/channel/audio resources, generation cancellation, explicit connection, microphone modes, greeting and bounded diagnostics. Reuse its race/cleanup guards.
- `renderer/src/manager/`: manager conversation, complete worker/history presentation, approvals and explicit voice controls. Keep the manager as the only conversational interface.
- `renderer/src/setup/`: six-step setup, controlled drafts, stale-revision handling and native bounded preload.
- `renderer/src/components/ui/`: official shadcn JavaScript components with Base UI and Lucide.
- `renderer/src/styles/theme.css`: the only theme file, accepting official theme output directly. Keep semantic utilities and approved branding.

Cards must distinguish actual worktree/task identity, task status, observed process liveness and verified ticket metadata. Missing data stays unavailable; cosmetic state must not invent progress, compute time or ETA. Correlated user actions go through the manager and target only the selected task/run.

## Security and acceptance

The manager has no preload or Node access. Only exact compiled `renderer-dist/setup.html` receives the bounded setup bridge. API/SSE remain loopback and same-origin; compiled assets use a pinned bounded allowlist. Rebuilding while serving requires a controller restart rather than weaker identity checks.

Browser fixtures and automated checks cover configuration, state, media cleanup and responsive behavior. Actual subscription and bundled-runtime checks establish their measured boundaries. Synthetic media/preload fixtures do not prove native picker, permission, microphone, speaker or accessibility behavior. If native observation is unavailable, retain that explicit gap without bypassing device security.

Tie further implementation to an appropriate ticket, preserve source/runtime contracts, and keep private acceptance logs and screenshots outside the public repository.
