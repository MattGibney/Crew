# Manager renderer foundation

`main.jsx` mounts the React manager without StrictMode. This is the working manager interface, not a wrapper around the legacy DOM script.

- `useCrewManager` owns configuration/account preparation, the voice catalog and storage migration, one SSE connection, transcript reducer, backend work and worker attention snapshots. SSE events never start a model turn or microphone. API mutations remain explicit user actions.
- `useVoiceSession` owns peer connection, local tracks, data channel, audio ref, generation cancellation, call timeout, one startup connection acknowledgement and bounded audio diagnostics. Connect is the only microphone entry point. Disconnect, transport loss, window pagehide and application unmount release media. Ordinary project/global view navigation preserves the hook and its one App-owned playback element. No audio is recorded by the renderer.
- `WorkerAttention`, `WorkerDetail`, `ManagerCallBar`, `VoiceControls`, `WorkChat` and `Transcript` compose the current functional surfaces using generated shadcn components and shared theme tokens. Astra can change composition and presentation while preserving hooks and endpoint contracts.

- `useCrewManager` owns configuration/account preparation, the voice catalog and storage migration, one SSE connection, unified conversation snapshots, backend work and worker attention snapshots. SSE events never start a model turn or microphone. API mutations remain explicit user actions.
- `useVoiceSession` owns peer connection, local tracks, data channel, audio ref, generation cancellation, call timeout, one startup connection acknowledgement and bounded audio diagnostics. Connect is the only microphone entry point. Disconnect, transport loss, page hide and unmount release media. No audio is recorded by the renderer.
- `WorkerAttention`, `VoiceControls`, `WorkChat` and `Message` compose the current functional surfaces using generated shadcn components and shared theme tokens. Astra can change composition and presentation while preserving hooks and endpoint contracts.
- `ApprovalForm` keeps answers in React state per request ID. It preserves user-input, permission, command/file and supported MCP approvals, with unsupported forms failing closed. HTTPS verification links open through the desktop shell's existing system-browser handler.
- `state.js` contains deterministic voice selection and verification-link behavior. `conversation-timeline.mjs` projects observed native message/transcript identities into the one backend message stream. Functional IDs from the original interface remain for end-to-end checks.

The renderer calls only same-origin `/api/*` and `/events`; authentication and orchestration stay in the backend. Stop current turn interrupts the current manager turn. Settings provides explicit manager Start, Stop and Restart controls; stopped managers reject work and voice while independent workers and their attention history remain intact. Voice/browser closure never cancels controller work. Errors retain unavailable states rather than reporting successful sign-in, healthy tools or completed work without backend evidence.

Tests for this foundation should check no microphone request on mount; stored voice migration; explicit connect and selected voice signaling; once-per-call acknowledgement; mute/disconnect; pending permission cancellation; SSE loss; approval payloads and retained input across state refreshes; worker review and manager stop. Real audible voice remains a separate human acceptance check.

## Project instruction settings (GitHub #3)

`Settings` edits the complete Crew manager and worker behavior for this project. Runtime/tool protocol context remains outside the editor, and provider rules still apply. Defaults are initially visible; Reset stages the full default text and still requires Save. Saving manager instructions does not activate them: the saved and active versions remain visible until an explicit manager restart. Worker saves apply to the next direction or launch; original run snapshots remain factual history.

The settings view and conversation remain mounted while switching views, preserving both prompt and chat drafts. Optimistic version checks reject stale saves without losing text. A newer edit made while Save is in flight is retained and rebased to the confirmed saved version. No settings action requests microphone access. Stop and Restart dispose browser media before their backend lifecycle request; Start refreshes the voice catalog but never connects voice. Lifecycle errors and incomplete transitions remain visible, and approval answers stay available so the user can resolve a blocked stop.

Sound ownership and the explicit action-required attention protocol are documented in [docs/SOUNDS.md](../../../docs/SOUNDS.md). Call tones belong to the voice resource lifecycle; notification tones use explicit evidence and stable identities, never generic message or failure events.

## One conversation for typed and spoken messages (GitHub #15)

`WorkChat` consumes `work.messages` only. `Message` renders spoken and typed messages identically, with a small Live or Partial transcript status when speech is unfinished. The browser has no second transcript buffer and Connect does not reset history. Native canonical timeline entries restore mixed history and identify promoted execution items without repeating them; the bounded private bridge journal also preserves unfinished observed speech. Unsupported canonical history uses recent native turns plus the journal; schema advertisement alone does not prove method support. No transcript event starts a model turn or replays a handoff.

## Project manager profile

