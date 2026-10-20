// AI-011: POSIX descendant ownership, including children in independent process groups.
// Never persist raw process arguments: an ownership record contains only their digest.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
const exec=promisify(execFile),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function snapshotProcesses(){
 const {stdout}=await exec('ps',['-axo','pid=,ppid=,stat=,lstart=,command='],{maxBuffer:8*1024*1024,timeout:5000,env:{...process.env,LC_ALL:'C'}});
 const rows=new Map();
 for(const line of stdout.split('\n')){
  const match=line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.*)$/);
  if(!match)continue;
  const pid=Number(match[1]);rows.set(pid,{pid,ppid:Number(match[2]),state:match[3],start:match[4].replace(/\s+/g,' '),commandHash:createHash('sha256').update(match[5]).digest('hex')});
 }
 return rows;
}
const live=record=>record&&!record.state?.includes('Z');
const identity=record=>({pid:record.pid,ppid:record.ppid,start:record.start,commandHash:record.commandHash});
export class OwnedProcessTree{
 constructor(rootPid,{snapshot=snapshotProcesses,signal=(pid,kind)=>process.kill(pid,kind)}={}){
  if(!Number.isSafeInteger(rootPid)||rootPid<=1||rootPid===process.pid)throw new Error('Invalid owned process root');
  this.rootPid=rootPid;this.snapshot=snapshot;this.signal=signal;this.records=new Map();this.rootIdentity=null;
 }
 async capture(){
  const rows=await this.snapshot(),root=rows.get(this.rootPid);
  // Once a root has exited/reused its PID it cannot acquire any new descendants.
  if(live(root)&&(!this.rootIdentity||root.start===this.rootIdentity.start&&root.commandHash===this.rootIdentity.commandHash)){
   if(!this.rootIdentity)this.rootIdentity=identity(root);
   const depths=new Map([[this.rootPid,0]]);let changed=true;
   while(changed){changed=false;for(const record of rows.values())if(live(record)&&!depths.has(record.pid)&&depths.has(record.ppid)){depths.set(record.pid,depths.get(record.ppid)+1);changed=true;}}
   for(const [pid,depth]of depths){const record=rows.get(pid),previous=this.records.get(pid);if(!previous||previous.start===record.start)this.records.set(pid,{...identity(record),depth});}
  }
  return [...this.records.values()];
 }
 async remaining(){
  const rows=await this.snapshot();
  return [...this.records.values()].filter(owned=>{const current=rows.get(owned.pid);return live(current)&&current.start===owned.start;}).map(owned=>({...owned,identityVerified:rows.get(owned.pid).commandHash===owned.commandHash}));
 }
 async signalOwned(kind){
  const rows=await this.snapshot();
  for(const owned of [...this.records.values()].sort((a,b)=>b.depth-a.depth)){
   const current=rows.get(owned.pid);if(!live(current)||current.start!==owned.start||current.commandHash!==owned.commandHash)continue;
   try{this.signal(owned.pid,kind);}catch(error){if(error.code!=='ESRCH')throw error;}
  }
 }
 async stop({graceMs=1500}={}){
  if(!Number.isInteger(graceMs)||graceMs<0||graceMs>10000)throw new Error('Invalid termination grace period');
  await this.capture();
  if(!this.rootIdentity)return {confirmed:false,remaining:[],tracked:[],reason:'Process ownership was not captured before exit.'};
  await this.signalOwned('SIGTERM');
  const deadline=Date.now()+graceMs;
  while(Date.now()<deadline){await this.capture();if(!(await this.remaining()).length)break;await delay(Math.min(50,Math.max(1,deadline-Date.now())));}
  await this.capture();await this.signalOwned('SIGKILL');
  const killDeadline=Date.now()+1500;let remaining=await this.remaining();
  while(remaining.some(p=>p.identityVerified)&&Date.now()<killDeadline){await delay(25);remaining=await this.remaining();}
  return {confirmed:remaining.length===0,remaining,tracked:[...this.records.values()]};
 }
}
