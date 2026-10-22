// GH-50 opt-in acceptance: actual subscription Codex, disposable repo/state only.
// Usage: node scripts/worker-followup-native-acceptance.mjs /absolute/path/to/codex [--continue /private/evidence/dir]
// Normal native approvals remain intact; pending approval ends this bounded probe.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,realpath} from 'node:fs/promises';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createController} from '../runtime/workers/controller.mjs';
import {createTask,readTask,currentAssignment,requestWorkerAction} from '../runtime/orchestration/store.mjs';
import {listWorkerRequests} from '../runtime/workers/approval-store.mjs';

const executable=process.argv[2];
if(!executable||!path.isAbsolute(executable))throw Error('Supply an absolute installed Codex executable path.');
const exec=promisify(execFile),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const continuationDir=process.argv[3]==='--continue'?process.argv[4]:null;
const sourceDir=fileURLToPath(new URL('../runtime/',import.meta.url)),dir=continuationDir?await realpath(continuationDir):await realpath(await mkdtemp(path.join(tmpdir(),'crew-gh50-native-'))),repo=path.join(dir,'repo'),stateDir=path.join(dir,'state'),taskId='native-retained-worker';
console.log(JSON.stringify({event:'fixture-created',evidenceDir:dir}));
const hookSource=`import fs from 'node:fs';fs.mkdirSync('.fixture',{recursive:true});const p='.fixture/setup-count';fs.writeFileSync(p,String((fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0)+1));`;
if(!continuationDir){
await mkdir(repo);await writeFile(path.join(repo,'setup.mjs'),hookSource);await writeFile(path.join(repo,'.gitignore'),'.fixture/\n');await writeFile(path.join(repo,'README.md'),'This disposable fixture has no business services.\n');
await writeFile(path.join(repo,'AGENTS.md'),'Work only in this disposable repository. No network, other agents, external services, credential inspection, commits, pushes or branches. The manager supplies the exact assignment and authorization. Use local_orchestration.report to report progress and final result.\n');
await exec('git',['init','-q','-b','main',repo]);await exec('git',['-C',repo,'add','.']);await exec('git',['-C',repo,'-c','user.name=Native fixture','-c','user.email=fixture@localhost.invalid','commit','-qm','Disposable acceptance fixture']);
}
const source={path:'setup.mjs',sha256:createHash('sha256').update(hookSource).digest('hex')};
const plan={schemaVersion:1,sources:[source],setup:{command:`${JSON.stringify(process.execPath)} setup.mjs`,source,timeoutMs:10000},start:null,resume:null,ready:null,stop:null,teardown:null};
let project={id:'native-followup',name:'Disposable native continuation acceptance',mode:'repository',readiness:{ready:true},repositories:[{id:'repo',path:repo,baseRef:'main'}],worker:{sandbox:'workspace-write',timeoutMs:180000,maxConcurrent:1,environment:{executionPlan:plan}}};
if(continuationDir){const existing=await readTask(stateDir,taskId);project=JSON.parse(await readFile(path.join(existing.runDir,'config.json'),'utf8')).project;}
let controller,summary={evidenceDir:dir,passed:false,assignments:[]};
const read=()=>readTask(stateDir,taskId);
async function action(action){const task=await read();await requestWorkerAction(stateDir,{taskId,actionId:`native-${action}-${Date.now()}`,action,expectedRunId:task.runId||null});await controller.tick();}
async function complete(previousRun=null){
 const until=Date.now()+180000;
 while(Date.now()<until){
  const task=await read();
  const requests=await listWorkerRequests({stateDir,taskId,runId:task.runId,pendingOnly:true});
  if(requests.length)throw Error(`Native approval needs human action (${requests.map(r=>r.method).join(', ')}); normal approvals were preserved.`);
  if(task.runId!==previousRun&&task.status==='completed'&&task.execution?.live===false){console.log(JSON.stringify({event:'assignment-completed',assignmentId:currentAssignment(task).id,runId:task.runId,threadId:task.threadId,worktree:task.worktree}));return task;}
  if(['failed','blocked','stopped','paused','awaiting_answer'].includes(task.status))throw Error(`Worker ended ${task.status}: ${task.failure||task.question?.message||task.progress||'inspect retained evidence'}`);
  await sleep(250);
 }
 throw Error('Native assignment exceeded the bounded three-minute wait; retained evidence needs review.');
}
async function followup(id,brief,previous){
 const runtime=path.join(dir,'manager-runtime.json');await writeFile(runtime,JSON.stringify({project}));
 const child=spawn(process.execPath,[path.join(sourceDir,'orchestration-mcp.mjs'),stateDir,'manager',runtime]);let output='',errors='';
 child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>errors+=d);
 child.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'assign_worker_followup',arguments:{taskId,requestId:id,brief}}})+'\n');
 const code=await new Promise(resolve=>child.on('close',resolve));assert.equal(code,0,errors);const queued=JSON.parse(output.trim()).result;assert.ok(!queued.isError,queued.content?.[0]?.text);
 console.log(JSON.stringify({event:'direction-accepted',requestId:id,delivery:'queued'}));
 return complete(previous.runId);
}
try{
 controller=await createController({stateDir,sourceDir,executable,project});
 let research,refinement,advancedHead;
 if(!continuationDir){
 await createTask(stateDir,{requestId:taskId,ticket:'GH-50',projectId:project.id,repositoryId:'repo',brief:'Acceptance research assignment. Inspect README.md and get_project_environment. Crew must not have run Setup automatically: verify .fixture/setup-count is absent, then explicitly run configuredEnvironment.executionPlan.setup.command once using your normal native command tool. That command creates only ignored fixture data; other source files remain read-only. Use set_workflow_state with state Research complete before reporting the final result. Remember the context marker amber-50 for future assignments in this same conversation. Do not write it to any repository file. Do not inspect external tickets or services. Report a useful progress update then a final result through local_orchestration.report with concrete command evidence. End the turn.'});
 await action('start');research=await complete();
 const researchExit=JSON.parse(await readFile(path.join(research.runDir,'exit.json'),'utf8'));
 assert.ok(researchExit.commands.some(command=>command.exitCode===0&&/\bnode(?:js)?["']?\s+["']?(?:\.\/)?setup\.mjs\b/.test(command.command)),'Setup was actually executed through the native command tool');
 const implementation=await followup('native-implementation','Acceptance implementation assignment. The user explicitly authorizes creating implementation.txt in this disposable worktree. Write exactly the remembered context marker from the earlier research conversation followed by a newline; this brief intentionally does not repeat that marker. Run a command to read it back and check it. Do not rerun Setup or change other files. Use set_workflow_state with state Implementation complete. Report progress and final result through local_orchestration.report. End the turn.',research);
 assert.equal(await readFile(path.join(implementation.worktree,'implementation.txt'),'utf8'),'amber-50\n','same native conversation remembers the original marker');
 // All changes stay in this disposable fixture. Advanced HEAD and different
 // project instructions/lifecycle settings must not become Crew direction gates.
 await exec('git',['-C',implementation.worktree,'config','user.name','Native fixture']);await exec('git',['-C',implementation.worktree,'config','user.email','fixture@localhost.invalid']);
 await exec('git',['-C',implementation.worktree,'add','implementation.txt']);await exec('git',['-C',implementation.worktree,'commit','-qm','Retain first native implementation']);
 advancedHead=(await exec('git',['-C',implementation.worktree,'rev-parse','HEAD'])).stdout.trim();assert.notEqual(advancedHead,research.baseCommit);
 await writeFile(path.join(implementation.worktree,'AGENTS.md'),'Work only in this disposable repository. Follow the next manager direction and report actual evidence. No other agents, external services, credentials, commits or pushes.\n');
 await mkdir(path.join(implementation.worktree,'.codex'),{recursive:true});await writeFile(path.join(implementation.worktree,'.codex/config.toml'),'# Changed native project configuration; preserve inherited approval policy.\n');
 await writeFile(path.join(implementation.worktree,'external-note.txt'),'Uncommitted manager-side fixture note.\n');
 await writeFile(path.join(implementation.worktree,'setup.mjs'),'throw Error("Crew must not replay setup to send a direction");\n');
 project.readiness={ready:false,issues:['Changed configuration must not gate direction']};project.worker.environment.executionPlan.setup.command='exit 91';project.worker.environment.executionPlan.ready={...project.worker.environment.executionPlan.setup,command:'exit 92'};
 refinement=await followup('native-refinement','Acceptance refinement assignment. The user explicitly authorizes appending one line to implementation.txt: repeat the remembered marker with the suffix -again. Preserve the first line. Run a command to read and verify both lines. Do not rerun Setup or change other files. Use set_workflow_state with state Done. Report progress and final result through local_orchestration.report. End the turn.',implementation);
 assert.equal(await readFile(path.join(refinement.worktree,'implementation.txt'),'utf8'),'amber-50\namber-50-again\n');
 assert.equal(refinement.threadId,research.threadId);assert.equal(implementation.threadId,research.threadId);assert.equal(refinement.worktree,research.worktree);assert.equal(implementation.worktree,research.worktree);assert.equal(await readFile(path.join(refinement.worktree,'.fixture/setup-count'),'utf8'),'1');assert.equal(refinement.assignments.length,3);assert.ok(refinement.assignments.every(a=>a.status==='completed'&&a.result?.message));assert.equal(new Set(refinement.assignments.flatMap(a=>a.runIds)).size,3);assert.equal(refinement.workflowState.value,'Done');assert.ok(refinement.workflowHistory.length>=3);
 }else{refinement=await read();assert.equal(refinement.assignments.length,3,'continuation starts from the completed three-assignment proof');assert.equal(refinement.status,'completed');research={threadId:refinement.threadId,worktree:refinement.worktree};advancedHead=(await exec('git',['-C',refinement.worktree,'rev-parse','HEAD'])).stdout.trim();}
 const priorAssignments=structuredClone(refinement.assignments),beforeWorkerCommit=(await exec('git',['-C',refinement.worktree,'rev-parse','HEAD'])).stdout.trim();
 await writeFile(path.join(refinement.worktree,'AGENTS.md'),'Work only in this disposable repository. The manager explicitly permits one local commit containing implementation.txt only. Preserve every other dirty file without staging or committing it. No network, pushes, external services or credential access. Follow subsequent manager directions and report actual evidence.\n');
 const committed=await followup('native-worker-commit','Create one local Git commit containing ONLY the current uncommitted implementation.txt change. This exact local commit is permitted by the updated fixture AGENTS.md. Use commit message Native worker-owned continuation. Do not stage or commit any other file. Do not push or use the network. Verify the commit file list and HEAD. Set workflow state Committed and report concrete command evidence and the new commit ID through local_orchestration.report, then end the turn.',refinement);
 const workerCommit=(await exec('git',['-C',committed.worktree,'rev-parse','HEAD'])).stdout.trim();assert.notEqual(workerCommit,beforeWorkerCommit);assert.equal((await exec('git',['-C',committed.worktree,'diff-tree','--no-commit-id','--name-only','-r',workerCommit])).stdout.trim(),'implementation.txt');
 assert.equal((await exec('git',['-C',committed.worktree,'diff','--cached','--name-only'])).stdout.trim(),'','worker did not stage unrelated fixture changes');
 const commitExit=JSON.parse(await readFile(path.join(committed.runDir,'exit.json'),'utf8'));assert.ok(commitExit.commands.some(command=>command.exitCode===0&&/\bgit\b[\s\S]*\bcommit\b/.test(command.command)),'real native worker executed the commit command');
 const final=await followup('native-after-worker-commit','Continue after your local commit. Read and verify the existing implementation file and current Git HEAD; do not edit, stage, commit or push anything. Include the remembered context marker in your result report, set workflow state Done, and end the turn.',committed);
 assert.equal(final.threadId,research.threadId);assert.equal(final.worktree,research.worktree);assert.equal(final.assignments.length,5);assert.deepEqual(final.assignments.slice(0,3),priorAssignments);assert.ok(final.assignments.every(a=>a.status==='completed'&&a.result?.message));assert.equal(final.workflowState.value,'Done');assert.ok(final.result.message.includes('amber-50'));assert.equal((await exec('git',['-C',final.worktree,'rev-parse','HEAD'])).stdout.trim(),workerCommit);assert.equal(await readFile(path.join(final.worktree,'.fixture/setup-count'),'utf8'),'1');
 summary={...summary,passed:true,workerCommit,nativeWorkerCommitObserved:true,postCommitDirectionCompleted:true,advancedHead,uncommittedChangesAccepted:true,changedLifecycleAccepted:true,managerToolsUsed:true,agentInitiatedSetup:true,workflowState:final.workflowState.value,threadId:final.threadId,worktree:final.worktree,setupCount:1,assignments:final.assignments.map(a=>({id:a.id,status:a.status,runIds:a.runIds,resultRetained:Boolean(a.result?.message)}))};
}catch(error){summary.error=error.message;process.exitCode=1;console.error(JSON.stringify({event:'acceptance-blocked',message:error.message}));}
finally{
 if(controller){
  try{
   const task=await read().catch(()=>null);
   const terminal=task?.runDir?await readFile(path.join(task.runDir,'exit.json'),'utf8').then(JSON.parse).catch(()=>null):null;
   const confirmed=!task?.harnessStarted||terminal?.runId===task.runId&&(terminal.connectionClosed===true||terminal.stopConfirmed===true);
   if(task&&(!confirmed||!['completed','failed','blocked','stopped','paused','disposed'].includes(task.status))){
    await action('pause');
    for(let i=0;i<80;i++){
     const latest=await read(),exit=latest.runDir?await readFile(path.join(latest.runDir,'exit.json'),'utf8').then(JSON.parse).catch(()=>null):null;
     if(['paused','stopped','failed'].includes(latest.status)&&(!latest.harnessStarted||exit?.runId===latest.runId&&(exit.connectionClosed===true||exit.stopConfirmed===true)))break;
     await sleep(250);
    }
   }
  }finally{await controller.stop();}
 }
 await writeFile(path.join(dir,'summary.json'),JSON.stringify(summary,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({event:'acceptance-summary',...summary}));
}
