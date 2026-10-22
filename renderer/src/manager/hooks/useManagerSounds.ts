import { useEffect, useRef, useState } from "react";
import { createSounds } from "../sounds.js";
import { createAttentionSounds } from "../attention-sounds.js";
import type {
  WorkState,
  OrchestrationState,
  WorkerApproval,
  ProjectInfo,
} from "../../contracts/manager.js";

export function useManagerSounds(
  work: WorkState,
  orchestration: OrchestrationState,
  workerApprovals: WorkerApproval[],
  projectInfo: ProjectInfo | null,
) {
  const nativeAttentionSound = useRef<boolean | null>(null);
  const [soundUnavailable, setSoundUnavailable] = useState(false);
  const soundRef = useRef<ReturnType<typeof createSounds> | null>(null);
  if (!soundRef.current)
    soundRef.current = createSounds({ onUnavailable: setSoundUnavailable });
  const sounds = soundRef.current;
  const attentionRef = useRef<ReturnType<typeof createAttentionSounds> | null>(
    null,
  );
  if (!attentionRef.current) {
    let storage;
    try {
      storage = window.localStorage;
    } catch {
      /* In-memory dedup. */
    }
    attentionRef.current = createAttentionSounds(
      (kind) => sounds.play(kind),
      storage,
    );
  }
  useEffect(() => {
    const unlock = () => sounds.unlock();
    window.addEventListener("pointerdown", unlock, true);
    window.addEventListener("keydown", unlock, true);
    return () => {
      window.removeEventListener("pointerdown", unlock, true);
      window.removeEventListener("keydown", unlock, true);
      sounds.dispose();
    };
  }, [sounds]);
  useEffect(() => {
    if (nativeAttentionSound.current === false)
      attentionRef.current!(work, orchestration, workerApprovals);
  }, [work, orchestration, workerApprovals, projectInfo]);
  return { sounds, soundUnavailable, nativeAttentionSound };
}
