// Native catalog IDs are authoritative; display names and aliases are not selectors.
import { isRecord } from "./execution/errors.mjs";
export type ModelCatalogRpc = (
  method: string,
  params: { limit: number; cursor?: string },
) => Promise<unknown>;
export async function requireWorkerModel(rpc: ModelCatalogRpc, model: string) {
  let cursor: string | null = null;
  const seen = new Set();
  for (let page = 0; page < 20; page++) {
    const result = await rpc("model/list", {
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    if (!isRecord(result) || !Array.isArray(result.data))
      throw new Error(
        "Native model catalog is unavailable; retained work can be resumed after provider recovery.",
      );
    if (result.data.some((entry) => isRecord(entry) && entry.model === model))
      return model;
    const next = result.nextCursor;
    if (next == null)
      throw new Error(
        "Requested model is unavailable in the native model catalog. No fallback or new worker turn was started. Choose an available exact model ID.",
      );
    if (typeof next !== "string" || !next || seen.has(next))
      throw new Error(
        "Native model catalog pagination is invalid; no model was substituted.",
      );
    seen.add(next);
    cursor = next;
  }
  throw new Error(
    "Native model catalog exceeded its bounded page limit; no model was substituted.",
  );
}
