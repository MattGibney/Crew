# Specialist-agent delivery checkpoint (#127)

This candidate combines the specialist architecture with the chronological chat work (#123 / PR #125) and simplified group capabilities and workspace choices (#124 / PR #126). It is a reviewable development candidate, not a published release.

## Implemented

- A business project can use a normal folder without Git. Shared folders, service identities and nonsecret project references remain separate resources with their own authority.
- Persistent agents share one runtime. The owner can select a specialist as the direct text/voice contact without changing its reporting relationship or the default coordinating manager, starting work or opening the microphone.
- Groups additively confer Crew capabilities, project skills, service connections/operations and resource visibility. Historical individual selections do not override group authority. Existing access migrates without broadening service-account access.
- Service credentials stay in the Crew vault and gateway. Personal and dedicated identities are explicit choices; model subscription authentication remains separate. Gmail has bounded read/draft/send support and correlated vaulted refresh.
- Versioned environment templates define tools and setup. Agents explicitly prepare their private working context, execute permitted commands and report preparation. Durable change notices ask the agent to reconcile; Crew does not silently rebuild or run setup.
- Each agent can own several browser tabs. Public browsing needs both browser control and external-browsing group capabilities; calls and ongoing requests check current authority. Agent storage is separated.
- Typed and retained voice text share a chronological chat with drafts, stable handoff identity and earlier-history loading.

Operating details are in [architecture](SPECIALIST-AGENT-ARCHITECTURE.md), [group access](GROUP-DERIVED-ACCESS.md), [environments](AGENT-ENVIRONMENTS.md), [business projects](BUSINESS-PROJECTS.md) and [browser](unified-browser.md).

## Validation performed

This is focused acceptance, not a full regression-suite claim.

- Combined TypeScript checks, production build and unsigned Apple Silicon desktop packaging passed.
- Disposable store/API acceptance covered contact selection, resource revisions and visibility, revocation, private-path ownership, bounded saves and reopen.
- Real desktop renderer acceptance covered specialist switching, separate unsent drafts, unchanged manager identity and no implicit voice start.
- The chronological chat browser acceptance passed ordering, retention handoff, reload, drafts, stable scrolling, narrow layout and explicit-only dispatch checks.
- Real Electron/CDP/MCP browser acceptance passed 31 checks, including agent/tab ownership, cookie isolation, public assets/redirects, private-origin rejection and revocation.
- Focused group/gateway/environment checks covered legacy migration, exact service intersections, group-derived discovery, expired/near-expiry OAuth refresh, lost verification replies, mailbox mismatch, private execution and denied authority.
- A signed-in disposable native specialist used its assigned skill, discovered an approved resource, wrote a proof file in its own private environment without a repository grant and browsed a public page using real Crew tools.
- A real native coordinating agent created one child from an approved preset, started it, delegated a scratchpad-only objective, received the child's completion report and acknowledged it. The child received that acknowledgement.
- The packaged candidate opened the same disposable native thread, read 170 retained history items, showed the specialist selector, started no new turn and quit normally.

Two private model-test harness assertions were corrected through saved evidence rather than repeating successful model work: the browser final assertion omitted an argument, and the delegation wait inspected an empty Foundation message list after native delivery. Original automated failure flags are retained. Exact native call/result and chat records establish the browser operation and bidirectional report exchange. All test sessions were confirmed stopped and original disposable settings restored. These are documented harness limitations, not claims that the original assertions passed.

The owner's running app, profile, sign-in, chat, project source and microphone were not used for these acceptance tasks. No service credential was copied and no real email was sent.

## Remaining boundaries

- A dedicated UI pass is deferred. Compatibility controls exist, but some labels still refer to a single manager; resource reference authoring currently uses the owner API.
- Physical voice/audio acceptance and live Google/GitHub/Linear account operations were not performed. The new voice contact binding was checked without microphone capture.
- Google OAuth client/consent setup is owner-managed. Crew cannot import an existing personal Codex connector login. Gmail composition is single-recipient plain text; no attachments, CC/BCC, reply threading, draft editing or label administration. Responses exceeding the current 256 KiB JSON validation limit fail explicitly.
- Permission revocation affects fresh calls; it cannot erase material already consumed by a model. Native cached skill/configuration changes need explicit Restart.
- Templates do not automatically install tools. Preparation exposes missing tooling and permits explicit setup within granted authority. A private working context is not a VM or a hostile-code security boundary; enabled host/container tooling retains its documented limitations.
- Browser tab records are in memory across app exit; cookie storage persists. Public-origin checks are not a general hostile-network sandbox.
- Existing voice artifacts can be rendered, but previously uncaptured voice text cannot be reconstructed. Large-scale agent operation, multi-party voice and cross-agent shared memory are not established by this small-loop acceptance.

No new merge, release, installation or replacement of the running owner build is part of this checkpoint.