Settings owns the per-project manager profile. `GET /api/settings` returns `managerProfile` with nullable `voice` (null means the advertised Codex default), `name`, nullable embedded raster `picture`, `personality` and a version. `PUT /api/settings/manager-profile` saves only supplied profile fields with `expectedVersion`, using serialized atomic replacement in the project state directory, `manager-profiles/<projectId>.json`. Stale updates and unreadable/invalid retained profiles fail without replacing existing data. Name/picture presentation updates immediately; saved name/personality join the manager instructions only on explicit Start or Restart in Sessions. The prompt editor remains unchanged and describes this optional supplement. Voice remains separate and applies on the next explicit call. Old browser-wide voice values are retained but no longer read; they are not copied between projects.

Local profile pictures accept PNG, JPEG or WebP up to 512 KiB and 2048 pixels per dimension. The renderer checks type, bounded size and successful bitmap decoding before upload; the server independently validates the retained data. The avatar renderer accepts bounded embedded raster data only, never a profile-provided URL or local path, and falls back to the Crew mark on a load error. Picture selection and profile saves never connect voice or activate capture. Unsaved profile editors stay mounted across Settings page changes; stale saves preserve the draft for recovery.

The composer has no voice selector or microphone mode. Calls retain open-microphone/mute intent and explicit connection semantics; the previous independent push-to-talk mode/shortcut is removed. A future mute-based hold interaction is intentionally not implemented.

### Chat reading and tool activity

The main chat composes the shadcn Base Nova Message Scroller with `@shadcn/react/message-scroller`. Each canonical message is a separately keyed row; rows deliberately have no turn anchors. Saved conversations open at the bottom. New user rows must not trigger an implicit jump to the top. The 8 px bottom threshold accommodates fractional layout geometry while respecting a deliberate scroll away. Follow-output releases on wheel, touch and keyboard scrolling; the explicit Jump to latest button resumes it. Keep the composer outside the viewport so its height does not determine the jump-button position. The primitive handles layout observation and prepended-history position preservation; do not restore the former message-array effect that always scrolls to the bottom.

Tool activity uses the shadcn Trace/Collapsible parts and only existing backend work items, retaining supplied status and exit codes. This is a separate recorded-activity disclosure, not inferred reasoning or a guessed chronological tool timeline. Transcript announcements are quiet; busy state and actionable approvals retain their existing accessibility roles. Message copying uses plain source text and reports clipboard failures. Text drafts retain project-partition persistence and async submission protection.

Source references: https://ui.shadcn.com/docs/components/base/message-scroller and https://ui.shadcn.com/docs/components/base/trace. Registry components are adapted to JavaScript and the project's existing Button/Lucide imports.

Rich assistant output uses `MessageContent.jsx`: fenced/indented code has an independent copy action (including exact whitespace), inline code stays compact, and Markdown images use responsive lazy-loaded images with no-referrer and a broken-image fallback. The controller CSP permits same-origin and HTTPS image sources without expanding scripts, connections or arbitrary local-file serving. Local file paths still need an explicitly supported asset transport; Markdown does not grant file access.

The native macOS project window uses `desktop/window-chrome.mjs` for hidden-inset chrome and native traffic lights at `(16,12)` in the integrated application header. The workspace preload exposes only a read-only `crewWindow.integratedTitlebar` flag; the renderer reserves 28 px above the branding, retains its normal left padding and marks header whitespace draggable, excluding interactive elements/popovers. Browser and other-platform layouts retain their standard header spacing and window chrome. Existing native close/minimize/fullscreen and project-host cleanup handlers remain authoritative.

Native header Updates and connection status occupy the top-right inset opposite the OS controls. Settings stays on the main branding row; the browser retains its ordinary inline layout.

### Native integration acceptance

Native clipboard writes use the bounded `crewWindow.copyText` preload capability and main-process selected-window/main-frame/origin validation. Browser permission policy remains restricted; no clipboard read API is exposed. Both code and complete-message copy use this transport in Electron and the browser Clipboard API in the ordinary preview.

Legacy voice preferences migrate once from the project's existing Chromium partition into its manager profile after the catalog is available. Explicit profile selections, including the default voice, win over retained legacy values. Failed writes preserve the old preference. Blocked audio playback exposes an explicit Enable audio action; successful recovery or disconnect clears it, including late failure callbacks.

Combined acceptance uses an unsigned packaged candidate with separate portable state, two registered projects, the real local controllers and a synthetic stdio provider. It checks persisted rename/capacity/profile/instructions, explicit Restart, restored history, rich message rendering and native copy, worker detail/navigation, update-popout dismissal and call-failure cleanup. No physical microphone, real model turn, external ticket or actual repository worker is needed for these UI checks. Acoustic preference and a signed production update are distinct acceptance steps; candidate packaging does not publish or replace the installed app.
