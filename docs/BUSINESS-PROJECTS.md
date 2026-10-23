# Business projects and optional repositories (#127)

The current unified desktop already registers a business project without a Git repository or a legacy Crew config. No new creation API or fake repository is needed. The production **Add a project** flow sends authenticated desktop IPC `createProject({name,directory})`; `src/desktop/main.mts` passes those fields to `openUnifiedRegistry().create()` and opens the unified application.

`directory` is an existing owner-selected business workspace, not proof of a repository or permission to use its files. Registration canonicalizes it, rejects duplicate canonical folders (including aliases), and prevents overlap with Crew application storage. It generates a stable project UUID. Agent, group, connection, skill, environment, native-auth and chat state live under a separate private project state directory keyed by that UUID. Selecting or registering the workspace never runs its commands, initializes Git, writes a config into it, starts an agent, reads a subscription account or captures a microphone. Opening the production composition performs its ordinary native version/configuration verification using its private native home.

`startUnifiedApplication` receives the project ID, name and private state directory; it does not require a repository path, base branch or repository config. The owner can create persistent specialists from approved presets, configure groups and service identities, and store business reference metadata before adding any repository. Actual agent execution still requires explicit Start and the configured subscription/runtime. File access, service operations and public browsing retain their own explicit group authorities. Choosing a project folder alone grants none of them.

A project still needs an existing folder in this first pass. Folder-free creation and a richer business-resource setup experience remain UI/product follow-ups. Service metadata does not prove a service connection works: use the supported connection verification flow for real credentials and provider access. The project resource catalogue is metadata; repositories/working folders remain optional resources governed by environment policy.

## Legacy repository discovery

`src/desktop/project-options.mts` and `src/desktop/project-setup.mts` support the earlier repository-config discovery flow. Their Git-root/base-ref checks are correct for that specific operation. A non-Git folder failing `discoverRepository()` does not establish that unified business-project creation is unavailable. Do not remove those checks, silently initialize Git, or reinterpret discovery output as project-wide readiness.

Existing repository discovery retains canonical Git roots, existing branches/commits, separate tracking choices and unchanged project tooling. The current unified creation route and legacy repository discovery are distinct interfaces; documentation and acceptance evidence should identify which was exercised.

## Bounded acceptance

After building the intended runtime, run:

```sh
node scripts/business-project-acceptance.mjs
node --import tsx --test tests/project-options.test.mjs tests/project-setup.test.mjs
```

`CREW_BUSINESS_CODEX_BINARY` may select the trusted pinned native CLI. `CREW_BUSINESS_RUNTIME_ROOT` may select another already-built checkout’s absolute `runtime/` directory; the script prints the tested runtime path. It does not rebuild or operate that checkout’s live profile.

The disposable fixture uses the actual production registry and unified composition. It registers two ordinary non-Git business folders; creates a stopped specialist through the real owner/preset API; persists group and no-auth synthetic service metadata; opens the reference catalogue when present in the integrated #127 runtime; closes/reopens the applications; and checks stable identity, retained records, cross-project separation and unchanged business folders. All native homes/state are new private fixture directories. It performs no subscription/account read, sign-in, agent Start, model turn, physical media capture, customer command, credential encryption/decryption or external service verification.

Current evidence: all six business-fixture checks passed against the integrated #127 runtime, including durable reference metadata, and all twelve existing repository discovery/setup checks passed. The earlier pre-resource branch passed its five applicable business checks and explicitly reported the unavailable resource check. This establishes backend registration/composition/persistence, separate from signed-in model delivery and native owner visual acceptance. No product implementation change was needed to unlock non-Git registration.
