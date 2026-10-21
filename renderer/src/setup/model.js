import { selectExecutionPlan } from '../../../desktop/execution-selection.mjs';

export const steps = ['Welcome', 'Local tools', 'ChatGPT & tools', 'Project', 'Permissions', 'Summary'];

export function environmentChoices(snapshot) {
  const saved = snapshot?.config?.project?.worker?.environment || {};
  const options = snapshot?.workerEnvironmentOptions || [];
  const option = options[0];
  const available = options.length === 1 && option.status === 'available';
  const choices = [{ value: 'none', label: 'Separate worktree only' }];
  let selected = 'none';
  if (available) {
    choices.push({ value: 'project', label: option.plan.start ? 'Use existing project setup and Start action' : 'Use existing project setup', disabled: !option.plan.setup && !option.plan.start });
    if (saved.executionPlan) selected = 'project';
    for (const [index, action] of (option.actions || []).entries()) {
      if (action.command === option.plan.start?.command) continue;
      const value = `action:${index}`;
      choices.push({ value, label: `Project action: ${action.name}` });
      if (saved.executionPlan?.start?.command === action.command) selected = value;
    }
  }
  if ((saved.executionPlan && !available) || (Object.keys(saved).length && !saved.executionPlan)) {
    choices.push({ value: 'custom', label: saved.executionPlan ? 'Saved project execution settings' : 'Existing environment settings' });
    selected = 'custom';
  }
  return { choices, selected, detail: options.map(item => item.detail).filter((value, index, all) => value && all.indexOf(value) === index).join(' ') || 'Choose a project folder and starting branch to read its execution instructions.' };
}

export function collectConfig(draft, snapshot, selection) {
  if (!draft || !snapshot?.config) throw new Error('Reload your saved settings before making changes.');
  const config = structuredClone(draft);
  config.runtime.codexBinary = config.runtime.codexBinary?.trim() || null;
  config.runtime.port = Number(config.runtime.port);
  config.runtime.dataDir = config.runtime.dataDir.trim();
  for (const key of ['id', 'name', 'context']) config.project[key] = config.project[key].trim();
  config.project.worker.maxConcurrent = Number(config.project.worker.maxConcurrent ?? 2);
  if (selection !== 'custom') {
    if (selection === 'project' || selection.startsWith('action:')) {
      const option = snapshot.workerEnvironmentOptions?.[0];
      const action = selection.startsWith('action:') ? option?.actions?.[Number(selection.slice(7))] : null;
      if (!option?.plan || (selection.startsWith('action:') && !action)) throw new Error('Project execution options changed. Reload saved settings before selecting an environment.');
      config.project.worker.environment = { executionPlan: selectExecutionPlan({ discovered: option.plan, saved: snapshot.config.project.worker.environment?.executionPlan, action }) };
    } else config.project.worker.environment = {};
  }
  for (const key of ['manager', 'worker']) config.project.prompts[key] = config.project.prompts[key].trim();
  for (const key of ['teamKey', 'teamId', 'projectId']) config.project.linear[key] = config.project.linear[key]?.trim() || null;
  if (config.project.mode === 'fixture') config.project.repositories = [];
  return config;
}

export function readableDetail(detail = '') {
  return detail.replace(/Confirm and set project\.linear\.teamId[^.]*\./g, 'Choose your Linear team, or connect it later.')
    .replace(/Confirm and set project\.linear\.teamKey[^.]*\./g, 'Choose your Linear team.')
    .replace(/Set an explicit baseRef for repository "([^"]+)"\./g, 'Choose a starting branch for $1.');
}
