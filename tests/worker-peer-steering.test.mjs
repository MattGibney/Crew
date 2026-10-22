// GH-50 native envelope evidence: reject != accepted-but-unconfirmed.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createWorkerPeer } from "../runtime/workers/worker-peer.mjs";
test("native rejection is definite, malformed acknowledgement is uncertain, and closed channels reject promptly", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "crew-steer-peer-")),
    binary = path.join(dir, "synthetic-peer.mjs");
  await writeFile(
    binary,
    `#!${process.execPath}
import {createInterface} from 'node:readline';
const lines=createInterface({input:process.stdin});lines.on('close',()=>process.exit(0));
for await(const line of lines){const m=JSON.parse(line);const rejected=m.params?.expectedTurnId==='rejected';process.stdout.write(JSON.stringify(rejected?{id:m.id,error:{code:-32600,message:'no active turn to steer'}}:{id:m.id,result:{turnId:0}})+'\\n');}
`,
    { mode: 0o700 },
  );
  const peer = await createWorkerPeer(
    {
      executable: binary,
      worktree: dir,
      mcpScript: "/disposable/not-invoked.mjs",
      stateDir: dir,
      taskId: "peer-fixture",
      runId: "peer-run",
    },
    { onSpawnError: () => {}, onChannelError: () => {} },
  );
  t.after(async () => {
    peer.worker.stdin.end();
    await peer.closed;
    peer.rejectPending();
    await rm(dir, { recursive: true, force: true });
  });
  peer.listen(
    async () => {},
    async () => {},
  );
  await assert.rejects(
    peer.rpc("turn/steer", { expectedTurnId: "rejected" }),
    (e) => e.nativeRejected === true,
  );
  await assert.rejects(
    peer.rpc("turn/steer", { expectedTurnId: "malformed" }),
    (e) => e.nativeRejected !== true && /identity/.test(e.message),
  );
  peer.worker.stdin.end();
  await peer.closed;
  peer.rejectPending();
  const started = Date.now();
  await assert.rejects(
    peer.rpc("turn/steer", { expectedTurnId: "closed" }),
    (e) => e.nativeNotSent === true && /channel is closed/.test(e.message),
  );
  assert.ok(Date.now() - started < 1000);
});
