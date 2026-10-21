import type { WorkState, VoiceCatalog } from "../contracts/manager.js";
export const EMPTY_WORK: WorkState = {
  approvals: [],
  connectors: [],
  items: [],
  messages: [],
  status: "preparing",
};
export function chooseVoice(catalog: VoiceCatalog, saved?: string | null) {
  return (
    catalog.voices.find((voice) => voice.id === saved)?.id ??
    catalog.defaultVoice
  );
}
export function connectorVerificationURL(value?: string) {
  try {
    const url = new URL(value || "");
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
