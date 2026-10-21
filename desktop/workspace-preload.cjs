const { contextBridge, ipcRenderer } = require('electron');
const id = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new TypeError('A valid project identity is required.');
  return value;
};
const call = async (action, value) => {
  try { return await ipcRenderer.invoke('crew:workspaces', action, value); }
  catch (error) { throw new Error(String(error.message).replace(/^Error invoking remote method '[^']+': Error: /, '')); }
};
contextBridge.exposeInMainWorld('crewWorkspaces', Object.freeze({
  snapshot: () => call('snapshot'),
  select: value => call('select', id(value)),
  add: () => call('add'),
  rename: value => {
    if (!value || typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 100) throw new TypeError('Use a project name between 1 and 100 characters.');
    return call('rename', { id: id(value.id), name: value.name.trim() });
  },
  setWorkerLimit: value => {
    if (!Number.isSafeInteger(value) || value < 1 || value > 64) throw new TypeError('Choose a worker limit between 1 and 64.');
    return call('capacity', value);
  },
  subscribe: listener => {
    if (typeof listener !== 'function') throw new TypeError('A change listener is required.');
    const changed = (_event, snapshot) => listener(snapshot);
    ipcRenderer.on('crew:workspaces:changed', changed);
    return () => ipcRenderer.removeListener('crew:workspaces:changed', changed);
  }
}));
