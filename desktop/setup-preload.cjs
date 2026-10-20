const { contextBridge, ipcRenderer } = require('electron');
const call = async (action, value) => {
  try { return await ipcRenderer.invoke('crew:setup', action, value); }
  catch (error) { throw new Error(String(error.message).replace(/^Error invoking remote method '[^']+': Error: /, '')); }
};
contextBridge.exposeInMainWorld('crewSetup', Object.freeze({
  storageRetry:()=>call('storage-retry'),storageUse:index=>call('storage-use',index),storageFolder:()=>call('storage-folder'),
  snapshot:()=>call('snapshot'), initialize:()=>call('initialize'), runtime:()=>call('runtime'), account:()=>call('account'),
  login:()=>call('login'), save:value=>call('save',value), paths:()=>call('paths'),
  chooseDiscovery:()=>call('choose-discovery'), discover:()=>call('discover'), cancelDiscovery:()=>call('cancel-discovery'),
  linearOptions:teamId=>call('linear-options',teamId), repositoryOptions:path=>call('repository-options',path),
  chooseRepository:()=>call('choose-repository'), chooseCodex:()=>call('choose-codex'),
  microphone:()=>call('microphone'), settings:name=>call('settings',name),
  openConfig:()=>call('open-config'), openPrompts:()=>call('open-prompts'),
  launch:()=>call('launch'), help:()=>call('help')
}));
