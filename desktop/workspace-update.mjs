// crew#2: reserve an idle update across every workspace; this does not drain work.
import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
const label = (project, index) => typeof project?.name === 'string' && project.name.trim() ? project.name.trim() : `Workspace ${index + 1}`;
const messages = value => Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()) : [];
const detail = error => String(error?.message || error || 'unknown error');
const entries = projects => projects.map((project, index) => ({ name:label(project, index), host:project?.host }));

export async function workspaceUpdateActivity(projects) {
  if (!Array.isArray(projects) || !projects.length) return { safe:false, reasons:['Workspace activity is unavailable: no registered projects were supplied.'], notices:[] };
  const reasons = [], notices = [];
  for (const { name, host } of entries(projects)) {
    try {
      if (typeof host?.api !== 'function') throw new Error('Controller is unavailable.');
      const result = await host.api('update-activity');
      notices.push(...messages(result?.notices).map(notice => `${name}: ${notice}`));
      const blocked = messages(result?.reasons);
      if (blocked.length) reasons.push(...blocked.map(reason => `${name}: ${reason}`));
      else if (result?.safe !== true) reasons.push(`${name}: activity could not be verified.`);
    } catch {
      reasons.push(`${name}: controller activity unavailable. Open project setup and resolve it before updating.`);
    }
  }
  return { safe:reasons.length === 0, reasons, notices };
}

export async function reserveWorkspaceUpdate(projects, { setAdmissionPaused } = {}) {
  if (!Array.isArray(projects) || !projects.length) throw new Error('Cannot reserve an update without registered workspaces.');
  if (typeof setAdmissionPaused !== 'function') throw new Error('Global worker admission control is unavailable.');
  // Publish the durable global barrier before touching any project-local barrier.
  await setAdmissionPaused(true);
  const reserved = [];
  try {
    for (const project of entries(projects)) {
      const { name, host } = project;
      if (typeof host?.updateToken !== 'function') throw new Error(`${name}: controller is unavailable for update reservation.`);
      let result;
      try { result = await host.updateToken('update-prepare'); }
      catch (error) { throw new Error(`${name}: update reservation failed (${detail(error)}).`, { cause:error }); }
      if (result?.reserved !== true) {
        const reasons = messages(result?.reasons);
        throw new Error(`${name}: ${reasons.length ? reasons.join(' ') : 'update reservation was not confirmed.'}`);
      }
      reserved.push(project);
    }
    return { reserved:true };
  } catch (error) {
    const failures = [];
    // Undo only barriers confirmed by this attempt, in reverse acquisition order.
    for (const { name, host } of reserved.reverse()) {
      try {
        const result = await host.updateToken('update-cancel');
        if (result?.reserved !== false) throw new Error('cancellation was not confirmed');
      } catch (cancelError) { failures.push(`${name}: update cancellation could not be confirmed (${detail(cancelError)}).`); }
    }
    if (!failures.length) {
      try { await setAdmissionPaused(false); }
      catch (resumeError) { failures.push(`Global worker admission could not be resumed (${detail(resumeError)}).`); }
    }
    if (failures.length) throw new Error(`${detail(error)} ${failures.join(' ')} Global worker admission remains paused; resolve update cancellation before admitting more work.`, { cause:error });
    // The journal owner may remove its pending record only with this confirmation.
    error.workspaceReservationRollbackConfirmed = true;
    throw error;
  }
}


