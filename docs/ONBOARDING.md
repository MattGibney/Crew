# Crew setup and project discovery (AI-008)

Crew is the final product name. New defaults use `~/Library/Application Support/Crew`. The stable bundle identifier `local.voice.manager` remains to avoid an unnecessary macOS identity change. Prior Relay/Local Voice Manager defaults are detected with conservative migration/recovery; explicit custom paths remain explicit. The app stays local, one project per config/state/port. See [storage migration](STORAGE.md).

## Guided setup

New instances show Welcome → Local tools → ChatGPT & tools → Project → Permissions → Summary. Existing instances with saved manager state continue to the manager; **Set up Crew…** in the application or menu-bar menu reopens setup. Missing/bad config and runtime errors show setup rather than preventing the app from loading. An explicit missing config can be initialized there; malformed existing JSON is never overwritten automatically.

Local tools checks discover Codex and Git with normal executable/version commands. A manually selected Codex executable can be saved even before dependencies are available. The next step uses a short-lived, subscription-only app-server client to initialize, read public account type, query the v3 voice catalog and paginate MCP discovery. It creates no thread, turn, audio session or business task, reads no auth file and returns no account email/token. An explicitly chosen normal ChatGPT login uses the supported browser flow. Unsupported/unknown tool auth is not shown as denied. Tool advertisement is not access to a particular Linear scope; ask the manager for an explicitly scoped read of an existing ticket before business work.

The project form edits the authoritative JSON and existing Markdown paths. Validation preserves unknown/unavailable evidence, enforces paths/ref/config rules and retains a backup at `project.json.before-setup.json`. Saving while a controller exists requires no active task/manager turn/connecting or active voice; the owned idle controller restarts. It does not cancel work. A stateful instance cannot be reassigned to another project ID/state folder through setup. Configuration or prompt changes invalidate readiness checks; async checks discard results when inputs change during their run.

Summary distinguishes local configuration, verified account/protocol/catalog, discovered tools, actual path checks and OS microphone status. Opening the manager is allowed for configuration discussion with incomplete project setup; that is not a claim of business/voice readiness. Dispatch remains gated by project readiness and explicitly agreed ticket/work. Missing voice or skipped microphone access is not silently marked ready. Existing running controllers can be returned to without disrupting them.

## Optional project understanding

Choose **Project → Choose project folder… → Analyze selected project**. This starts one cancelable read-only setup job using Codex subscription access. It is separate from the manager/controller's business workers. Analysis reads a bounded snapshot: directory structure and selected AGENTS/README/docs/relevant source, up to 24 files, 16 KiB each, 128 KiB total, 500 entries/depth5. Dot/secret-like files, dependencies, generated output and symlinks are excluded; recognizable secrets are redacted heuristically. This is not a guarantee that arbitrary source files contain no sensitive content. Choose the intended folder knowingly; its selected snapshot is sent to Codex. No project scripts, shell/MCP tools, external ticket updates or additional agents run during analysis.

Results show source coverage/truncation, inferred/unknown findings and owner confirmation gaps. Repository base ref and Linear mapping are left unset. Review and edit the full proposed JSON, manager Markdown and worker Markdown; the UI lists the exact target files. **Apply these reviewed files** requires explicit review, the current proposal token and unchanged input configuration/prompts. Cancel/discard/error applies nothing. Apply creates new versioned prompt files, preserves prior prompts and atomically points validated config at them with a backup. Failed apply cleans up only its newly staged prompt files. Existing active work blocks apply. Generated files/configuration must stay outside the analyzed repository; repository contents are never edited by discovery.

## Permission limits and recovery

Microphone status preserves granted, denied, restricted, not-determined and unknown. **Request microphone permission** invokes macOS permission only when undetermined, without getUserMedia, recording or a voice call. Denied/restricted states use the Microphone settings link; do not keep prompting. Quit/reopen may be needed after privacy changes. The setup renderer denies browser media permissions entirely; the manager's separate exact-origin audio policy remains unchanged.

Files/Folders are checked by selecting the actual folder and probing the configured repository/ref, readable prompts and a removed temporary state-folder write. Terminal access does not establish packaged-app or worker-sandbox access. No Full Disk Access, camera or screen-recording request is required.

There is no generic Electron/macOS Local Network request/status API here. Crew uses a loopback controller and WebRTC for explicitly started voice, with no LAN discovery feature. Setup does not scan the LAN, send an artificial UDP probe or pretend a boolean says network permission is granted. A settings link and usage description explain actual connectivity if macOS prompts during a real operation. Network/auth/routing errors require their own diagnosis rather than being labelled permission denial.

## Release and validation

Version0.4.0 remains unsigned/unnotarized Apple Silicon/macOS13+, with manual updates. Codex/Git/ChatGPT/MCP are external prerequisites. AI-007 live Electron microphone/conversation passed by user report; new onboarding's native permission prompt/denied recovery and fresh login require a human when those states are present. Autonomous tests never open a competing microphone, change account login, alter OS privacy settings or launch business work.

[Supported Codex app-server account and MCP methods](https://learn.chatgpt.com/docs/app-server). Platform access uses Electron `systemPreferences` and native file dialogs; scope and unknown states above are intentional.
