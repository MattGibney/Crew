// AI-018: update pauses use cooperative interruption only, never force escalation.
import { snapshotProcesses } from './process-ownership.mjs';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function waitOwnedNatural(tree, { interrupt = false, onBlocked = async () => {}, isSuperseded = () => false } = {}) {
 try {
 if (!tree) return { confirmed:false, remaining:[], tracked:[], reason:'Process ownership was unavailable.' };
 await tree.capture();
 if (!tree.rootIdentity) return { confirmed:false, remaining:[], tracked:[...tree.records.values()], reason:'Process ownership was unavailable.' };
 if (interrupt) {
  const row = (await snapshotProcesses()).get(tree.rootPid), expected = tree.rootIdentity;
  if (row && !row.state?.includes('Z')) {
   if (row.start !== expected.start || row.commandHash !== expected.commandHash) return { confirmed:false, remaining:await tree.remaining(), tracked:[...tree.records.values()], reason:'Process identity changed before cooperative interruption.' };
   try { process.kill(tree.rootPid, 'SIGINT'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
 }
 const deadline = Date.now() + 15000; let notified = false;
 for (;;) {
  await tree.capture(); const remaining = await tree.remaining();
  if (!remaining.length) return { confirmed:true, remaining:[], tracked:[...tree.records.values()] };
  if (isSuperseded()) return { confirmed:false, remaining, tracked:[...tree.records.values()], reason:'Explicit manual stop superseded cooperative observation.' };
  if (!notified && Date.now() >= deadline) { notified = true; await onBlocked({ confirmed:false, remaining, reason:'Cooperative shutdown is still pending. No force signal was sent.' }); }
  await delay(100);
 }
 } catch { return { confirmed:false, remaining:[], tracked:tree?[...tree.records.values()]:[], reason:'Cooperative ownership observation failed. No force signal was sent.' }; }
}
