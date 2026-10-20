// AI-010: discover proven local choices and perform bounded, read-only Linear setup reads.
import { realpath, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
const run=promisify(execFile);
const clean=v=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,300):null;
export async function discoverRepository({path,env=process.env}) {
  if(typeof path!=='string'||!path.trim()||path.includes('\0'))throw new Error('Choose a local project folder.');
  const selectedPath=await realpath(resolve(path));
  if(!(await stat(selectedPath)).isDirectory())throw new Error('Choose a folder, rather than a file.');
  const git=async args=>(await run('git',['-C',selectedPath,...args],{env:{...env,GIT_OPTIONAL_LOCKS:'0'},timeout:10000,maxBuffer:1024*1024})).stdout.trim();
  let repositoryPath;
  try{repositoryPath=await realpath(await git(['rev-parse','--show-toplevel']));}catch{throw new Error('This folder is not a Git repository. Choose the project repository folder.');}
  const name=basename(repositoryPath),id=name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^[^a-z]+/,'').replace(/-$/,'').slice(0,64)||'project';
  const raw=await git(['for-each-ref','--format=%(refname)%09%(symref)%09%(objecttype)','refs/heads','refs/remotes']);
  const branches=[];
  for(const line of raw.split('\n')){const [ref,symref,type]=line.split('\t');if(!ref||symref||type!=='commit')continue;branches.push({value:ref.replace(/^refs\/(heads|remotes)\//,''),label:ref.replace(/^refs\/(heads|remotes)\//,''),kind:ref.startsWith('refs/heads/')?'local':'remote'});}
  branches.sort((a,b)=>a.kind.localeCompare(b.kind)||a.label.localeCompare(b.label));
  let origin=null,current=null;try{origin=(await git(['symbolic-ref','--short','refs/remotes/origin/HEAD']));}catch{}try{current=await git(['symbolic-ref','--short','HEAD']);}catch{}
  let baseRef=[origin,'main','master',current].find(value=>value&&branches.some(b=>b.value===value))||null;
  // A detached HEAD is a valid committed starting point, but an unborn HEAD is not.
  if(!baseRef){try{const hash=await git(['rev-parse','--verify','HEAD^{commit}']);if(/^[a-f0-9]{40,64}$/.test(hash)){branches.push({value:hash,label:`Current commit (${hash.slice(0,8)})`,kind:'commit'});baseRef=hash;}}catch{}}
  return {status:baseRef?'verified':'incomplete',selectedPath,path:repositoryPath,name,id,branches:branches.map(b=>({...b,ref:b.value})),baseRef,defaultBranch:baseRef,currentBranch:current,detail:baseRef?'Starting branch selected from this repository. You can change it later.':'This repository has no committed starting point yet. Make its first commit, then try again.'};
}
export async function verifyReference({path,ref,env=process.env}) {
  if(typeof ref!=='string'||!ref.trim()||ref.startsWith('-')||/[\u0000-\u001f\u007f]/.test(ref)||ref.length>1024)throw new Error('Choose a valid starting branch.');
  const folder=await realpath(resolve(path));
  try {
    const {stdout}=await run('git',['-C',folder,'rev-parse','--verify','--end-of-options',`${ref}^{commit}`],{env:{...env,GIT_OPTIONAL_LOCKS:'0'},timeout:10000,maxBuffer:65536});
    const commit=stdout.trim();if(!/^[a-f0-9]{40,64}$/.test(commit))throw Error();
    return {path:folder,ref,commit,status:'verified'};
  }catch{throw new Error('That starting branch is not available in this repository. Refresh the branch list and choose an existing branch.');}
}
async function withClient({executable,root,env=process.env,signal,timeoutMs=20000},body){
  if(!executable)throw new Error('Install Codex and sign in with ChatGPT, then retry.');
  const child=spawn(executable,['app-server','--stdio','-c','forced_login_method="chatgpt"','-c','model_provider="openai"'],{cwd:root,env,stdio:['pipe','pipe','ignore']});
  let seq=0,dead=false;const pending=new Map();
  const fail=e=>{dead=true;for(const p of pending.values()){clearTimeout(p.timer);p.reject(e);}pending.clear();};
  child.on('error',fail);child.on('exit',()=>fail(new Error('Codex disconnected. Retry Linear discovery.')));
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{try{const m=JSON.parse(line),p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error('Codex could not complete the Linear read. Reconnect Linear in Codex and retry.')):p.resolve(m.result);}else if(m.id!==undefined&&m.method)child.stdin.write(JSON.stringify({id:m.id,error:{code:-32601,message:'Setup cannot approve work or credential requests.'}})+'\n');}catch{}});
  const cancel=()=>{fail(new Error('Linear discovery canceled.'));child.kill('SIGTERM');};signal?.addEventListener('abort',cancel,{once:true});
  const rpc=(method,params={})=>new Promise((resolve,reject)=>{if(dead||signal?.aborted)return reject(new Error('Linear discovery canceled or disconnected.'));const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Linear discovery timed out. Check the connection in Codex and retry.'));},timeoutMs);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n');});
  try{await rpc('initialize',{clientInfo:{name:'crew_setup_options',version:'0.5.0'},capabilities:{experimentalApi:true}});child.stdin.write('{"method":"initialized","params":{}}\n');return await body(rpc);}finally{signal?.removeEventListener('abort',cancel);fail(new Error('Setup read finished.'));lines.close();child.kill('SIGTERM');await new Promise(done=>{if(child.exitCode!==null)return done();const t=setTimeout(()=>{child.kill('SIGKILL');done();},1500);child.once('exit',()=>{clearTimeout(t);done();});});}
}
function payload(result){
  if(result?.isError)throw new Error('Linear could not read this workspace. Reconnect Linear in Codex and retry.');
  if(result?.structuredContent&&typeof result.structuredContent==='object')return result.structuredContent;
  for(const block of result?.content||[])if(block.type==='text'&&typeof block.text==='string'){try{return JSON.parse(block.text);}catch{}}
  throw new Error('Linear returned an unrecognized response. Retry or connect it later.');
}
function records(data,kind){if(Array.isArray(data))return data;return data?.[kind]||data?.nodes||data?.data?.[kind]||data?.data||[];}
function normalize(rows,kind){if(!Array.isArray(rows))throw new Error('Linear returned an unrecognized list. Retry or connect it later.');return rows.filter(r=>r&&typeof r.id==='string'&&typeof r.name==='string').map(r=>({id:clean(r.uuid)||clean(r.id),name:clean(r.name),...(kind==='teams'?{key:clean(r.key)||null}:{teamIds:Array.isArray(r.teams)?r.teams.map(t=>clean(typeof t==='string'?t:t.id)).filter(Boolean):Array.isArray(r.teams?.nodes)?r.teams.nodes.map(t=>clean(t.id)).filter(Boolean):r.team?.id?[clean(r.team.id)]:[]})}));}
export async function discoverLinearOptions({executable,root,env=process.env,signal,teamId=null,timeoutMs=20000,rpc:injectedRpc}={}){
  const empty={teams:[],projects:[],truncated:false};
  const discover=async rpc=>{
    const {account}=await rpc('account/read',{refreshToken:false});if(account?.type!=='chatgpt')return {...empty,status:'unavailable',detail:'Sign in to Codex with ChatGPT, connect Linear, then retry. You can continue without Linear.'};
    const tools=[];let cursor=null,catalogTruncated=false;
    for(let i=0;i<5;i++){const page=await rpc('mcpServerStatus/list',{cursor,limit:100,detail:'toolsAndAuthOnly'});for(const s of page.data||[])for(const [name,spec]of Object.entries(s.tools||{}))if(/linear/i.test(`${s.name} ${name}`))tools.push({server:s.name,name,spec});cursor=page.nextCursor;catalogTruncated=Boolean(cursor);if(!cursor)break;}
    const find=kind=>tools.find(t=>new RegExp(`(?:^|[._/])list_${kind}$`,'i').test(t.name));
    const teamTool=find('teams'),projectTool=find('projects');
    if(!teamTool&&!projectTool)return {...empty,status:catalogTruncated?'unknown':'unavailable',detail:'Linear is not available in Codex. Connect Linear in Codex and retry, or continue without it.'};
    // Public generated schema requires threadId for MCP calls. This short-lived context
    // is ephemeral, read-only, and never receives a model turn or manager history.
    const started=await rpc('thread/start',{cwd:root,ephemeral:true,sandbox:'read-only',approvalPolicy:'never',environments:[]});const threadId=started?.thread?.id;if(!threadId)throw new Error('Codex could not open a temporary connection for Linear. Retry.');
    const result={...empty,status:'verified',detail:'Read available teams and projects from your connected Linear workspace.',teamsStatus:teamTool?'verified':'unavailable',projectsStatus:projectTool?'verified':'unavailable'};
    try{
      for(const [kind,tool]of [['teams',teamTool],['projects',projectTool]]){
        if(!tool)continue;
        try{
          const properties=tool.spec.inputSchema?.properties||{},required=tool.spec.inputSchema?.required||[];const allowed=new Set(['limit','cursor','team']);if(required.some(k=>!allowed.has(k)||(k==='team'&&!teamId)))throw new Error('This Linear connector requires additional information. You can connect it later.');
          let next=null;const rows=[];for(let i=0;i<5;i++){
            const args={};if(properties.limit)args.limit=Math.min(100,properties.limit.maximum||100);if(kind==='projects'&&properties.fields?.items?.enum?.includes('teams'))args.fields=['id','uuid','name','teams'].filter(f=>properties.fields.items.enum.includes(f));if(next&&properties.cursor)args.cursor=next;if(teamId&&kind==='projects'&&properties.team)args.team=teamId;
            const data=payload(await rpc('mcpServer/tool/call',{threadId,server:tool.server,tool:tool.name,arguments:args}));rows.push(...normalize(records(data,kind),kind));
            const info=data.pageInfo||data.data?.pageInfo||{},more=data.hasNextPage??info.hasNextPage??false;next=data.cursor||data.nextCursor||info.endCursor;if(!more&&!data.nextCursor)break;if(!next||!properties.cursor||i===4){result.truncated=true;break;}
          }result[kind]=[...new Map(rows.map(r=>[r.id,r])).values()];
        }catch(error){result[`${kind}Status`]='unavailable';result.status='partial';result.detail=error.message;}
      }
      if(result.teamsStatus==='unavailable'&&result.projectsStatus==='unavailable')result.status='unavailable';return result;
    }finally{await rpc('thread/unsubscribe',{threadId}).catch(()=>{});}
  };
  try{return injectedRpc?await discover(injectedRpc):await withClient({executable,root,env,signal,timeoutMs},discover);}catch(error){return {...empty,status:signal?.aborted?'canceled':'unavailable',detail:error.message};}
}
