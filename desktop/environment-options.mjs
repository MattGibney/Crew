// Read project execution configuration; never execute repository scripts during setup.
import {discoverProjectExecutionPlan} from '../project-execution-plan.mjs';
export async function discoverWorkerEnvironment({path,baseRef,env=process.env}) {
  if(!path||!baseRef)return {status:'not-detected',detail:'Choose a project folder and starting branch to read its execution instructions.',plan:null};
  const discovery=await discoverProjectExecutionPlan({path,ref:baseRef,env});
  const start=discovery.actions.find(action=>action.name.toLowerCase()==='start');
  const phase=value=>value?{command:value.command,source:value.source,timeoutMs:600000}:null;
  const sources=discovery.sources.map(({path,sha256})=>({path,sha256}));
  const plan=discovery.setup||discovery.actions.length?{schemaVersion:1,sources,setup:phase(discovery.setup),start:phase(start),resume:phase(start),ready:null,stop:null,teardown:null,...(typeof discovery.localPermissions?.networkAccess==='boolean'?{networkAccess:discovery.localPermissions.networkAccess,permissionsSource:discovery.localPermissions.source}:typeof discovery.networkAccess==='boolean'?{networkAccess:discovery.networkAccess}:{})}:null;
  return {status:plan?'available':'not-detected',detail:plan?`Existing project setup${start?' and Start action':''} found. Commands run unchanged in each worker worktree.${!plan.ready?' No application health command is declared.':''}`:'No executable project setup was found. Project instructions remain available to workers.',plan,actions:discovery.actions,instructions:discovery.instructions,issues:discovery.issues};
}
export function assertWorkerEnvironmentSelection(config,options){
  const plan=config.project.worker.environment?.executionPlan;if(!plan)return;
  if(config.project.repositories.length!==1)throw new Error('Choose execution settings for one repository before enabling project setup.');
  const repo=config.project.repositories[0],option=options.find(o=>o.repositoryId===repo.id&&o.path===repo.path&&o.baseRef===repo.baseRef);
  if(!option?.plan)throw new Error('Project execution instructions are unavailable on the selected branch. Reload setup.');
  if(plan.networkAccess!==option.plan.networkAccess||JSON.stringify(plan.permissionsSource)!==JSON.stringify(option.plan.permissionsSource))throw new Error('Project permissions changed. Reload the project execution plan before saving.');
  for(const source of plan.sources)if(!option.plan.sources.some(s=>s.path===source.path&&s.sha256===source.sha256))throw new Error('Project execution instructions changed. Reload the execution plan before saving.');
  if(plan.setup&&plan.setup.command!==option.plan.setup?.command)throw new Error('Reload the project setup command from the selected branch.');
  for(const phase of ['start','resume'])if(plan[phase]&&!option.actions.some(action=>action.command===plan[phase].command&&action.source.path===plan[phase].source.path&&action.source.sha256===plan[phase].source.sha256))throw new Error('Reload the project execution commands from the selected branch.');
}
