// Disposable per-test-process capacity isolation. No live ledger reads or cleanup.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureGlobalCapacity } from "../runtime/orchestration/capacity.mjs";
delete process.env.AI_MANAGER_CONFIG;
delete process.env.AI_MANAGER_PORT;
delete process.env.VOICE_PORT;
process.env.CREW_GLOBAL_CAPACITY_DIR = mkdtempSync(
  join(tmpdir(), "crew-refresh-test-capacity-"),
);
// A configured missing ledger intentionally blocks admission. Initialize this
// fresh fixture through the real API before importing any test modules.
await configureGlobalCapacity({ dir: process.env.CREW_GLOBAL_CAPACITY_DIR });
