import type {
  VoiceCatalog,
  ManagerProfile,
  StorageLike,
} from "../contracts/manager.js";
import { chooseVoice } from "./state.js";

// The old voice preference lived in each project's Chromium partition. Migrate it
// once; an explicitly saved profile (including Codex default) is authoritative.
export async function resolveManagerVoice({
  catalog,
  profile,
  storage,
  save,
}: {
  catalog: VoiceCatalog;
  profile?: ManagerProfile;
  storage?: StorageLike;
  save: (input: {
    voice: string;
    expectedVersion: string;
  }) => Promise<ManagerProfile>;
}) {
  let current = profile;
  if (current?.configured === false) {
    const keys = ["crew.voice.v3", "relay.voice.v3", "ai-manager.voice.v3"];
    let legacy;
    try {
      legacy = keys.map((key) => storage?.getItem(key)).find(Boolean);
    } catch {
      /* Storage may be disabled. */
    }
    if (legacy && catalog.voices.some((voice) => voice.id === legacy)) {
      current = await save({ voice: legacy, expectedVersion: current.version });
      try {
        for (const key of keys) storage?.removeItem(key);
      } catch {
        /* Saved profile already owns the choice. */
      }
    }
  }
  const saved = current?.voice,
    selected = chooseVoice(catalog, saved);
  return {
    profile: current,
    selected,
    unavailable: Boolean(saved && saved !== selected),
  };
}
