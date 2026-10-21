export type PromptRole = "manager" | "worker";
export interface PromptSnapshot {
  text: string;
  version: string;
}
export interface PromptView extends PromptSnapshot {
  defaultText: string;
  isDefault: boolean;
}
export interface PromptSettingsView {
  projectId: string;
  revision: string;
  manager: PromptView;
  worker: PromptView;
}
export interface PromptSettings {
  read(): Promise<PromptSettingsView>;
  save(input: unknown): Promise<PromptSettingsView>;
  snapshot(role: PromptRole): Promise<PromptSnapshot>;
}
