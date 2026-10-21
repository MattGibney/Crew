# Manager renderer foundation

`main.jsx` mounts the React manager without StrictMode. This is the working manager interface, not a wrapper around the legacy DOM script.

- `useCrewManager` owns configuration/account preparation, the voice catalog and storage migration, one SSE connection, transcript reducer, backend work and worker attention snapshots. SSE events never start a model turn or microphone. API mutations remain explicit user actions.
- `useVoiceSession` owns peer connection, local tracks, data channel, audio ref, generation cancellation, call timeout, one startup-greeting request and bounded audio diagnostics. Connect is the only microphone entry point. Disconnect, transport loss, page hide and unmount release media. No audio is recorded by the renderer.
- `WorkerAttention`, `VoiceControls`, `WorkChat` and `Transcript` compose the current functional surfaces using generated shadcn components and shared theme tokens. Astra can change composition and presentation while preserving hooks and endpoint contracts.
- `ApprovalForm` keeps answers in React state per request ID. It preserves user-input, permission, command/file and supported MCP approvals, with unsupported forms failing closed. HTTPS verification links open through the desktop shell's existing system-browser handler.
- `state.js` contains deterministic transcript, voice and worker-selection behavior. Functional IDs from the original interface remain for end-to-end checks.

The renderer calls only same-origin `/api/*` and `/events`; authentication and orchestration stay in the backend. Stop manager work interrupts the current manager turn, not workers. Voice/browser closure never cancels controller work. Errors retain unavailable states rather than reporting successful sign-in, healthy tools or completed work without backend evidence.

Tests for this foundation should check no microphone request on mount; stored voice migration; explicit connect and selected voice signaling; once-per-call greeting; mute/disconnect; pending permission cancellation; SSE loss; approval payloads and retained input across state refreshes; worker review and manager stop. Real audible voice remains a separate human acceptance check.
