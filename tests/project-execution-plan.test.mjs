import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { discoverProjectExecutionPlan, parseProjectEnvironmentToml, parseProjectNetworkAccess } from '../runtime/project-execution-plan.mjs';

const run = promisify(execFile);
const environment = `# shared developer tooling\nversion = 1\nname = "Example"\n[setup]\nscript = "./tools/dev up --skip-tests"\n[[actions]]\nname = "Start"\nicon = "run"\ncommand = '''\n./tools/dev up --force --deps-only\n\nNX_TUI=false npx nx run-many -t serve -p api web -- --host=0.0.0.0\n'''\n`;
async function fixture(t, content = environment) {
  const dir = await mkdtemp(join(tmpdir(), 'crew-plan-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = join(dir, 'Project With Spaces');
  await mkdir(join(repo, '.codex/environments'), { recursive: true });
  await writeFile(join(repo, '.codex/environments/environment.toml'), content);
  const git = args => run('git', ['-C', repo, ...args]);
  await git(['init', '-b', 'main']);
  async function commit() {
    await git(['add', '.']);
    await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
    return (await git(['rev-parse', 'HEAD'])).stdout.trim();
  }
  return { dir, repo, git, commit };
}

test('literal multiline commands retain exact text and actions have no invented role', () => {
  const result = parseProjectEnvironmentToml(environment);
  assert.equal(result.setup.command, './tools/dev up --skip-tests');
  assert.equal(result.actions[0].command, './tools/dev up --force --deps-only\n\nNX_TUI=false npx nx run-many -t serve -p api web -- --host=0.0.0.0\n');
  assert.equal(result.actions[0].name, 'Start');
});

test('bounded TOML string semantics support escapes, hashes, CRLF and multiline folding', () => {
  const result = parseProjectEnvironmentToml('[setup]\r\nscript = """\r\necho \\"hello\\" # literal\\n\\u263a \\\r\n  continued\r\n""" # comment\r\n');
  assert.equal(result.setup.command, 'echo "hello" # literal\n☺ continued\n');
  assert.equal(parseProjectEnvironmentToml("[setup]\nscript = 'echo C:\\work # plain'\n").setup.command, 'echo C:\\work # plain');
});

test('unsupported or malformed TOML never becomes a partial executable plan', () => {
  for (const text of [
    '[setup]\nscript = "okay"\n[unknown]\nvalue = "x"',
    '[setup]\nscript = "first"\nscript = "second"',
    '[[actions]]\nname = "Start"\ncommand = ["echo", "x"]',
    '[setup]\nscript = "unterminated',
    '[[actions]]\nname = "Start"',
    '[setup]\nscript = "echo \\q"',
  ]) assert.throws(() => parseProjectEnvironmentToml(text), /TOML/);
});

test('pinned Git source ignores working changes, records byte hash and reads linked instructions', async t => {
  const f = await fixture(t);
  await mkdir(join(f.repo, 'docs'), { recursive: true });
  await mkdir(join(f.repo, '.claude/skills/local-start'), { recursive: true });
  await writeFile(join(f.repo, 'AGENTS.md'), 'Read [development](docs/development.md).\n');
  await writeFile(join(f.repo, 'CLAUDE.md'), '@AGENTS.md\nUse the shared developer commands.\n');
  await writeFile(join(f.repo, 'docs/development.md'), 'Run `./tools/dev up`; do not invent a replacement.\n');
  await writeFile(join(f.repo, '.claude/skills/local-start/SKILL.md'), 'Use `./tools/dev up`.\n');
  const commit = await f.commit();
  const before = (await f.git(['status', '--porcelain'])).stdout;
  await writeFile(join(f.repo, '.codex/environments/environment.toml'), '[setup]\nscript = "touch SHOULD_NOT_RUN"\n');
  const dirtyBefore = (await f.git(['status', '--porcelain'])).stdout;
  const result = await discoverProjectExecutionPlan({ path: f.repo, ref: commit });
  assert.equal(result.status, 'discovered');
  assert.equal(result.repository.commit, commit);
  assert.equal(result.setup.command, './tools/dev up --skip-tests');
  assert.equal(result.actions[0].role, null);
  assert.equal(result.setup.source.sha256, createHash('sha256').update(environment).digest('hex'));
  assert.ok(result.instructions.some(source => source.path === 'docs/development.md'));
  assert.ok(result.instructions.some(source => source.path === '.claude/skills/local-start/SKILL.md'));
  assert.equal(before, '');
  assert.equal((await f.git(['status', '--porcelain'])).stdout, dirtyBefore);
  await assert.rejects(readFile(join(f.repo, 'SHOULD_NOT_RUN')), /ENOENT/);
});

test('named environment ambiguity is explicit; a committed file can be selected', async t => {
  const f = await fixture(t);
  await writeFile(join(f.repo, '.codex/environments/alternative.toml'), '[setup]\nscript = "other command"');
  await f.commit();
  const ambiguous = await discoverProjectExecutionPlan({ path: f.repo, ref: 'main' });
  assert.equal(ambiguous.setup, null);
  assert.equal(ambiguous.status, 'incomplete');
  assert.ok(ambiguous.issues.some(issue => /Multiple/.test(issue.detail)));
  const selected = await discoverProjectExecutionPlan({ path: f.repo, ref: 'main', environmentPath: '.codex/environments/environment.toml' });
  assert.equal(selected.setup.command, './tools/dev up --skip-tests');
  const outside = await discoverProjectExecutionPlan({ path: f.repo, ref: 'main', environmentPath: '../outside.toml' });
  assert.equal(outside.status, 'incomplete');
});

test('committed symlinks and oversized instruction files are not followed or retained', async t => {
  const f = await fixture(t);
  await writeFile(join(f.dir, 'outside.md'), 'PRIVATE OUTSIDE FILE');
  await symlink(join(f.dir, 'outside.md'), join(f.repo, 'AGENTS.md'));
  await writeFile(join(f.repo, 'CLAUDE.md'), 'x'.repeat(128 * 1024 + 1));
  await f.commit();
  const result = await discoverProjectExecutionPlan({ path: f.repo, ref: 'main' });
  assert.deepEqual(result.instructions, []);
  assert.ok(result.issues.some(issue => issue.path === 'AGENTS.md' && /regular/.test(issue.detail)));
  assert.ok(result.issues.some(issue => issue.path === 'CLAUDE.md' && /limit/.test(issue.detail)));
  assert.ok(!JSON.stringify(result).includes('PRIVATE OUTSIDE FILE'));
});

test('malformed environment remains incomplete while instructions remain available', async t => {
  const f = await fixture(t, '[setup]\nscript = "valid prefix"\n[[actions]]\ncommand = ["invalid"]');
  await writeFile(join(f.repo, 'AGENTS.md'), 'Use project instructions.');
  await f.commit();
  const result = await discoverProjectExecutionPlan({ path: f.repo, ref: 'main' });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.setup, null);
  assert.deepEqual(result.actions, []);
  assert.equal(result.instructions.length, 1);
  assert.ok(result.issues.some(issue => /TOML/.test(issue.detail)));
});

test('invalid refs are rejected option-safely without modifying Git state', async t => {
  const f = await fixture(t); await f.commit();
  for (const ref of ['--help', 'missing', 'main\nHEAD']) {
    await assert.rejects(discoverProjectExecutionPlan({ path: f.repo, ref }));
  }
  assert.equal((await f.git(['status', '--porcelain'])).stdout, '');
});


test('repository subfolders resolve full-tree sources and escaped NUL commands fail closed', async t => {
  const f = await fixture(t); await f.commit();
  const result = await discoverProjectExecutionPlan({ path: join(f.repo, '.codex'), ref: 'main' });
  assert.equal(result.setup.command, './tools/dev up --skip-tests');
  assert.equal(result.repository.path, await realpath(f.repo));
  assert.throws(() => parseProjectEnvironmentToml('[setup]\nscript = "echo \\u0000"'), /nonempty/);
});


test('only the explicit permission section boolean enables or disables network', () => {
  assert.equal(parseProjectNetworkAccess('[sandbox_workspace_write]\nnetwork_access = true # explicit'), true);
  assert.equal(parseProjectNetworkAccess('[sandbox_workspace_write]\nnetwork_access = false'), false);
  assert.equal(parseProjectNetworkAccess('[other]\nnetwork_access = true'), null);
  assert.equal(parseProjectNetworkAccess('# [sandbox_workspace_write]\n# network_access = true'), null);
  assert.equal(parseProjectNetworkAccess('description = """\n[sandbox_workspace_write]\nnetwork_access = true\n"""'), null);
  assert.equal(parseProjectNetworkAccess('description = "quoted # comment"\n[sandbox_workspace_write]\nnetwork_access = true'), true);
  for (const value of ['"true"', '1', 'true trailing', 'true\nnetwork_access = false']) {
    assert.throws(() => parseProjectNetworkAccess('[sandbox_workspace_write]\nnetwork_access = ' + value), /boolean/);
  }
  assert.throws(() => parseProjectNetworkAccess('description = "unterminated'), /Unterminated/);
});

test('permission discovery pins committed config and hashes it without reading ignored local policy', async t => {
  const f = await fixture(t); const beforePolicy = await f.commit();
  const policy = '[sandbox_workspace_write]\nnetwork_access = false # intentionally offline\n';
  await writeFile(join(f.repo, '.codex/config.toml'), policy);
  await f.commit();
  await writeFile(join(f.repo, '.codex/config.toml'), '[sandbox_workspace_write]\nnetwork_access = true');
  const result = await discoverProjectExecutionPlan({ path: f.repo, ref: 'main' });
  assert.equal(result.networkAccess, false);
  assert.equal(result.sources.find(s => s.path === '.codex/config.toml').sha256, createHash('sha256').update(policy).digest('hex'));
  const missing = await discoverProjectExecutionPlan({ path: f.repo, ref: beforePolicy });
  assert.equal(missing.networkAccess, null);
  assert.ok(missing.issues.some(i => /No committed Codex permission/.test(i.detail)));
});

test('malformed committed permission is unknown without discarding valid commands', async t => {
  const f = await fixture(t);
  await writeFile(join(f.repo, '.codex/config.toml'), '[sandbox_workspace_write]\nnetwork_access = "true"');
  await f.commit();
  const result = await discoverProjectExecutionPlan({ path: f.repo, ref: 'main' });
  assert.equal(result.networkAccess, null);
  assert.equal(result.status, 'discovered');
  assert.ok(result.issues.some(i => i.path === '.codex/config.toml' && /boolean/.test(i.detail)));
});


test('explicit local client network policy is separate from committed command provenance', async t => {
  const f = await fixture(t); await f.commit();
  const policy = '[sandbox_workspace_write]\nnetwork_access = true # explicit client choice\n';
  await writeFile(join(f.repo, '.codex/config.toml'), policy);
  const result = await discoverProjectExecutionPlan({ path: f.repo, ref: 'main' });
  assert.equal(result.networkAccess, null);
  assert.equal(result.localPermissions.networkAccess, true);
  assert.equal(result.localPermissions.source.path, join(await realpath(f.repo), '.codex/config.toml'));
  assert.equal(result.localPermissions.source.sha256, createHash('sha256').update(policy).digest('hex'));
  assert.ok(!result.sources.some(source => source.path === '.codex/config.toml'));
  assert.deepEqual(Object.keys(result.localPermissions), ['networkAccess', 'source']);
});

test('local permission symlinks are refused without following external files', async t => {
  const f = await fixture(t); await f.commit();
  await writeFile(join(f.dir, 'external-policy.toml'), '[sandbox_workspace_write]\nnetwork_access = true');
  await symlink(join(f.dir, 'external-policy.toml'), join(f.repo, '.codex/config.toml'));
  const result = await discoverProjectExecutionPlan({ path: f.repo, ref: 'main' });
  assert.equal(result.localPermissions.networkAccess, null);
  assert.equal(result.localPermissions.source, null);
  assert.ok(result.issues.some(issue => /symlink/.test(issue.detail)));
});
