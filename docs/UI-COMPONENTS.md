# UI components (#137)

Crew uses the official shadcn/ui **Base UI / Nova** registry, configured in `components.json`. Install components using the project's shadcn CLI, then import their generated exports from `@/components/ui`. Do not recreate a component from a screenshot or substitute a hand-written wrapper around the underlying primitive.

## Audit and replacements

| Area                                                        | Previous implementation                                  | Current components                                                                               |
| ----------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Agent archive and permanent delete                          | Custom dialog/inline confirmation                        | AlertDialog, small destructive composition                                                       |
| Agent row and text context menus                            | Hand-written Base UI wrappers                            | Installed DropdownMenu and ContextMenu                                                           |
| Agent lists, worker details, text/voice input, browser tabs | Custom roles, selection and keyboard logic               | Tabs, TabsList, TabsTrigger, TabsContent                                                         |
| Agent and archived worker tables; Markdown tables           | Native table markup                                      | Table and its installed parts                                                                    |
| Access/setup/service/schedule controls                      | Native checkboxes and radios                             | Checkbox and RadioGroup                                                                          |
| Expandable evidence, settings and setup sections            | Native details/summary                                   | Collapsible, Trigger and Content                                                                 |
| Project selector                                            | Native details with manual outside-click/Escape handling | Popover                                                                                          |
| Update downloads                                            | Native progress                                          | Progress                                                                                         |
| Agent identity and team cards                               | Custom image/fallback and card container                 | Avatar and Card                                                                                  |
| Settings/application confirmations                          | Custom floating notification                             | Sonner and one Toaster per app root                                                              |
| Shared basic controls                                       | Previously copied/modified registry files                | Freshly installed Button, Badge, Card, Input, Label, Textarea, NativeSelect, Separator and Alert |

The official files were installed with `npx shadcn add ... --yes --overwrite`, using the configured `base-nova` registry. Sonner's registry installation also adds its supported `sonner` and `next-themes` dependencies. Generated component files retain the registry's APIs and styles; product layout and domain behavior remain in application components.

## Composition boundaries

- Existing access checks, owner commands, drafts, native chat history and runtime actions remain authoritative. Presentation changes do not grant access or launch agents.
- Inactive voice/text and worker panels stay mounted where needed. The voice runtime remains outside the tabs; its visible controls can move between the voice panel and compact text-mode controls. Navigation never connects a microphone.
- Collapsed sections use `keepMounted` where native details previously retained form fields or evidence. The component owns accessibility, focus and expansion behavior.
- Archive is reversible and retains history. Permanent deletion remains available only in Archived agents, with explicit confirmation and its existing owner operation.
- Ordinary document structure, browser page previews, app navigation, links and domain-specific layouts remain application code. Native select/table elements occur inside their installed shadcn components, not competing application implementations.

## Verification

Typecheck and production build, plus disposable preview checks for team/worker lists, keyboard tabs, archive cancellation, editing and saved setup, radios/checkboxes, expandable work evidence, project switching and empty onboarding, text draft retention across voice/text tabs, and browser tab selection. Permanent-delete cancellation and confirmation were checked against fictional preview records only. These checks do not establish physical microphone, provider or installed desktop acceptance.

## Shared product components

`OnlineStatus` in `renderer/src/components/online-status.tsx` displays an Online/Offline label with the shared dot and 16px halo. Pass an `online` boolean; standard span props such as `title` and `className` are supported. Callers own runtime-specific availability mapping. This is a product indicator, not a recreated shadcn registry component.
