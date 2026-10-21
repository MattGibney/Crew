// Atomic admission prevents already-entered async requests crossing an install barrier.
export function createUpdateAdmission(){
 let reserved=false,inFlight=0,checking=null,generation=0;
 return {
  get reserved(){return reserved;},
  async run(work){if(reserved)throw new Error('Crew is preparing an update. Wait before starting work.');inFlight++;try{return await work();}finally{inFlight--; }},
  async reserve(activity){
   if(checking)return checking;
   if(reserved)return {reserved:true};
   if(inFlight)return {reserved:false,reasons:['Wait for pending conversation or connection requests to finish.']};
   reserved=true;const attempt=++generation;
   checking=(async()=>{try{const result=await activity();if(attempt!==generation)return {reserved:false,reasons:['Update preparation was canceled.']};if(result?.safe!==true){reserved=false;return {reserved:false,reasons:result?.reasons||['Activity could not be verified.']};}return {reserved:true};}catch(error){if(attempt===generation)reserved=false;throw error;}finally{checking=null;}})();return checking;
  },
  cancel(){generation++;reserved=false;},
 };
}
