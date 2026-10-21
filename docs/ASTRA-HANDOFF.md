# Presentation handoff after AI-013

The React/shadcn foundation owner releases renderer ownership after the AI-013 main commit. The next separate GPT six Astra chat owns full presentation refinement and implementation. This handoff is not a claim that the new presentation or voice modes already exist.

## Agreed next scope

Build a clean manager conversation interface, progress cards for **all worktrees**, and explicit open-mic start/stop plus hold-to-talk button/key controls. Never open the microphone on launch, reconnect or selecting a mode. Users converse only with the manager; worker questions/results queue attention until the user reviews them. Workers and their runtimes remain independent of voice/window lifetime.

Cards must reflect actual liveness, worker status and meaningful progress. Include actual ticket reference and verified ticket title/status where available; missing metadata remains unknown/null. A worker brief or generated title is not verified ticket metadata. Show elapsed wall time only with a genuine start/end/liveness basis; do not invent compute time, progress percentages or ETA. Report questions, blocks and results through the existing manager flow.

## Working foundation

- `renderer/src/manager/useCrewManager.js`: one stable SSE subscriber, prepared ChatGPT state, saved voice/catalog, manager turn state, transcript reducer, orchestration state, Review/approval/Stop callbacks.
- `renderer/src/manager/useVoiceSession.js`: owns peer/stream/channel/audio resources, generation cancellation, explicit Connect, mute/disconnect, greeting and bounded diagnostics. Reuse the cleanup/race guards when implementing modes; current hook intentionally retains pre-existing Connect/Mute/Disconnect semantics.
- `renderer/src/manager/{App,WorkerAttention,VoiceControls,WorkChat,Transcript,ApprovalForm}.jsx`: current presentation components. `visibleWorkers` still implements the previous bounded recent-history display; the new all-worktree view must deliberately replace it.
- `renderer/src/setup/**`: six-step setup, controlled drafts, stale-revision handling and native bounded preload. Preserve this working configuration flow while refining its presentation if needed.
- `renderer/src/components/ui/**`: genuine official shadcn CLI base-nova JavaScript components. Components use Base UI primitives, current `cn` dependency and Lucide. Avoid duplicating styled controls.
- `renderer/src/styles/theme.css`: **the only theme file**. It accepts official global CSS or `:root`/`.dark` token blocks directly. See [paste instructions](UI-FOUNDATION.md). Keep light mode. Initial primary #0c58fc matches approved icon blue; no logo redesign.

The manager renderer has no preload/Node access. Only exact compiled `renderer-dist/setup.html` receives `window.crewSetup`. API/SSE remain loopback and same-origin; compiled assets are a pinned bounded allowlist. Rebuilding while serving requires a controller restart, not weaker file identity checks. Package scripts build the renderer automatically. Source CLI launches need `npm ci` and `npm run renderer:build` first.

## Evidence and remaining checks

AI-013 verified automated regression/model/asset/theme checks, actual ChatGPT subscription preparation and catalog, browser setup journeys, simulated media lifecycle/approvals/review/manager-stop, responsive light views, and packaged bundled-runtime HTTP/API boundaries. Screenshots and logs are outside Git under `/tmp/crew-ai013-ux` and the paths listed in `tickets/AI-013.md`.

Browser preload and media fixtures do not prove native picker/permission/preload or audible WebRTC behavior. The Mac was locked while the user slept; they explicitly directed continuing without unlock/security changes. Native accessibility and physical-audio checks remain pending. Do not label them passed. The user's installed app/default config and prior AI-012 evidence are retained.

Document the next implementation against a new appropriate Crew ticket, update AGENTS/Notion with confirmed corrections, test actual behavior and retain screenshots outside the repository. The parent chat creates and coordinates the requested Astra chat; do not create a competing presentation owner from this foundation task.
