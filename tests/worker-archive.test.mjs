import test from 'node:test';
import assert from 'node:assert/strict';
import {activeTasks,archivedTasks,archiveTime,isArchivedTask} from '../worker-archive.mjs';
import {attentionKeys} from '../attention-keys.mjs';

test('legacy disposal dates stay honest and archive lists order known times newest first without mutation',()=>{
 const tasks=[{id:'unknown',status:'removed',updatedAt:'2026-10-21T12:00:00Z'},{id:'older',status:'disposed',disposedAt:'2026-10-19T12:00:00Z'},{id:'newer',status:'disposed',archivedAt:'2026-10-20T12:00:00Z'},{id:'completed',status:'completed'},{id:'paused',status:'paused'},{id:'stopped',status:'stopped'}];
 assert.deepEqual(archivedTasks(tasks).map(t=>t.id),['newer','older','unknown']);
 assert.equal(archiveTime(tasks[0]),null);
 assert.deepEqual(activeTasks(tasks).map(t=>t.id),['completed','paused','stopped']);
 assert.equal(tasks[0].id,'unknown');
});

test('inconsistent disposal with live execution or unfinished lifecycle remains visible',()=>{
 for(const task of [{status:'disposed',execution:{live:true}},{status:'disposed',lifecycleRequests:[{status:'processing'}]},{status:'removed',lifecycleRequests:[{status:'pending'}]},{status:'stopped',archivedAt:'2026-10-20T12:00:00Z'}])assert.equal(isArchivedTask(task),false);
});

test('legacy removed worker approvals cannot raise attention after archive',()=>{
 const request={status:'pending',taskId:'legacy-worker',runId:'legacy-run',threadId:'thread',turnId:'turn',requestId:1};
 assert.deepEqual(attentionKeys({}, {tasks:[{id:'legacy-worker',runId:'legacy-run',status:'removed'}]},[request]),[]);
});

test('permanent delete refuses live, pending, and symlinked evidence while preserving other task records',async t=>{
 const fs=await import('node:fs/promises'),path=await import('node:path'),os=await import('node:os');const {createTask,updateTask,manageArchivedTask,readTask}=await import('../orchestration-store.mjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'crew-archive-records-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const project={id:'archive-test',mode:'repository'};
 const id='archive-safety-worker';await createTask(dir,{requestId:id,ticket:'GH-43',brief:'Safe record fixture',projectId:project.id});
 const perform=task=>manageArchivedTask(dir,{taskId:id,action:'delete',operationId:'safe-delete-operation',expectedRevision:task.revision},project);
 let task=await updateTask(dir,id,n=>{n.status='disposed';n.execution={live:true};});await assert.rejects(perform(task),/confirmed archived/);
 task=await updateTask(dir,id,n=>{n.execution.live=false;n.lifecycleRequests=[{id:'pending-action',action:'dispose',status:'pending',at:new Date().toISOString()}];});await assert.rejects(perform(task),/confirmed archived/);
 task=await updateTask(dir,id,n=>{n.lifecycleRequests[0].status='completed';n.harnessStarted=true;n.runId='17d56d1d-cd6a-4e11-aaf0-e1ea01b01875';n.runDir=path.join(dir,'runs',id,n.runId);});
 await assert.rejects(perform(task),/live or unverified/);
 task=await updateTask(dir,id,n=>{n.harnessStarted=false;delete n.runId;delete n.runDir;});
 const external=path.join(dir,'outside');await fs.mkdir(external);await fs.writeFile(path.join(external,'keep.txt'),'must survive');const runs=path.join(dir,'runs',id);await fs.mkdir(runs,{recursive:true});await fs.symlink(external,path.join(runs,'linked-evidence'));
 await assert.rejects(perform(task),/unsafe path/);assert.equal(await fs.readFile(path.join(external,'keep.txt'),'utf8'),'must survive');assert.equal((await readTask(dir,id)).status,'disposed');
 await fs.unlink(path.join(runs,'linked-evidence'));await createTask(dir,{requestId:'other-preserved-worker',ticket:'GH-43',brief:'Other task',projectId:project.id});await perform(task);assert.equal((await readTask(dir,'other-preserved-worker')).brief,'Other task');
});

test('an exact verified deletion journal completes after its terminal files were already removed',async t=>{
 const fs=await import('node:fs/promises'),path=await import('node:path'),os=await import('node:os');const {createTask,updateTask,manageArchivedTask}=await import('../orchestration-store.mjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'crew-archive-retry-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const project={id:'archive-retry',mode:'repository'};
 const task=await createTask(dir,{requestId:'partial-delete-worker',ticket:'GH-43',brief:'Partial deletion fixture',projectId:project.id});
 const archived=await updateTask(dir,task.id,n=>{n.status='disposed';n.harnessStarted=true;n.runId='17d56d1d-cd6a-4e11-aaf0-e1ea01b01875';n.runDir=path.join(dir,'runs',n.id,n.runId);});
 const input={taskId:task.id,action:'delete',operationId:'verified-delete-operation',expectedRevision:archived.revision};
 // The controller persisted this barrier after terminal verification and before
 // unlinking evidence; simulate a crash after that unlink but before task removal.
 const journalDir=path.join(dir,'archive-actions');await fs.mkdir(journalDir);await fs.writeFile(path.join(journalDir,`${task.id}.${input.operationId}.json`),JSON.stringify({...input,projectId:project.id,status:'deleting',validatedTerminal:true,at:new Date().toISOString()}));
 assert.equal((await manageArchivedTask(dir,input,project)).ok,true);await assert.rejects(fs.access(path.join(dir,'tasks',`${task.id}.json`)),{code:'ENOENT'});
 assert.equal((await manageArchivedTask(dir,input,project)).ok,true);
});
