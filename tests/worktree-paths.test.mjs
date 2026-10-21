import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,symlink,realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {worktreeRoots,selectWorktreeRoot,ensureWorktreeRoot} from '../runtime/worktree-paths.mjs';
async function fixture(t){const dir=await mkdtemp(path.join(os.tmpdir(),'crew-checkout-paths-')),state=path.join(dir,'Application Support','Crew','state'),home=path.join(dir,'home');await mkdir(state,{recursive:true});await mkdir(home);t.after(()=>rm(dir,{recursive:true,force:true}));return{dir,state,home};}
test('space-containing private state selects stable no-space isolated namespace while state stays in place',async t=>{
 const f=await fixture(t),roots=await worktreeRoots(f.state,{home:f.home});assert.equal(/\s/.test(roots.preferred),false);assert.match(roots.preferred,/\.crew\/worktrees\/[a-f0-9]{24}$/);assert.equal(await selectWorktreeRoot(f.state,{}, {home:f.home}),roots.preferred);await ensureWorktreeRoot(f.state,roots.preferred,{home:f.home});assert.equal(await realpath(roots.preferred),roots.preferred);
 const other=path.join(f.dir,'Another State');await mkdir(other);assert.notEqual((await worktreeRoots(other,{home:f.home})).preferred,roots.preferred);
});
test('recorded legacy paths remain authoritative and home whitespace is not globally rejected',async t=>{
 const f=await fixture(t),legacy=path.join(f.state,'worktrees');await mkdir(legacy);assert.equal(await selectWorktreeRoot(f.state,{worktree:path.join(legacy,'existing-worker')},{home:f.home}),legacy);
 const spacedHome=path.join(f.dir,'Home With Spaces');await mkdir(spacedHome);assert.equal((await worktreeRoots(f.state,{home:spacedHome})).preferred,legacy);
});
test('foreign roots and compact namespace symlinks are refused before creating a checkout',async t=>{
 const f=await fixture(t);await assert.rejects(selectWorktreeRoot(f.state,{worktreeRoot:f.dir},{home:f.home}),/does not belong/);const roots=await worktreeRoots(f.state,{home:f.home});await symlink(f.dir,path.join(f.home,'.crew'));await assert.rejects(ensureWorktreeRoot(f.state,roots.preferred,{home:f.home}),/link|namespace|belong/);
});
