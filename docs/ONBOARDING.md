# Crew setup

Crew guides the user through local tools, ChatGPT sign-in, the project, permissions and a summary. The manager and workers start only when explicitly requested; setup starts no microphone or business work. Existing ChatGPT authentication is used without API keys or credential-file reads.

## Project setup (AI-010)

Choose the local project folder and select **Set up this project**. Crew reads a bounded selection of code/documentation through the subscription-backed setup analysis, discovers actual Git branches and reads available Linear teams/projects through the configured Codex MCP connection. It validates and saves the resulting local settings and project-specific manager/worker instructions automatically. Previous settings and prompt files are retained by the save mechanism; cancellation or failed validation leaves saved settings unchanged.

The folder is canonicalized to its actual Git root and the repository name comes from that folder, rather than an invented AI label. An existing meaningful project name and stable repository ID are retained for the same folder. The starting branch is selected from actual Git refs, preferring the repository's recorded remote default; the user can choose another existing branch by name. No branch, path, team ID or project ID is invented. Project understanding omits draft/setup-review instructions; bounded source evidence is available in a collapsed section.

Linear setup uses supported direct MCP reads in a short-lived ephemeral context, with no model turn or manager-history ownership. It lists real recognizable team/project names and stores their actual IDs underneath. Existing matching team/key or a unique available team can be selected automatically. A project filter is selected only for an existing proven mapping or a unique exact name match within the selected team; otherwise all team tickets is the default. Multiple teams are a recognizable-name choice. Unavailable/partial access remains explicit, with retry and **Connect later**; discussion is available while ticketed worker dispatch remains blocked until the required team mapping exists. Catalog discovery alone is not proof of access: setup performs actual team/project reads, and the manager separately verifies the intended ticket before work.

Branch and Linear choices save when selected. Advanced settings contain optional technical IDs, state paths and instruction-file locations; ordinary onboarding does not require raw JSON, Git ref syntax, Markdown editing or mandatory review checkboxes. A changed folder cannot silently inherit an unrelated project's team/project mapping. Existing task/chat identity and state directories remain protected, and active work/voice blocks applying settings.

## Permissions and recovery

Microphone permission is requested only by the user's explicit action, without a recording stream or voice call. Granted, denied, restricted, not-determined and unknown remain distinct. **Not now** defers voice. File checks probe the configured folders/branches/instruction files and a temporary write in Crew's state folder. These checks do not prove a worker's sandbox or a whole application environment is ready. There is no artificial LAN probe or blanket Local Network permission promise.

Missing config/Codex and malformed JSON do not prevent setup from opening. Runtime/sign-in checks use public supported app-server methods and sanitized results. Unknown or denied connections show a recovery action rather than a false success. Summary distinguishes local configuration, actual Linear reads, microphone state and future ticket/environment validation.

New defaults use `~/Library/Application Support/Crew`; `--config` and `AI_MANAGER_CONFIG` stay supported. Stable bundle ID `local.voice.manager` remains for macOS identity continuity. See [storage migration](STORAGE.md). The app is local, one project per config/state/port. Crew supports concurrent workers within that project; another project uses a separate instance.
