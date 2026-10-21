// AI-015: bounded inherited process IPC; never expose native/Node access to a renderer.
import {randomUUID} from 'node:crypto';
export const updateActions=new Set(['status','check','download','restart','pause-update','cancel-pause-update']);
export function unavailableUpdateStatus(version){return {phase:'unavailable',currentVersion:version,availableVersion:null,downloadPercent:null,error:null,installBlocked:true,reasons:['Open the installed desktop app to manage updates.'],supported:false,releaseUrl:'https://github.com/MattGibney/crew/releases/latest'};}
export function createUpdateBridge({transport=process,version,onStatus=()=>{},timeoutMs=30000}={}){
 let status=unavailableUpdateStatus(version),closed=false;
 const pending=new Map();
 const accept=value=>{
  if(!value||typeof value.phase!=='string'||typeof value.supported!=='boolean'||typeof value.currentVersion!=='string'||!Array.isArray(value.reasons))throw new Error('Desktop update status is unavailable.');
  status={phase:value.phase.slice(0,40),currentVersion:value.currentVersion.slice(0,60),availableVersion:typeof value.availableVersion==='string'?value.availableVersion.slice(0,60):null,downloadPercent:Number.isFinite(value.downloadPercent)?Math.max(0,Math.min(100,value.downloadPercent)):null,error:typeof value.error==='string'?value.error.slice(0,1000):null,installBlocked:value.installBlocked!==false,reasons:value.reasons.filter(item=>typeof item==='string').slice(0,12).map(item=>item.slice(0,600)),notices:Array.isArray(value.notices)?value.notices.filter(item=>typeof item==='string').slice(0,12).map(item=>item.slice(0,600)):[],supported:value.supported,releaseUrl:'https://github.com/MattGibney/crew/releases/latest'};onStatus(status);return status;
 };
 const listener=message=>{
  if(!message||typeof message!=='object')return;
  if(message.type==='crew:update:status'){try{accept(message.status);}catch{}return;}
  if(message.type!=='crew:update:response'||!pending.has(message.id))return;
  const request=pending.get(message.id);pending.delete(message.id);clearTimeout(request.timer);
  try{const next=accept(message.status);if(message.error)request.reject(new Error(String(message.error).slice(0,1000)));else request.resolve(next);}catch(error){request.reject(error);}
 };
 transport.on('message',listener);
 const disconnected=()=>{status=unavailableUpdateStatus(version);onStatus(status);for(const request of pending.values()){clearTimeout(request.timer);request.reject(new Error('Desktop update connection closed.'));}pending.clear();};
 transport.on('disconnect',disconnected);
 return {
  getStatus:()=>structuredClone(status),
  async request(action='status'){
   if(!updateActions.has(action))throw new Error('Unknown update action.');
   if(closed||typeof transport.send!=='function'||transport.connected!==true){if(action==='status')return structuredClone(status);throw new Error('Updates are available in the installed desktop app.');}
   if(pending.size>=8)throw new Error('An update request is already pending.');
   const id=randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Desktop update request timed out. Retry from the app menu.'));},timeoutMs);timer.unref?.();pending.set(id,{resolve,reject,timer});transport.send({type:'crew:update:request',id,action},error=>{if(!error)return;const request=pending.get(id);if(request){pending.delete(id);clearTimeout(timer);request.reject(new Error('Desktop update connection failed.'));}});});
  },
  close(){closed=true;transport.removeListener('message',listener);transport.removeListener('disconnect',disconnected);disconnected();}
 };
}
