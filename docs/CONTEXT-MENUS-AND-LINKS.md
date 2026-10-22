# Text context menus and external links — GitHub #66

Ticket: <https://github.com/MattGibney/Crew/issues/66>.

## Behavior

Right-click selected read-only conversation text to Copy. A web link offers Copy link and Open in Safari on macOS; selecting text within a link retains both copy choices. Read-only content never offers Cut. Editable fields use native editing menus and retain ordinary keyboard shortcuts and drafts. ContextMenu or Shift+F10 opens supported text/link actions; Escape restores focus and selection. Native touch text selection stays browser-owned.

Manager, user and worker exchanges render Markdown and plain web URLs consistently through `WebLink`. On macOS, explicit web activation uses `/usr/bin/open` with separate `-a Safari` and URL arguments. This does not change system browser preferences. Other platforms use their default browser; an ordinary web preview labels its action Open in browser.

## Source reproduction and cause

The isolated unchanged `bfd1218` source equivalent (Crew 0.17.3) reproduced zero read-only context menus and zero user/manager-instruction anchors. Assistant Markdown/GFM already produced anchors, so the baseline does not establish that every assistant link was broken. User messages and manager instructions in worker history bypassed Markdown. Electron supplied no default field context menu, and the project window had no handler. Native popup forwarding accepted only HTTPS and delegated to the system default browser; HTTP links could not follow that path. Installed bundle metadata matched 0.17.3, but the installed app/profile was not used for reproduction.

`TextContextMenu` uses the Base UI/shadcn primitives and Crew's semantic tokens. It captures selection before menu focus changes. Editable/unsupported events skip the Base UI handler and stop propagation without preventing the native default: skipping only the handler still lets Base UI's document listener suppress native field menus. The Electron project window supplies standard native editing roles.

## Boundaries

The shared validator accepts bounded, explicit HTTP(S) URLs without credentials. Relative links and privileged/non-web schemes remain inert. Native forwarding retains trusted project-origin validation, blocks renderer takeover and denies popups. No process-launch IPC, native clipboard-read API, new permission, provider integration or microphone behavior is added.

## Validation and reproduction commands

Run `node scripts/issue66-isolated-validation.mjs` for a fresh build, the scheduling/preparation checks and full `npm test`. The wrapper removes inherited project config/port bindings, binds app data and capacity to a newly allocated disposable directory, and initializes that ledger through production `configureGlobalCapacity`. It verifies `globalAdmissionPaused` before and after initialization, records exact source hashes and preserves logs outside Git. Tests retain file concurrency two. It never reads or cleans the live ledger.

A configured but missing capacity ledger correctly fails closed. The earlier #66 run bound a fresh directory without initializing it: 749 tests passed and six scheduling/preparation tests canceled while waiting on bootstrap that admission correctly prevented. The same invalid environment reproduced the cancellations on the clean base. That comparison did **not** prove a product baseline failure; the earlier conclusion is superseded by the corrected isolation diagnosis. Original logs are retained in private task evidence.

For native behavior, build first, then run `scripts/context-links-native-acceptance.mjs` with `CREW_PLAYWRIGHT_MODULE` pointing to an available Playwright module. The existing successful isolated Electron run verified actual clipboard text/link copying; native field-menu availability and keyboard cut/copy/paste/undo/redo; selected-link choices; keyboard menus/focus; drafts including text typed during pending submission; actor link rendering; 540px/390px bounds; unsafe/foreign-origin rejection; and zero media calls. Real Safari requests were observed at distinct harmless local click, context-open and prevented-navigation endpoints. Crew's origin and the default-browser preference stayed unchanged. Screenshots remain outside Git.

This is compiled source-window native evidence with a synthetic backend. It does not establish signed-package, installed-profile, genuine provider-session or physical audio acceptance. The observed default was already Safari; no alternative system preference was installed for testing. The capacity-harness correction changes no product source and does not justify repeating native OS actions.

The corrected exact-source validation completed with build exit 0, focused scheduling/preparation **6/6 passing**, and full `npm test` **755/755 passing**, exit 0, with zero failures, cancellations or skips. No production code, assertion or test selection was changed for this correction. Private logs include the initial ledger and source-hash manifest; the prior failed-environment evidence remains preserved separately.
