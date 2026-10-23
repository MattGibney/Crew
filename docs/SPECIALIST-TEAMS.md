# Specialist teams and worker delegation (#131)

A project can have several specialist agents: engineering, marketing, customer support or a personal assistant. The owner creates each agent with a name, editable instructions/personality, voice and group memberships. All use the same persistent runtime; manager and worker describe responsibilities and reporting relationships, not different classes of agent.

## Direct contact

Use **Talk to** to choose an agent. Its own native chat, composer draft, scratchpad, Sessions controls and browser become the selected context. Each profile retains its own voice. Selecting a contact starts no session, task or microphone. Start stopped agents explicitly; one voice call is supported at a time. Disconnect that call before changing contact. Other specialists and their workers can keep working independently.

Owner-created specialists report directly to the owner. Creating another specialist no longer makes it report to the first one. Existing saved reporting relationships and native thread identities are preserved. The old primary-agent identifier remains a compatibility fallback; the user is not required to choose one exclusive manager to use the team.

The worker panel lists direct reports of the selected agent. Agents settings retains the complete project team, including specialists without workers. Switching contact is not a reassignment, permission change or context-sharing mechanism.

## Groups and creation authority

A useful configuration is:

| Group | Typical membership | Authority |
| --- | --- | --- |
| Engineering workers | Engineering specialist and its workers | Engineering skills, shared GitHub/Linear identities, approved folders/tools and reporting |
| Marketing workers | Marketing specialist and its workers | Marketing skills, accounts and tools |
| Team coordination | Specialists allowed to delegate | Agent creation and retirement, session controls and other required coordination capabilities |

Group names and action choices are owner configurable. Memberships combine additively. The example is not a special built-in role or automatic grant. A worker group must not contain `agents.create` if it is intended for agent-created workers. Give the coordinating specialist that capability through a supplemental group instead.

Configure enabled worker creation presets in **Connections & access → New agent presets** with the appropriate worker groups. A creating agent can discover and use only presets satisfying both rules:

1. Every child group is already one of the creator's current groups.
2. No child group grants agent creation.

For example, an engineering specialist with Engineering workers + Team coordination can create a child with Engineering workers. It cannot select Marketing workers without also belonging to that group, or create a child carrying Team coordination's creation power. The owner can explicitly create another specialist with coordinating groups; the delegation restriction does not limit owner administration.

Crew filters `agent_creation_presets` for the caller and checks the same rules again when applying the preset in the access transaction. A later membership revocation or addition of creation power to a proposed child group can invalidate an earlier discovery result. Exact preset revisions, retained provisioning receipts and current group authority remain required. A failed provisioning record is retained honestly rather than silently granting access or duplicating a child.

This is an access boundary. The agent's editable instructions decide when to delegate, what objective to supply, how to supervise and when to reuse or retire workers. No fixed business workflow or automatic recursion is added. The owner can intentionally change memberships later; this change does not create a permanent separate worker type.

## Worker lifecycle

An eligible `agent_create` creates a stopped persistent child reporting to its creator. The coordinating agent starts and messages it using its granted Crew capabilities. The worker chooses its own execution plan and uses its current group-derived tools, skills, connections and environment.

`agent_archive` retires the caller's own current child: confirm native Stop, then archive. Failure or uncertain stopping retains a visible unarchived record. Chats, notes, job links and resources remain recorded; retirement does not delete files, clean shared environments or dispose worktrees. Managers cannot retire unrelated specialists or other agents' current children. The owner retains project-wide administration.

## Acceptance and boundaries

Use focused backend checks for eligible presets, owner creation, subset/creation-power rejection, revocation, changed grants, current reporting ownership, failed Stop and retained retirement. Use disposable renderer acceptance for specialist switching, histories/drafts, selected workers, voice-binding rejection, sessions, notes and browser selection. Physical audio and live provider actions require separate owner acceptance; synthetic voice-binding checks do not establish microphone/audio behavior.

No group voice call, automatic cross-agent shared memory, new credential inheritance, default permission grant or destructive cleanup is introduced. Saved custom prompts are preserved; the bundled guidance remains editable and applies through normal instruction refresh.


### Current implementation evidence

- Combined TypeScript checks and production runtime/renderer build passed.
- Eleven guided-setup checks passed, including creating an owner-facing peer while an existing primary fallback remains selected.
- Ten focused provisioning/access checks passed, covering filtered MCP choices, foreign-group and creation-power rejection, fresh revocation/group edits, owner creation, exact reporting ownership, Stop failures and retained archival.
- Disposable Chrome acceptance exercised multiple specialist histories, direct-report lists, separate drafts with localStorage unavailable, notes/session/browser selection, voice-binding rejection during an active call, narrow layout and zero implicit sends or microphone calls. The existing chronological typed/voice acceptance also passed against the updated renderer.
- Two real subscription-backed native sessions started idle in a disposable signed-in profile. Each selected chat retained its own thread; one specialist handled a typed scratchpad request, and the other created a worker from its allowed domain preset, received completion and retired it through real Crew tools. The child's retained native chat and notes remained readable after confirmed Stop and archive. Its attempt to read creation presets returned a sanitized tool error; backend checks independently established the authority rejection. Both specialist sessions stopped and the test app quit normally.

The physical microphone, acoustic voice behavior and live third-party accounts were not exercised. The owner’s running test profile, current chats, sign-in, installed app and project source were untouched by this acceptance. This delivery does not publish or install a build.