const processAlive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
};
const validVersion = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,99}$/.test(value);
const validProjectId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value);
async function journalWrite(path, value) {
  await mkdir(dirname(path), { recursive:true, mode:0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync(); await handle.close(); handle = undefined;
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await handle?.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
async function journalRemove(path) {
  await unlink(path);
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export function createWorkspaceUpdateReservation({ path, currentVersion, projects, setAdmissionPaused, ownerAlive = processAlive } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw new Error('Idle-update journal needs an absolute private file path.');
  if (!validVersion(currentVersion) || typeof projects !== 'function' || typeof setAdmissionPaused !== 'function' || typeof ownerAlive !== 'function') throw new Error('Idle-update recovery configuration is invalid.');
  const currentProjects = async () => {
    const value = await projects();
    if (!Array.isArray(value) || !value.length || value.some(project => !validProjectId(project?.id)) || new Set(value.map(project => project.id)).size !== value.length) throw new Error('Idle-update project identities are unavailable or duplicated.');
    return value;
  };
  const read = async () => {
    let bytes;
    try { bytes = await readFile(path, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Idle-update journal cannot be read. Preserve the admission pause and inspect its private storage.', { cause:error }); }
    try { const value = JSON.parse(bytes); if (value === null || typeof value !== 'object') throw new Error('Invalid journal object'); return value; }
    catch (error) { throw new Error('Idle-update journal is malformed. Preserve the admission pause and inspect its private storage.', { cause:error }); }
  };
  const validate = (journal, current) => {
    if (!journal || typeof journal !== 'object' || Array.isArray(journal) || Object.keys(journal).some(key => !['version', 'ownerPid', 'targetVersion', 'projectIds'].includes(key)) || journal.version !== 1 || !Number.isSafeInteger(journal.ownerPid) || journal.ownerPid < 1 || !validVersion(journal.targetVersion) || !Array.isArray(journal.projectIds) || !journal.projectIds.length || journal.projectIds.some(id => !validProjectId(id)) || new Set(journal.projectIds).size !== journal.projectIds.length) throw new Error('Idle-update journal is malformed. Admission remains paused until its ownership is reviewed.');
    if (journal.projectIds.length !== current.length || current.some(project => !journal.projectIds.includes(project.id))) throw new Error('Idle-update journal belongs to a different set of projects. Admission remains paused; review the retained project identities.');
  };
  const ownerIsAlive = async journal => {
    try { return (await ownerAlive(journal.ownerPid)) !== false; }
    catch { return true; }
  };
  // Only one parent mutates this journal. Queue native callbacks within that owner.
  let tail = Promise.resolve();
  const enqueue = operation => {
    const result = tail.then(operation); tail = result.catch(() => {}); return result;
  };
  return {
    prepare:targetVersion => enqueue(async () => {
      if (!validVersion(targetVersion)) throw new Error('Idle-update target version is invalid.');
      if (await read()) throw new Error('A previous idle-update reservation is still pending. Recover or cancel it before preparing another update.');
      const current = await currentProjects();
      const journal = { version:1, ownerPid:process.pid, targetVersion, projectIds:current.map(project => project.id) };
      await journalWrite(path, journal);
      try { return await reserveWorkspaceUpdate(current, { setAdmissionPaused }); }
      catch (error) {
        if (error.workspaceReservationRollbackConfirmed === true) {
          try { await journalRemove(path); }
          catch (removeError) { throw new Error(`${detail(error)} Its completed rollback journal could not be removed (${detail(removeError)}).`, { cause:error }); }
        }
        throw error;
      }
    }),
    cancel:() => enqueue(async () => {
      const journal = await read();
      if (!journal) return { canceled:false };
      const current = await currentProjects(); validate(journal, current);
      if (journal.ownerPid !== process.pid && await ownerIsAlive(journal)) throw new Error('Another live Crew process owns this idle-update reservation. Admission remains paused.');
      const failures = [];
      for (const [index, project] of current.entries()) {
        const name = label(project, index);
        try {
          if (typeof project.host?.updateToken !== 'function') throw new Error('controller is unavailable');
          const result = await project.host.updateToken('update-cancel');
          if (result?.reserved !== false) throw new Error('cancellation was not confirmed');
        } catch (error) { failures.push(`${name}: ${detail(error)}`); }
      }
      if (failures.length) throw new Error(`Idle-update cancellation is unconfirmed. ${failures.join('; ')}. Global worker admission remains paused.`);
      await setAdmissionPaused(false);
      await journalRemove(path);
      return { canceled:true };
    }),
    recover:() => enqueue(async () => {
      let journal;
      try { journal = await read(); }
      catch (error) {
        try { await setAdmissionPaused(true); }
        catch (pauseError) { return { recovered:false, blocked:true, error:`${detail(error)} Global admission pause could not be confirmed (${detail(pauseError)}).` }; }
        return { recovered:false, blocked:true, error:detail(error) };
      }
      if (!journal) return { recovered:false };
      try {
        await setAdmissionPaused(true);
        const current = await currentProjects(); validate(journal, current);
        if (await ownerIsAlive(journal)) throw new Error('A live Crew process still owns this idle-update reservation. Admission remains paused.');
        if (journal.targetVersion !== currentVersion) throw new Error(`Idle update targeted ${journal.targetVersion}, but this app is ${currentVersion}. Admission remains paused; finish the intended update or review its retained reservation.`);
        const activity = await workspaceUpdateActivity(current);
        if (!activity.safe) throw new Error(`Idle-update recovery cannot verify every project is idle. ${activity.reasons.join(' ')} Admission remains paused.`);
        await setAdmissionPaused(false);
        await journalRemove(path);
        return { recovered:true };
      } catch (error) { return { recovered:false, blocked:true, error:detail(error) }; }
    })
  };
}
