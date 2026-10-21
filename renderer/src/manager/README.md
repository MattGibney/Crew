# Manager renderer foundation

`main.jsx` mounts the React manager without StrictMode. This is the working manager interface, not a wrapper around the legacy DOM script.

- `useCrewManager` owns configuration/account preparation, the voice catalog and storage migration, one SSE connection, transcript reducer, backend work and worker attention snapshots. SSE events never start a model turn or microphone. API mutations remain explicit user actions.
- `useVoiceSession` owns peer connection, local tracks, data channel, audio ref, generation cancellation, call timeout, one startup connection acknowledgement and bounded audio diagnostics. Connect is the only microphone entry point. Disconnect, transport loss, window pagehide and application unmount release media. Ordinary project/global view navigation preserves the hook and its one App-owned playback element. No audio is recorded by the renderer.
- `WorkerAttention`, `WorkerDetail`, `ManagerCallBar`, `VoiceControls`, `WorkChat` and `Transcript` compose the current functional surfaces using generated shadcn components and shared theme tokens. Astra can change composition and presentation while preserving hooks and endpoint contracts.
- `ApprovalForm` keeps answers in React state per request ID. It preserves user-input, permission, command/file and supported MCP approvals, with unsupported forms failing closed. HTTPS verification links open through the desktop shell's existing system-browser handler.
- `state.js` contains deterministic transcript, voice and worker-selection behavior. Functional IDs from the original interface remain for end-to-end checks.

The renderer calls only same-origin `/api/*` and `/events`; authentication and orchestration stay in the backend. Stop current turn interrupts the current manager turn. Settings provides explicit manager Start, Stop and Restart controls; stopped managers reject work and voice while independent workers and their attention history remain intact. Voice/browser closure never cancels controller work. Errors retain unavailable states rather than reporting successful sign-in, healthy tools or completed work without backend evidence.

Tests for this foundation should check no microphone request on mount; stored voice migration; explicit connect and selected voice signaling; once-per-call acknowledgement; mute/disconnect; pending permission cancellation; SSE loss; approval payloads and retained input across state refreshes; worker review and manager stop. Real audible voice remains a separate human acceptance check.

## Project instruction settings (GitHub #3)

`Settings` edits the complete Crew manager and worker behavior for this project. Runtime/tool protocol context remains outside the editor, and provider rules still apply. Defaults are initially visible; Reset stages the full default text and still requires Save. Saving manager instructions does not activate them: the saved and active versions remain visible until an explicit manager restart. Worker saves apply to new worker launches; retained workers keep immutable snapshots.

The settings view and conversation remain mounted while switching views, preserving both prompt and chat drafts. Optimistic version checks reject stale saves without losing text. A newer edit made while Save is in flight is retained and rebased to the confirmed saved version. No settings action requests microphone access. Stop and Restart dispose browser media before their backend lifecycle request; Start refreshes the voice catalog but never connects voice. Lifecycle errors and incomplete transitions remain visible, and approval answers stay available so the user can resolve a blocked stop.

Sound ownership and the explicit action-required attention protocol are documented in [docs/SOUNDS.md](../../../docs/SOUNDS.md). Call tones belong to the voice resource lifecycle; notification tones use explicit evidence and stable identities, never generic message or failure events.
