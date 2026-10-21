// crew#2: preflight physical project boundaries before a controller or config changes.
import { readFile, realpath } from 'node:fs/promises';
import { dirname, basename, resolve, join, relative, isAbsolute, sep } from 'node:path';

const fail = message => { throw new Error(`Workspace isolation: ${message}`); };
function pathText(value, label) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value) || value.length > 4096 || value.startsWith('~') || /\$\{|%[A-Z_]+%/.test(value)) fail(`${label} must be a real local path.`);
  return value;
}
async function canonical(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT') fail(`Cannot verify the physical path ${path} (${error.code || 'read failed'}).`);
    const parent = dirname(path);
    return parent === path ? path : join(await canonical(parent), basename(path));
  }
}
function contains(parent, child) {
  const rel = relative(parent, child);
  return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
const overlap = (left, right) => contains(left, right) || contains(right, left);

export async function assertWorkspaceIsolation({ projects, candidate } = {}) {
  if (!Array.isArray(projects) || !projects.length) fail('Registered project list is missing.');
  const ids = new Set();
  for (const project of projects) {
    if (!project || typeof project.id !== 'string' || !project.id || ids.has(project.id)) fail('Registered project identities are missing or duplicated.');
    ids.add(project.id);
    pathText(project.configPath, 'Configuration');
    if (!isAbsolute(project.configPath)) fail('Registered configuration paths must be absolute.');
  }
  if (candidate && (!ids.has(candidate.id) || !candidate.config || candidate.configPath !== projects.find(project => project.id === candidate.id)?.configPath)) fail('Candidate must match a registered project and configuration path.');
  const summaries = [];
  for (const project of projects) {
    const configPath = resolve(project.configPath), base = dirname(configPath);
    let raw;
    try { raw = candidate?.id === project.id ? candidate.config : JSON.parse(await readFile(configPath, 'utf8')); }
    catch (error) { fail(`Cannot read configuration for ${project.id} (${error instanceof SyntaxError ? 'invalid JSON' : error.code || 'read failed'}). Resolve it before starting a project.`); }
    const port = raw?.runtime?.port;
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) fail(`Project ${project.id} needs a port between 1024 and 65535.`);
    const dataDir = resolve(base, pathText(raw?.runtime?.dataDir, `State folder for ${project.id}`));
    if (dataDir === dirname(dataDir)) fail(`Project ${project.id} needs a dedicated state folder.`);
    const prompts = raw?.project?.prompts;
    const [physicalConfigPath, physicalDataDir, managerPrompt, workerPrompt] = await Promise.all([
      canonical(configPath), canonical(dataDir),
      canonical(resolve(base, pathText(prompts?.manager, `Manager instructions for ${project.id}`))),
      canonical(resolve(base, pathText(prompts?.worker, `Worker instructions for ${project.id}`)))
    ]);
    summaries.push({ id:project.id, configPath, port, dataDir, physicalConfigPath, physicalDataDir, promptPaths:{ manager:managerPrompt, worker:workerPrompt } });
  }
  for (let i = 0; i < summaries.length; i++) {
    const left = summaries[i];
    for (const right of summaries.slice(i + 1)) {
      const pair = `Projects ${left.id} and ${right.id}`;
      if (left.port === right.port) fail(`${pair} share port ${left.port}. Choose separate project ports.`);
      if (left.physicalConfigPath === right.physicalConfigPath) fail(`${pair} share a configuration file. Keep separate configurations.`);
      if (overlap(left.physicalDataDir, right.physicalDataDir)) fail(`${pair} share or nest state folders. Choose separate state folders.`);
      if (contains(left.physicalDataDir, right.physicalConfigPath) || contains(right.physicalDataDir, left.physicalConfigPath)) fail(`${pair} place a configuration inside the other project's state folder.`);
      const leftPrompts = Object.values(left.promptPaths), rightPrompts = Object.values(right.promptPaths);
      if (leftPrompts.some(path => rightPrompts.includes(path))) fail(`${pair} share instruction files. Keep each project's manager and worker instructions separate.`);
      if (rightPrompts.some(path => contains(left.physicalDataDir, path)) || leftPrompts.some(path => contains(right.physicalDataDir, path))) fail(`${pair} place instructions inside the other project's state folder.`);
    }
  }
  return summaries;
}
