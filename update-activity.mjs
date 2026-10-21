// AI-015: an update restart is permitted only with positive idle evidence.
const terminalTasks=new Set(['completed','failed','canceled','cancelled','stopped','paused','disposed']);
const inactiveEnvironment=new Set(['stopped','disposed','not-configured']);
export function updateActivity({work,view,setupBusy=false}={}){
 const reasons=[];
 if(!work||typeof work.voiceActive!=='boolean'||typeof work.voiceConnecting!=='boolean'||typeof work.workStarting!=='boolean')reasons.push('Manager activity is unavailable.');
 else{
  if(work.voiceActive||work.voiceConnecting)reasons.push('Disconnect voice before restarting to update.');
  if(work.activeTurnId||work.workStarting||!['idle','ready','stopped','failed','error'].includes(work.status))reasons.push('Wait for the manager to finish its current work.');
  if(!Array.isArray(work.approvals)||work.approvals.length)reasons.push('Resolve the manager’s pending input before updating.');
 }
 if(setupBusy)reasons.push('Finish project setup before restarting to update.');
 if(!view||view.error||!Array.isArray(view.tasks))reasons.push('Worker activity is unavailable.');
 else for(const task of view.tasks){
  if(!terminalTasks.has(task.status))reasons.push('Finish or stop active and queued workers before updating.');
  if(task.execution?.live===true)reasons.push('A worker process is still running.');
  if(task.harnessStarted&&(task.execution?.live!==false||task.execution?.stopConfirmed!==true))reasons.push('Worker shutdown evidence is unavailable. Review that worker before updating.');
  if(task.lifecycleRequests?.some(request=>!['completed','failed'].includes(request.status)))reasons.push('Wait for worker lifecycle actions to finish.');
  const environment=task.environment;
  if(environment){
   if(environment.hooks?.some(hook=>['pending','running','processing'].includes(hook.status)))reasons.push('Wait for project environment commands to finish.');
   if(environment.runtime&&environment.runtime.status!=='stopped')reasons.push('Stop running project environments before updating.');
   if(!inactiveEnvironment.has(environment.status)&&!['ready','configured'].includes(environment.status))reasons.push('Project environment activity is active or unavailable.');
   if(environment.servicesStarted&&!inactiveEnvironment.has(environment.status))reasons.push('Stop running project environments before updating.');
  }
 }
 return {safe:reasons.length===0,reasons:[...new Set(reasons)]};
}
