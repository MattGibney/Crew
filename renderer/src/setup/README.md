# Setup renderer responsibilities

`App.tsx` owns the wizard shell, selected step and optional-microphone skip choice. Each step is a typed component: `WelcomeStep`, `LocalToolsStep`, `AccountStep`, `ProjectStep`, `PermissionsStep` and `ReadinessSummary`. `StorageRecovery` displays preserved-path recovery independently of step navigation. `ProjectSettings` owns project mapping/edit fields, and `useSetup` plus its focused hooks own configuration drafts, discovery, checks and bridge calls.

The extraction preserves existing step mounting, explicit operation buttons, draft state and native permission boundaries. Navigation runs no checks, starts no worker and opens no voice call. The microphone permission button remains explicit; automated acceptance uses the setup bridge fixture and synthetic media only.
