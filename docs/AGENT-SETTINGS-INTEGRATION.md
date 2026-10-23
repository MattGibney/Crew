# Consolidated agent settings (#109, #52)

The desktop presentation exposes **Agents**, one table and the existing durable
guided create/edit flow. Manager selection changes a project role; it does not
copy a profile, voice, permissions or chat. The previous Manager profile editor,
worker-detail profile editor, project voice page and duplicate access-assignment
editor are removed from the desktop. Shared group, connection and workspace
administration remain separate authorities.

Profiles include an optional `voice: string | null`. Missing is a legacy record;
explicit null means the native default. The setup draft carries name, picture,
personality, instructions, voice and skill selections for creation and editing.
Existing runtime references are retained. This version supports the configured
isolated Codex/ChatGPT subscription binding; it does not offer speculative model
or authentication providers.

Existing-agent edits never change the manager selection. This prevents reopening
an old manager's draft from silently restoring its former role after the owner
selects another manager. The first created agent can establish the retained compatibility fallback; later
role changes use the table's revision-checked selector.

`setup.open` resumes a retained draft for the exact create/edit target, preserving
its original profile and assignment baselines. The intent journal is private,
bounded and revision checked. Switching agents preserves their drafts. Explicit
discard/reload uses `setup.new`. A partially applied setup must be reconciled
before switching. Access remains in groups and assignments, and profile saves use
the existing revision-checked owner operation. Saving starts no model turn.

## Root-owned desktop wiring

The integration track owns `src/desktop/main.mts`. The small adapter is
`src/application/agent-configuration.mts`:

1. After `startUnifiedApplication`, create
   `const configuration = createAgentConfiguration(composed)`.
2. Call `configuration.migrateLegacyVoice(legacyProjectVoice, () =>
   registry.retireLegacyVoice(project.id))`. This moves a legacy project choice
   only onto its current primary agent when that agent's voice field is absent.
   An explicitly saved agent voice or explicit null wins. No primary means the
   unused compatibility value remains for later reconciliation. A failed save
   never retires it.
3. Keep `configuration` on the project host. Replace the registry voice callback
   with `createVoiceOwnerCommands(voice, configuration.selectedVoice)`.
4. Route `agents.options` with empty arguments to `configuration.options()`.
   Remove the old `voice.select` registry mutation route; profile saving owns it.

The voice callback receives the exact `RuntimeBinding` and reads that agent's
saved profile. A stale UI voice cannot override a different saved agent choice
at Connect. Available native voices are read from an already started session;
settings never start one to populate a dropdown. Before a catalogue is available,
the owner can retain a saved voice or use the native default.

## Subscription usage boundary

The native runtime track owns reading `account/rateLimits/read` and listening to
native updates. Consume the sanitized shared projection in
`src/application/subscription-usage-contracts.mts`; do not add another account
connection or read credentials.

- Create `usage = createSubscriptionUsageOwnerAdapter(composed.subscription)`
  from `src/application/subscription-usage.mts` once per project host. It consumes
  the native track's exact `NativeUsageSnapshot` from `src/agents/codex-usage.mts`;
  there is no competing account payload or reader.
- Desktop command `subscription.usage {}` returns `usage.read()` as
  `SubscriptionUsageState`. Subscribe once with `usage.subscribe` to forward the
  complete state event below, and call `usage.dispose()` during host cleanup.
- Optional desktop event `{type: "subscription-usage", projectId, state}` carries
  a complete sanitized projection. Merge sparse native updates or refetch before
  publishing it; the renderer does not merge raw native responses.
- The **Subscription & usage** page reuses existing sign-in and adds the usage
  panel. It reads on opening and manual refresh, with no per-agent polling.
- Allowance is account-wide. Missing windows/reset details remain unavailable;
  stale successful data survives read errors. Remaining percentage is clamped
  `100 - used`. No token estimates, monetary balances or reset-consumption action
  exist in this view.

## Acceptance record

- Typecheck and the runtime/renderer build passed. Sixteen focused checks cover
  setup recovery, retained drafts/profile baselines, role selection, legacy voice
  migration, exact voice attribution and usage read/update/disposal boundaries.
- A compiled browser fixture used the actual desktop settings presentation,
  setup component and durable coordinator, with isolated synthetic owner/access
  ports and a controlled native catalogue. It edited name/personality/instructions,
  skill selection and voice; switched to a second draft and resumed the first;
  saved the selected profile; changed manager through the table; and created a
  stopped third agent through the same editor.
- Fixture readback confirmed both retained chat references and the second agent's
  saved profile were preserved. No lifecycle, sign-in, voice or execution command
  was sent by the flow. This is controlled UI/coordinator evidence, not a native
  model or call test.
- The usage view displayed returned window durations and local reset times,
  correct used/remaining percentages, authoritative reset count and an expired
  detail row. A partial response displayed unavailable fields; an error retained
  the successful snapshot with a stale label. The native usage reader is the
  separate runtime track's implementation at `b2e723e`, retained in this branch.

Private screenshots and disposable fixture data stay outside Git. Root integration
must wire the adapters above before combined native acceptance. Actual voice
catalogue/call adoption, retained-project migration and real account display parity
still require that combined application check.

## Environment-template selector (#108)

The agent identity/runtime step embeds the project catalogue selector. Root
forwards `environments.templates.snapshot {}` to
`composed.environmentOwnerApi.templates.snapshot()` and
`environments.templates.assign <input>` to its canonical `.assign(input)`.
`src/application/agent-template-contracts.mts` defines only the presentation subset
of #115's existing catalogue snapshot and exact assignment input. Template
definitions and assignments remain owned by that catalogue.

Template assignment has a separate explicit **Save template** action in the
editor. It is not part of the profile save transaction. Its selected immutable
revision, existing pin, conflicts and unconfirmed save are retained honestly;
Cancel restores the saved assignment. Loading/saving never inspect tools,
prepare an environment or install packages. A new agent must first be saved,
then reopened to receive a template. Pending template choices survive recent
agent switching in bounded project-scoped memory, rather than being promised
as a durable draft across app shutdown.

## Specialist teams (#131)

Agent setup no longer requires an exclusive manager choice. New owner-created specialists report directly to the owner. The saved current-contact selection switches text, voice, notes, sessions and browser context without changing reporting relationships or starting work. Existing primary IDs remain compatible fallback values. Saved profile edits and retained native chats keep their existing semantics. See [specialist teams](SPECIALIST-TEAMS.md).
