# Unattended usable first-pass delivery

Owner-approved on 22 October 2026. Baseline: unified feature branch at `44cb082`. The target is working core functionality for iteration, not polish or broad test coverage. Main integration is authorised; signed release/public installation is not.

## Tracks

| Track | Issues | Delivery responsibility |
| --- | --- | --- |
| Owner UI | #109, #52; reconcile #34/#95/#100 | Agent table/editor, primary-manager selection, canonical agent voice/profile and allowance view |
| Environments/access | #108; reconcile #89/#90/#101 | Reusable project templates, optional approved tools, environment execution for existing development tooling |
| Native/runtime | #107, #52; reconcile #88/#102 | Retained voice retrieval/provenance, read-only subscription usage contract and session continuity |
| Browser | #56 | Isolated local preview, authorised agent control and annotation-to-agent messaging |
| Integration/recovery | #106/#39/#53; reconcile #84/#86 | Deliberate abandoned-lock recovery, Quit/reopen, repository presentation, combined acceptance and main merge |

## Decisions and boundaries

- Templates are project-scoped for the first pass. Reuse approved host tools where suitable; do not silently install globally or infer credentials. Agents initiate environment work. Permission groups remain authority.
- Manager is an agent role. One saved configuration and one editor own profile/voice/access choices; model subscription and service identities remain separate.
- Browser first pass may be limited to one explicitly allowed local application origin/page, but includes real agent availability and a usable annotation path. No raw privileged Electron debugger for agents.
- Native history remains the chat authority. Establish exact public voice provenance rather than infer from timing or text. Any separate display artifact must have explicit ownership and must not become competing model context.
- The signed-in partial test build is authorised for text acceptance; no physical microphone or copied authentication. Preserve current work. Use disposable fixtures for failure/destructive cases.
- Read Set1's actual repository instructions; run existing development commands unchanged. Do not patch Set1 source or tooling to accommodate Crew.

## Acceptance and finish

1. Manager can use an approved development environment and start the existing documented development app. Record actual process/port/readiness and cleanup.
2. Manager delegates bounded implementation work to another persistent agent; worker reports progress/questions/results; manager can inspect/review and present the outcome. Use a disposable fixture for implementation changes.
3. Owner settings, usage, history, environment, browser and recovery flows work through their real interfaces. Preserve unavailable/external limits honestly.
4. Combine track PRs on feature branch; focus type/build and changed end-to-end flows. Exercise retained-state packaged Quit/reopen as well as empty first launch.
5. Reconcile every open issue by actual source/acceptance, supersession or documented remaining boundary. Do not close unimplemented work merely because a parent is merged.
6. Merge the integrated usable result into main and rebuild a separate test candidate with exact-source provenance. No automatic signed release or installed app replacement.

Progress and private operational evidence are recorded separately during execution.
