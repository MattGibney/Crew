// Synthetic setup preload for the genuine compiled setup renderer. No native permissions.
const state = {
 revision:'r1', discoveryRoot:null, checks:{}, microphone:'not-determined', controllerRunning:false,
 config:{schemaVersion:1,runtime:{port:4332,codexBinary:null,dataDir:'.data'},project:{id:'proof',name:'Proof project',context:'Bounded setup proof',mode:'repository',repositories:[],linear:{teamId:null,teamKey:null,projectId:null},prompts:{manager:'prompts/manager.md',worker:'prompts/worker.md'},worker:{maxConcurrent:2,sandbox:'read-only'}}}
};
const calls=[]; const reply=()=>structuredClone(state); let revision=1;
window.__crewProof={calls,state,stale:false};
window.crewSetup={
 snapshot:async()=>reply(),
 save:async({config,revision:expected})=>{calls.push({method:'save',config,revision:expected});if(window.__crewProof.stale){window.__crewProof.stale=false;state.revision='r'+(++revision);throw Error('Configuration changed. Reload setup before saving.');}if(expected!==state.revision)throw Error('Stale revision');state.config=config;state.revision='r'+(++revision);return reply();},
 chooseDiscovery:async()=>{calls.push({method:'chooseDiscovery'});state.discoveryRoot='/tmp/fixture-project';return reply();},
 discover:async()=>{calls.push({method:'discover'});state.config.project.repositories=[{id:'fixture',name:'Fixture',path:state.discoveryRoot,baseRef:'main',components:[]}];state.repositoryOptions=[{path:state.discoveryRoot,status:'verified',branches:[{ref:'main',label:'main'},{ref:'develop',label:'develop'}]}];state.discoverySummary={sources:['README.md'],findings:[{statement:'Local fixture project',sources:['README.md']}]};state.revision='r'+(++revision);return reply();},
 cancelDiscovery:async()=>({notice:'Canceled'}),
 runtime:async()=>{calls.push({method:'runtime'});state.checks.codex={status:'verified',detail:'Fixture executable'};state.checks.git={status:'verified',detail:'Fixture Git'};state.checks.toolchain_fixture={status:'unavailable',detail:'Fixture: required managed Node/npm is not cached. Required tools install on first authorized worker launch, before project setup.'};return reply();},
 account:async()=>{calls.push({method:'account'});for(const key of ['protocol','auth','voices'])state.checks[key]={status:'verified',detail:'Fixture capability'};return reply();},
 linearOptions:async()=>{calls.push({method:'linearOptions'});state.linearOptions={detail:'Fixture connected teams',teams:[{id:'team1',name:'Crew',key:'CREW'}],projects:[{id:'project1',name:'Crew app',teamIds:['team1']}]};return reply();},
 paths:async()=>{calls.push({method:'paths'});state.checks.paths=[{name:'Private state',status:'verified',detail:'Fixture path'}];return reply();},
 microphone:async()=>{calls.push({method:'microphone'});throw Error('Microphone must remain untouched');},
 launch:async()=>{calls.push({method:'launch'});return{notice:'Manager opened'};},
 settings:async(name)=>{calls.push({method:'settings',name});},
 chooseRepository:async()=>null,chooseCodex:async()=>null,help:async()=>{},openConfig:async()=>{},openPrompts:async()=>{}
};

const evidence = document.createElement('script');
evidence.type = 'application/json'; evidence.id = 'crew-fixture-evidence'; document.head.append(evidence);
const originalPush = calls.push.bind(calls);
calls.push = (...items) => { const result = originalPush(...items); queueMicrotask(() => { evidence.textContent = JSON.stringify({ calls, state }); }); return result; };
evidence.textContent = JSON.stringify({ calls, state });
