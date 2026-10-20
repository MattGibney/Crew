// AI-010: evidence-backed defaults; no model, filesystem writes or external mutations.
const key=value=>String(value||'').toLowerCase().replace(/[^a-z0-9]/g,'');
export function linearDefaults(catalog,current={},projectName='') {
 const teams=catalog?.teams||[],projects=catalog?.projects||[];
 const exact=teams.filter(t=>t.id===current.teamId||(!current.teamId&&current.teamKey&&t.key===current.teamKey));
 const named=teams.filter(t=>key(t.name)===key(projectName));
 const team=exact.length===1?exact[0]:named.length===1?named[0]:teams.length===1?teams[0]:null;
 const eligible=team?projects.filter(p=>p.teamIds?.includes(team.id)):[];
 const previous=eligible.find(p=>p.id===current.projectId);
 const matches=eligible.filter(p=>key(p.name)===key(projectName));
 const project=previous||(matches.length===1?matches[0]:null);
 return team?{teamId:team.id,teamKey:team.key,projectId:project?.id||null}:current.teamId?{...current}:{teamId:null,teamKey:null,projectId:null};
}
export function composeProjectSetup({proposal,current,repository,linear}) {
 if(repository.status!=='verified')throw Error(repository.detail||'Choose a Git repository folder, then try again.');
 const config=structuredClone(proposal.config);
 config.runtime=structuredClone(current.runtime);
 if(current.project.worker)config.project.worker=structuredClone(current.project.worker);
 const existingRepository=current.project.repositories.find(r=>r.path===repository.path);
 const sameFolder=Boolean(existingRepository);
 if(!sameFolder&&Object.keys(config.project.worker?.environment||{}).length)config.project.worker.environment={};
 if(sameFolder&&current.project.id)config.project.id=current.project.id;
 if(sameFolder && !/draft|configure before|your project|AI-\d/i.test(current.project.name))config.project.name=current.project.name;
 const existingRef=existingRepository?.baseRef;
 const baseRef=existingRef&&(repository.verifiedExistingRef===existingRef||repository.branches?.some(b=>(b.ref||b.value)===existingRef))?existingRef:repository.baseRef||null;
 const configuredRepository={...config.project.repositories[0],id:existingRepository?.id||repository.id,name:repository.name,path:repository.path,baseRef};
 config.project.repositories=sameFolder?current.project.repositories.map(r=>r===existingRepository?configuredRepository:structuredClone(r)):[configuredRepository];
 config.project.linear=linearDefaults(linear,sameFolder?current.project.linear:{},config.project.name);
 return config;
}
export function assertLinearSelection(selection,catalog) {
 if(!selection.teamId)return;
 if(catalog?.teamsStatus!=='verified' && catalog?.status!=='verified')return; // Existing/manual mapping remains unverified, never invented.
 const team=catalog.teams.find(t=>t.id===selection.teamId&&t.key===selection.teamKey);
 if(!team)throw Error('Choose a team from the current Linear list, or refresh the connection.');
 if(selection.projectId && catalog.projectsStatus==='verified' && !catalog.projects.some(p=>p.id===selection.projectId&&p.teamIds?.includes(team.id)))throw Error('Choose a Linear project belonging to the selected team, or leave project unset.');
}
