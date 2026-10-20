// Stable owned root: wait for ancestry capture before executing a hook; keep the
// root alive after command completion until its supervisor reaps descendants.
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
const config=JSON.parse(await readFile(process.argv[2],'utf8'));
const keepalive=setInterval(()=>{},1000);
await new Promise(resolve=>process.stdin.once('data',resolve));
const child=spawn(config.command,config.args,{cwd:config.worktree,env:process.env,stdio:'ignore'});
let sent=false;function finished(code,error=null){if(sent)return;sent=true;process.stdout.write(JSON.stringify({type:'hook-exit',code,error})+'\n');}
child.once('error',error=>finished(null,error.code||'spawn failed'));child.once('close',code=>finished(code));
