// Private controller evidence: retain hashes and paths, never file contents/diffs.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { lstat, readlink, realpath, open } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
const exec=promisify(execFile);
const sha=value=>createHash('sha256').update(value).digest('hex');
const maxBytes=8*1024*1024, maxFileBytes=4*1024*1024, maxTotalBytes=16*1024*1024, maxFiles=500;
async function git(worktree,args){
  try{return (await exec('git',['-C',worktree,...args],{encoding:'buffer',maxBuffer:maxBytes,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}})).stdout;}
  catch{throw new Error('Worktree evidence could not be captured within its bounded Git read; retained resources were preserved.');}
}
export async function captureWorktreeEvidence(worktree){
  const root=await realpath(worktree);
  const status=await git(root,['status','--porcelain=v1','-z','--untracked-files=all']);
  const diff=await git(root,['diff','--no-ext-diff','--no-textconv','HEAD','--binary','--']);
  const untracked=(await git(root,['ls-files','--others','--exclude-standard','-z'])).toString('utf8').split('\0').filter(Boolean);
  if(untracked.length>maxFiles)throw new Error('Too many untracked files to verify retained worktree ownership; review and preserve the work before retrying.');
  let bytes=0;const files=[];
  for(const name of untracked){
    // Never follow symlinks or inspect credential material. Ignored project
    // configuration is excluded by Git; sensitive unignored paths require review.
    if(name.split('/').some(part=>/^(?:\.env(?:\..*)?|\.ssh|\.aws|\.codex|credentials(?:\..*)?|id_rsa|id_ed25519)$/i.test(part))||/\.(?:pem|key|p12|pfx)$/i.test(name))throw new Error('Untracked credential-like material prevents a complete ownership snapshot; preserve it privately and exclude it from Git before retrying.');
    const file=path.resolve(root,name);
    if(!file.startsWith(root+path.sep))throw new Error('Untracked worktree path is outside the retained root.');
    // Git paths may have a symlink directory replaced concurrently: verify each
    // parent resolves beneath the owned canonical root before opening the file.
    const parent=await realpath(path.dirname(file));
    if(parent!==root&&!parent.startsWith(root+path.sep))throw new Error('Untracked worktree parent points outside the retained root.');
    const before=await lstat(file);let content;
    if(before.isSymbolicLink())content=Buffer.from(await readlink(file));
    else if(before.isFile()){
      if(before.size>maxFileBytes||bytes+before.size>maxTotalBytes)throw new Error('Untracked worktree evidence exceeds its bounded ownership read; preserve the files and review before retrying.');
      // O_NOFOLLOW protects the final path from concurrent symlink substitution.
      const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
      try{const actual=await handle.stat();if(!actual.isFile()||actual.dev!==before.dev||actual.ino!==before.ino||actual.size!==before.size)throw new Error('Untracked file changed while recording ownership; retry the review.');const buffer=Buffer.alloc(maxFileBytes+1);let used=0;for(;;){const result=await handle.read(buffer,used,buffer.length-used,null);used+=result.bytesRead;if(used>maxFileBytes)throw new Error('Untracked file grew beyond the ownership read limit.');if(!result.bytesRead)break;}const after=await handle.stat();if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw new Error('Untracked file changed while recording ownership; retry the review.');content=buffer.subarray(0,used);}finally{await handle.close();}
    }else throw new Error('Unsupported untracked file type prevents an ownership snapshot.');
    bytes+=content.length;files.push({path:name,kind:before.isSymbolicLink()?'symlink':'file',mode:before.mode&0o777,hash:sha(content)});
  }
  // A second status/diff pass rejects ordinary concurrent edits instead of
  // recording a mixture of two workspace states.
  if(!status.equals(await git(root,['status','--porcelain=v1','-z','--untracked-files=all']))||!diff.equals(await git(root,['diff','--no-ext-diff','--no-textconv','HEAD','--binary','--'])))throw new Error('Worktree changed while recording ownership; retry the review.');
  const statusHash=sha(status),diffHash=sha(diff),untrackedHash=sha(JSON.stringify(files));
  return {version:1,fingerprint:sha(JSON.stringify({statusHash,diffHash,untrackedHash})),clean:status.length===0,dirty:status.length!==0,changedFiles:status.toString('utf8').split('\0').filter(Boolean),statusHash,diffHash,untrackedHash,untrackedFiles:files.length,at:new Date().toISOString()};
}
