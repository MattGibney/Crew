# Worker status and progress

Worker cards show one status explicitly set by the worker or manager. A worker that has not reported a status shows **Not reported**, regardless of its native execution state. Execution state, process liveness, timing and approval facts remain available in worker Overview. These facts do not determine the reported status.

Agents use the existing `local_orchestration.set_workflow_state` MCP tool:

```json
{
  "requestId": "implementation-estimate-2",
  "state": "Testing the revised approach",
  "progressPercent": 45
}
```

Workers are bound to their task/run; manager calls additionally require `taskId`. `state` remains the arbitrary project label supported by earlier Crew versions. `progressPercent` is optional and accepts finite numbers from 0 through 100, including decimals. Omit it to retain the previous estimate, or send `null` to clear it. Unreported progress stays unset. Estimates may increase or decrease as the worker learns. A percentage never completes a turn, sets workflow state automatically, grants permission or acknowledges update preparation. Status-only clients and historical records remain compatible.

Each update retains its actor, task/run/assignment identity, timestamp and history. Reuse `requestId` only for an exact retry. A retry with changed status or submitted progress is rejected. History distinguishes submitted progress from a retained estimate so retries remain exact after later updates. The UI refreshes through the existing project SSE stream and reloads the persisted value. Overview retains earlier estimates in workflow history.

The manager delegates the goal and constraints; the worker owns its execution plan and estimate. The fully editable default worker instructions suggest useful reports roughly every five to ten minutes during normal work and at meaningful changes. This guidance creates no timer, heartbeat, scheduled run or forced review. Users can replace both role prompts in Settings. Custom saved prompts and historical snapshots remain intact; only exact known pristine shipped defaults migrate. Manager changes still require explicit Start/Restart, and worker changes follow existing next-direction/launch semantics.

## Validation

`tests/worker-progress.test.mjs` exercises actual fresh-process MCP calls, persisted reads, shape validation, revised/cleared estimates, retries, stale runs, custom prompts and update-readiness independence. Existing prompt tests cover replacement, provenance and snapshots.

After `npm run build`, run the compiled browser acceptance with an installed Playwright module/browser when necessary:

```sh
node scripts/worker-progress-browser-acceptance.mjs
```

`CREW_PLAYWRIGHT_MODULE` and `CREW_BROWSER_EXECUTABLE` can select existing installations. The acceptance uses a real MCP process and persisted task, then passes its projection to the synthetic backend's SSE stream and real compiled renderer. It checks card/detail rendering, estimates, reload and editable prompt persistence. This is browser integration evidence, not live-provider or native installation acceptance. Screenshots are written outside Git in a disposable temporary directory. No physical media or real user worker is used.
