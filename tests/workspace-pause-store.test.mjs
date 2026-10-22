import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,access,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {writeWorkspacePauseJournal,readWorkspacePauseJournal,WORKSPACE_PAUSE_JOURNAL_BYTES} from '../runtime/desktop/workspace-pause-store.mjs';
const journal=()=>({schema:1,kind:'pause-update',consent:true,id:'bounded-group',purpose:'quit',fromVersion:'0.16.2',targetVersion:'0.16.2',phase:'blocked',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),captureComplete:false,projects:[],reasons:['Retain admission hold.']});
async function fixture(t){const directory=await mkdtemp(join(tmpdir(),'crew-pause-journal-bound-'));t.after(()=>rm(directory,{recursive:true,force:true}));return{directory,path:join(directory,'group.json')};}

test('overflowing grouped journal write preserves the prior recoverable hold and leaves no temporary files',async t=>{
 const f=await fixture(t),saved=journal();await writeWorkspacePauseJournal(f.path,saved);const original=await readFile(f.path);
 const oversized={...saved,reasons:['☃'.repeat(Math.floor(WORKSPACE_PAUSE_JOURNAL_BYTES/2))]};
 assert.ok(JSON.stringify(oversized).length<WORKSPACE_PAUSE_JOURNAL_BYTES,'fixture catches character-count guards');
 await assert.rejects(writeWorkspacePauseJournal(f.path,oversized),/byte bound|exceeds bound/);
 assert.deepEqual(await readFile(f.path),original);assert.equal((await readWorkspacePauseJournal(f.path)).phase,'blocked');
 assert.deepEqual(await readdir(f.directory),['group.json']);
 const absent=join(f.directory,'not-created','group.json');await assert.rejects(writeWorkspacePauseJournal(absent,oversized),/byte bound|exceeds bound/);await assert.rejects(access(join(f.directory,'not-created')),{code:'ENOENT'});
});

test('read and write accept the same exact byte limit, rejecting one extra UTF-8 byte without replacement',async t=>{
 const f=await fixture(t),saved=journal();saved.reasons=[''];
 const overhead=Buffer.byteLength(JSON.stringify(saved)+'\n');saved.reasons=['x'.repeat(WORKSPACE_PAUSE_JOURNAL_BYTES-overhead)];
 await writeWorkspacePauseJournal(f.path,saved);const bytes=await readFile(f.path);assert.equal(bytes.length,WORKSPACE_PAUSE_JOURNAL_BYTES);
 assert.deepEqual((await readWorkspacePauseJournal(f.path)).reasons,saved.reasons);
 saved.reasons[0]=saved.reasons[0].slice(0,-1)+'é';await assert.rejects(writeWorkspacePauseJournal(f.path,saved),/byte bound|exceeds bound/);assert.deepEqual(await readFile(f.path),bytes);
 await writeFile(f.path,JSON.stringify(saved)+'\n');await assert.rejects(readWorkspacePauseJournal(f.path),/exceeds bound/);assert.equal((await readFile(f.path)).length,WORKSPACE_PAUSE_JOURNAL_BYTES+1);
});
