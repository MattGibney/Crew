# Project skills (#34 / #95)

Crew's Skills editor and permitted native agent tools use one project store. A skill is a native `SKILL.md` with optional UTF-8 supporting files. The skill describes a workflow; it never grants a permission, authenticates a service, installs a plugin, or starts work.

## Using skills

Create or edit a skill under Project settings → Skills. Start `SKILL.md` with YAML `name` and `description` fields between `---` lines, followed by the instructions. Names use 1–64 lowercase letters, digits, and single hyphens. Describe when the workflow should be used. Supporting text files may live under `scripts/`, `references/`, `assets/`, and `agents/`; only scripts can be marked executable. Binary resource uploads are not supported in this first editor.

Select the skill in the intended agent's profile. The next explicit Start or Restart uses the current selected revision. Saving does not restart an agent and does not replace instructions already loaded into its conversation. Each native session receives exact immutable revision paths, so an in-flight session retains its applied skill revision. The application must show pending-restart state by comparing desired and applied revisions. Explicit invocation uses the native `$skill-name` convention; implicit selection is a native model behavior, not a Crew promise.

Drafts remain in the mounted editor when switching skills or Settings pages. Refresh and external revision changes do not replace dirty drafts. If another editor or agent saved a newer revision, the UI preserves the draft and asks the owner to copy any changes they want to keep, then explicitly discard and reload. The server also rejects stale writes. Text typed while a save is pending remains an unsaved draft against the acknowledged saved revision.

## Backend and native integration

`src/skills/index.mts` exports `ProjectSkillStore`, `createProjectSkillAgentTools`, DTO types, validation limits, and `ProjectSkillError`.

```ts
const store = await ProjectSkillStore.open({
  directory: crewProjectSkillsDirectory,
  projectId,
  forbiddenRoots: [projectRepository, configuredPersonalCodexRoot],
});
await store.list();
await store.read(skillId);
await store.create({ markdown, resources });
await store.update({ skillId, expectedRevision, markdown, resources });
await store.resolve(skillId, revision); // { nativePath }, exact committed revision
const selected = await store.resolveSelected(configuration.skills);
// { extraRoots, skills: [{ id, revision, nativePath }] }
```

The store implements the canonical `ProjectSkillSource`. `directory` must be a dedicated private Crew directory outside repositories and personal Codex storage. The host must include actual configured custom personal native roots and the project repository in `forbiddenRoots`; the standard personal `.codex` and `.agents/skills` roots are always excluded. Opening a store with another project identity fails. No user configuration, personal native skill folder, or repository file is written.

`Skill.directoryRef` points to a native skill directory inside an immutable committed revision container. `resolve()` validates the exact revision's manifest and files and returns its `SKILL.md`; `resolveSelected()` additionally supplies the parent directories suitable for process-local native extra discovery roots. Pass only the selected revision containers to the project's dedicated native process, never the entire store. #88 owns calling supported native discovery hooks and checking their acknowledgement. Do not infer discovery or invocation success from these paths alone.

The native adapter should set process-local `skills/extraRoots/set`, refresh with `skills/list`, and verify exact selected paths before claiming discovery. Unsupported methods or missing selected paths must fail visibly. Crew does not persist native configuration or link/copy these skills into another discovery scope. A restarted session can select new revision paths; existing native conversation context remains native-owned and is not retroactively edited. The official [native skills format](https://learn.chatgpt.com/docs/build-skills) and [app-server skill methods](https://learn.chatgpt.com/docs/app-server) define the native behavior.

## Authenticated authoring

The tool factory binds a trusted caller supplied by authenticated transport:

```ts
createProjectSkillAgentTools({
  store,
  caller,
  runAuthorized: async (boundCaller, action, operation) => {
    // Composition checks current session, project, skills.read/write and its
    // shared execution barrier; keep admission held until operation settles.
    return runThroughSharedAdmission(boundCaller, action, operation);
  },
});
```

Its catalogue contains `skills_list`, `skill_read`, `skill_create`, and `skill_update`. Every invocation goes through the injected current authorization/admission boundary. Arguments cannot set the caller or project. Read operations require `skills.read`; create/update require `skills.write`. Skill assignment remains the foundation's separate `skills.assign` operation. The factory itself neither administers groups nor implements a competing execution gate. Register it only in the authenticated session MCP host.

Omitting `resources` during update retains existing resources; supplying the array replaces them. Expected revisions are mandatory for updates. The owner HTTP adapter must authenticate the owner before calling store methods and preserve safe typed error codes for the editor. Unexpected exception text must not be forwarded. Use the existing application change stream to invalidate the skills panel; `subscribe()` on the store reports same-process commits, and the panel also refreshes on opening and explicit Refresh.

## Storage and recovery boundaries

All text is size-bounded: 128 KiB `SKILL.md`, 16 KiB YAML metadata, up to 64 resources at 256 KiB each, 2 MiB total per revision. A project supports 500 current skills and 10,000 retained revisions. Full YAML parsing rejects duplicate fields and unsafe/custom tags; native `name`/`description` validation is mandatory. Paths reject absolute/parent/hidden entries, collisions, nested `SKILL.md`, symlinks, and hardlinked files. The resolver verifies file hashes and rejects unrecorded files before exposing a revision to native discovery.

A private cross-process write lock serializes saves. Each completed revision is fsynced before the current index is atomically replaced. Old revisions remain readable for already-applied sessions. A failed write can retain an unreferenced partial revision; it is never returned by the current catalogue or resolver. There is no automatic pruning or destructive recovery. A missing index in a nonempty store, foreign project identity, changed root, modified revision, or retained write lock produces a bounded error. Owner recovery must first verify that no writer is active and preserve evidence; age alone does not authorize deleting a lock.

These file checks prevent accidental/path-based cross-project writes and detect modified discovery content. They do not establish protection against a hostile same-user process swapping filesystem ancestors during I/O, nor replace #89's native process containment. Skill text and resources must be read-only in the admitted native filesystem scope; saving runs through the Crew tools/owner API.

## Focused validation

Typecheck passed with the real shared interfaces. A disposable functional flow exercised two store instances racing an update (one commit, one revision conflict), retained resource content, exact old-revision resolution after editing, UI/store-compatible MCP readback, injected permission denial, rejection of duplicate YAML/name, traversal and file/directory collisions, foreign project and repository-root rejection, and symlink substitution without outside-content access or mutation. The temporary state was removed.

A separate private browser harness rendered the actual panel and existing Crew theme against the real store. It exercised UI create/resource-save/readback, dirty-draft retention across Settings navigation, external-update conflict presentation, explicit discard/reload, and text typed during a delayed save. The store held the submitted version while the newer typing remained an unsaved editor draft. The existing dismissible Settings toast and flat row/editor layout were visually inspected. The harness used disposable state and no model, provider, microphone, or installed app; its screenshot remains outside Git.

These focused checks do not establish real model invocation, native discovery isolation, physical microphone behavior, or packaged lifecycle acceptance. Those require the final composed application and are reported separately by #95/#88.
