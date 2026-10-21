// GH-42 opt-in acceptance: actual subscription Codex, disposable repo/state only.
// Usage: node scripts/worker-followup-native-acceptance.mjs /absolute/path/to/codex
// Normal native approvals remain intact; pending approval ends this bounded probe.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createController} from '../controller.mjs';
import {createTask,readTask,currentAssignment,requestWorkerFollowup,requestWorkerAction} from '../orchestration-store.mjs';
import {listWorkerRequests} from '../worker-approvals.mjs';

const executable=process.argv[2];
if(!executable||!path.isAbsolute(executable))throw Error('Supply an absolute installed Codex executable path.');
const exec=promisify(execFile),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sourceDir=fileURLToPath(new URL('..',import.meta.url)),dir=await mkdtemp(path.join(tmpdir(),'crew-gh42-native-')),repo=path.join(dir,'repo'),stateDir=path.join(dir,'state'),taskId='native-retained-worker';
console.log(JSON.stringify({event:'fixture-created',evidenceDir:dir}));
await mkdir(repo);
const hookSource=`import fs from 'node:fs';fs.mkdirSync('.fixture',{recursive:true});const p='.fixture/setup-count';fs.writeFileSync(p,String((fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0)+1));`;
await writeFile(path.join(repo,'setup.mjs'),hookSource);await writeFile(path.join(repo,'.gitignore'),'.fixture/\n');await writeFile(path.join(repo,'README.md'),'This disposable fixture has no business services.\n');
await writeFile(path.join(repo,'AGENTS.md'),'Work only in this disposable repository. No network, other agents, external services, credential inspection, commits, pushes or branches. The manager supplies the exact assignment and authorization. Use local_orchestration.report to report progress and final result.\n');
await exec('git',['init','-q','-b','main',repo]);await exec('git',['-C',repo,'add','.']);await exec('git',['-C',repo,'-c','user.name=Native fixture','-c','user.email=fixture@localhost.invalid','commit','-qm','Disposable acceptance fixture']);
const source={path:'setup.mjs',sha256:createHash('sha256').update(hookSource).digest('hex')};
const plan={schemaVersion:1,sources:[source],setup:{command:`${JSON.stringify(process.execPath)} setup.mjs`,source,timeoutMs:10000},start:null,resume:null,ready:null,stop:null,teardown:null};
const project={id:'native-followup',name:'Disposable native continuation acceptance',mode:'repository',readiness:{ready:true},repositories:[{id:'repo',path:repo,baseRef:'main'}],worker:{sandbox:'workspace-write',timeoutMs:180000,maxConcurrent:1,environment:{executionPlan:plan}}};
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
 await requestWorkerFollowup(stateDir,{taskId,requestId:id,expectedRunId:previous.runId,expectedAssignmentId:currentAssignment(previous).id,ticket:'GH-42',brief,userDecision:'The human explicitly authorizes this disposable acceptance follow-up and the exact local file edits described.'});
 return complete(previous.runId);
}
try{
 controller=await createController({stateDir,sourceDir,executable,project});
 await createTask(stateDir,{requestId:taskId,ticket:'GH-42',projectId:project.id,repositoryId:'repo',brief:'Acceptance research assignment, read-only. Inspect README.md, run a real local command, and remember the context marker amber-42 for future assignments in this same conversation. Do not write it to any repository file. Do not inspect external tickets or services. Report a useful progress update then a final result through local_orchestration.report with concrete command evidence. End the turn.'});
 await action('start');const research=await complete();
 const implementation=await followup('native-implementation','Acceptance implementation assignment. The user explicitly authorizes creating implementation.txt in this disposable worktree. Write exactly the remembered context marker from the earlier research conversation followed by a newline; this brief intentionally does not repeat that marker. Run a command to read it back and check it. Do not change other files. Report progress and final result through local_orchestration.report. End the turn.',research);
 assert.equal(await readFile(path.join(implementation.worktree,'implementation.txt'),'utf8'),'amber-42\n','same native conversation remembers the original marker');
 const refinement=await followup('native-refinement','Acceptance refinement assignment. The user explicitly authorizes appending one line to implementation.txt: repeat the remembered marker with the suffix -again. Preserve the first line. Run a command to read and verify both lines. Do not change other files. Report progress and final result through local_orchestration.report. End the turn.',implementation);
 assert.equal(await readFile(path.join(refinement.worktree,'implementation.txt'),'utf8'),'amber-42\namber-42-again\n');
 assert.equal(refinement.threadId,research.threadId);assert.equal(implementation.threadId,research.threadId);assert.equal(refinement.worktree,research.worktree);assert.equal(implementation.worktree,research.worktree);assert.equal(await readFile(path.join(refinement.worktree,'.fixture/setup-count'),'utf8'),'1');assert.equal(refinement.assignments.length,3);assert.ok(refinement.assignments.every(a=>a.status==='completed'&&a.result?.message));assert.equal(new Set(refinement.assignments.flatMap(a=>a.runIds)).size,3);
 summary={...summary,passed:true,threadId:refinement.threadId,worktree:refinement.worktree,setupCount:1,assignments:refinement.assignments.map(a=>({id:a.id,status:a.status,runIds:a.runIds,resultRetained:Boolean(a.result?.message)}))};
}catch(error){summary.error=error.message;process.exitCode=1;console.error(JSON.stringify({event:'acceptance-blocked',message:error.message}));}
finally{
 if(controller){
  try{
   const task=await read().catch(()=>null);
   const terminal=task?.runDir?await readFile(path.join(task.runDir,'exit.json'),'utf8').then(JSON.parse).catch(()=>null):null;
   const confirmed=!task?.harnessStarted||terminal?.runId===task.runId&&terminal.stopConfirmed===true;
   if(task&&(!confirmed||!['completed','failed','blocked','stopped','paused','disposed'].includes(task.status))){
    await action('pause');
    for(let i=0;i<80;i++){
     const latest=await read(),exit=latest.runDir?await readFile(path.join(latest.runDir,'exit.json'),'utf8').then(JSON.parse).catch(()=>null):null;
     if(['paused','stopped','failed'].includes(latest.status)&&(!latest.harnessStarted||exit?.runId===latest.runId&&exit.stopConfirmed===true))break;
     await sleep(250);
    }
   }
  }finally{await controller.stop();}
 }
 await writeFile(path.join(dir,'summary.json'),JSON.stringify(summary,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({event:'acceptance-summary',...summary}));
}
