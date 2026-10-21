import { readFile, writeFile, rename } from 'node:fs/promises';
import { record, errorCode } from '../shared/errors.mjs';
export async function readThreadReference(statePath:string) {
  let threadId:string|undefined, recoveredJournalSource:string|null = null;
  try {
    const reference:unknown = JSON.parse(await readFile(statePath,'utf8'));
    if(!record(reference)) throw new Error('Invalid saved chat reference.');
    threadId = typeof reference.threadId === 'string' ? reference.threadId : undefined;
    if(!threadId || !/^[\w-]+$/.test(threadId)) throw new Error('Invalid saved chat ID.');
    if(reference.reason === 'saved_chat_writer_conflict' && typeof reference.previousThreadId === 'string' && /^[\w-]+$/.test(reference.previousThreadId) && reference.previousThreadId !== threadId && typeof reference.recoveredAt === 'string' && Number.isFinite(Date.parse(reference.recoveredAt))) {
      const sourceId = reference.journalSourceThreadId ?? reference.previousThreadId;
      if(typeof sourceId === 'string' && /^[\w-]+$/.test(sourceId) && sourceId !== threadId) recoveredJournalSource = sourceId;
    }
  } catch(error) {
    if(errorCode(error) !== 'ENOENT') throw new Error('Cannot read the saved chat reference. It has not been replaced.');
  }
  return {threadId,recoveredJournalSource};
}
export async function writeThreadReference(statePath:string,reference:{threadId:string; previousThreadId?:string; journalSourceThreadId?:string; recoveredAt?:string; reason?:string}) {
  await writeFile(`${statePath}.tmp`,JSON.stringify(reference)+'\n',{mode:0o600});
  await rename(`${statePath}.tmp`,statePath);
}
export async function journalSource(statePath:string, previousThreadId:string, recoveredJournalSource:string|null) {
  let source = recoveredJournalSource || previousThreadId;
  try {
    const journal:unknown = JSON.parse(await readFile(`${statePath}.conversation.json`,'utf8'));
    if(record(journal) && typeof journal.threadId === 'string' && (journal.threadId === previousThreadId || journal.threadId === recoveredJournalSource)) source = journal.threadId;
  } catch { /* History hydration reports unreadable overlay without replacing it. */ }
  return source;
}
