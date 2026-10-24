# Crew browser UI preview (#135)

Run `npm run ui:preview`, then open **http://127.0.0.1:4451** in the Codex browser. Use its annotation controls to mark changes on the rendered app. Set `CREW_PREVIEW_PORT` for a different port. The terminal process must remain running; Ctrl-C stops it. Vite hot reload updates the current React components and canonical theme as you edit them.

The top preview strip switches between two independent projects:

- **Populated project:** a fictional specialist team and workers, ongoing/blocked/review/completed work, chats, scratchpads, groups, service connection instances, skills, schedules, environment templates, usage examples and archived agents.
- **Empty project:** no configured agents, jobs, groups, connections or skills, showing the real onboarding and empty states. You can experiment with the setup flow using sample choices.

The app’s project selector also switches between them. Local actions change only in-memory sample data. **Reset sample data** restores both project datasets and clears preview form state. Reload also restores the samples. Nothing is saved to the installed app or its profiles.

The populated project opens on the **Team members** card grid. Select a specialist to open its chat and workers; use **Team members** to return. The empty project retains first-agent onboarding. This navigation is the actual app component and will carry into desktop builds.

This uses the current `DesktopApplication`, `AgentsApp`, setup and Settings components, not the former manager UI. The developer entry and synthetic bridge are strict TypeScript and included in typechecking. The preview entry is injected only by the development server; production Vite entries do not import it, and sample data is not bundled into the packaged app.

## Boundaries

All values and activity are fictional. Sending messages produces simulated local responses; session, group, archive and settings actions affect only the sample model. Service accounts, allowance numbers and ticket references are examples. Unsupported native operations explain that they are unavailable in preview. Native embedded page content is represented by a synthetic page inside the actual browser controls.

The server runs on loopback, imports no controller/runtime/auth/profile code and proxies no live API. It denies API routes and physical microphone/camera/geolocation access; CSP blocks remote connections and media. The preview never starts Codex, downloads updates, executes commands, signs in to a provider, reads the user’s test profile, or makes external changes. Production desktop behaviour still needs verification in Crew after the design pass.
