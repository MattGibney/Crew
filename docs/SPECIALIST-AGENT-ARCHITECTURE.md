# Specialist agents: project resources and direct contact (#127)

A project represents a business/product. It can contain repositories and working folders, service connections, documentation, marketing/deployment references and project-owned skills. A repository is a resource, not an agent type. Marketing, engineering, support and personal-assistant agents use the same persistent runtime; their editable profiles, group memberships, skills and environment templates define their specialisms.

## Direct text and voice contact

`ProjectAgentSettings.primaryAgentId` remains the default coordinating agent. Optional `contactAgentId` selects the existing specialist the owner currently talks to. Null/absent falls back to the primary. The authenticated owner command `setContactAgent({agentId,expectedRevision})` persists this selection through the same foundation writer and admission gate. The compatibility UI offers **Talk to** above the existing chat.

Selection never starts/stops a native session, sends a message, connects a microphone, changes reporting relationships or reassigns jobs. Each agent retains its own native thread, scratchpad and profile voice. The selected agent is the sole public voice binding; an existing live voice session must be disconnected before selection changes. Native promotion still requires the exact agent/session/thread and preserves private-turn boundaries. Concurrent group calls and cross-agent shared memory are not implemented here.

Stopped specialists can be selected without consuming model allowance; start them explicitly when needed. Starting an idle session is not a model task. Changing the selected contact does not change the primary manager role. Specialist delegation remains controlled by existing creation permissions and owner-approved presets.

## Shared project resources

`ProjectResourceCatalogue` stores project-owned, nonsecret HTTP(S) reference metadata under the private project state directory. It uses revision-checked writes and retains archived records. It is owned by the foundation writer lease. References may describe documentation, marketing, deployment or other shared assets. Credentials belong in service connections, never in names, descriptions or URLs.

The catalogue projection also includes approved working folders and service identities from their existing stores. It does not copy credentials, filesystem contents, service records or execution policy. Those existing stores remain authoritative. A reference is a discovery aid, not permission to fetch its URL, read files or execute an operation.

Owner commands:

- `resources.list({})`: all current project resource metadata.
- `resources.saveReference({id?,expectedRevision,name,category,description,url,archived?})`: create/update/archive a shared nonsecret link. Categories are `documentation`, `marketing`, `deployment`, `other`. A new record uses `expectedRevision:null`; edits use its exact revision.

Runtime tools:

- `project_resources({})`: discover resources currently available through assigned groups.
- `project_resource_read({resourceId})`: read metadata for one currently available resource.

Both require group capability `resources.read` and the exact active agent session. Reference visibility uses group `grants.resourceIds`. Working-folder visibility uses the group's canonical `environmentPolicyIds`; service visibility uses its nonempty `services` operation grants. There is no second resource allowlist for those executable resources. Fresh membership is checked on every call. The gateway and environment tools separately authorize actual operations; seeing metadata is not evidence that an operation ran successfully.

## Agent operating guidance

The following is suggested guidance for editable project profiles or skills, not a hidden mandatory workflow:

1. Read the assigned objective and choose an approach appropriate to your specialism.
2. Discover project resources through `project_resources` when available. Use approved environment tools for working files and gateway tools for service operations.
3. Inspect your assigned environment template before environment-dependent work. Reconcile template changes explicitly at a suitable stopping point; keep continuation notes when changing tooling.
4. Use only the skills and connections currently available through your groups. Ask your reporting manager for missing capability, identity or clarification instead of claiming an unavailable tool was used.
5. Update your scratchpad, status and progress with your own assessment. Delegate only through an approved creation preset and granted capabilities.

Crew records and routes these actions; it does not choose the agent's delivery workflow. Existing project development commands and instructions remain authoritative. Model subscription sign-in is separate from service identities. A shared external account still records the requesting agent in Crew's operation history.

## Validation and limits

The bounded specialist-foundation acceptance script uses real disposable foundation/resource stores and the actual selection and tool code. It verifies owner/revision checks, no runtime work on selection, voice-binding identity, chat preservation and durable reopen, resource visibility and immediate membership/capability removal. It never opens the owner's live profile or physical microphone. Combined native UI/model acceptance is recorded separately in the delivery PR.

The reference authoring API and group resource IDs are the architecture interface; a dedicated resource-management UI is deferred. A resource reference does not provision infrastructure or install a tool. An environment context is not a separate virtual computer or hostile-code isolation boundary. Authentication, provider features and environment-preparation limitations must be read alongside the relevant gateway/environment documentation.
