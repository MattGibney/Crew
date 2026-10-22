import { parsePreparation } from "./store.mjs";
import type { ObservedPreparation } from "./coordinator.mjs";
import { record } from "../shared/errors.mjs";
/** Validate the latest public projection separately from its immutable source journal. */
export function parseObservedPreparation(input: unknown): ObservedPreparation {
  if (!record(input) || !Array.isArray(input.participants))
    throw new Error("Invalid preparation observation.");
  const extra = input.participants.map((value) => {
    if (
      !record(value) ||
      typeof value.settled !== "boolean" ||
      typeof value.settlementReason !== "string" ||
      value.settlementReason.length > 2000 ||
      (value.taskLabel !== undefined &&
        (typeof value.taskLabel !== "string" || value.taskLabel.length > 500))
    )
      throw new Error("Invalid participant settlement evidence.");
    const { settled, settlementReason, taskLabel, ...base } = value;
    return {
      base,
      settled,
      settlementReason,
      ...(taskLabel === undefined ? {} : { taskLabel }),
    };
  });
  const plan = parsePreparation({
    ...input,
    participants: extra.map((value) => value.base),
  });
  return {
    ...plan,
    participants: plan.participants.map((participant, index) => ({
      ...participant,
      settled: extra[index]!.settled,
      settlementReason: extra[index]!.settlementReason,
      ...("taskLabel" in extra[index]!
        ? { taskLabel: extra[index]!.taskLabel }
        : {}),
    })),
  };
}
