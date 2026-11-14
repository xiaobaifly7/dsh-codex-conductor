import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// apply() writes its load marker and planner template under %LOCALAPPDATA%.
const localAppData = mkdtempSync(path.join(tmpdir(), 'conductor-safeguards-'));
process.env.LOCALAPPDATA = localAppData;
test.after(() => rmSync(localAppData, { recursive: true, force: true }));

const { apply, composePrompt, hasUserReply } = await import('./index.mjs');
const { pidReused, saveRuntimeSettings, validatePanelSettings } = await import('./runtime.mjs');

const exec = (id = 'S1', cwd = '/repo', log = []) => ({ agent: { id, session: { header: { cwd }, log } } });
function load(config, run) {
  const tools = {}, warnings = [], calls = [], inputs = [];
  apply({ tools: { register: tool => tools[tool.name] = tool, guard() {} }, on() {}, logger: { warn: text => warnings.push(text) } },
    config, async (_cfg, argv, options) => { calls.push(argv); inputs.push(options?.stdin); return run(argv); });
  return { tools, warnings, calls, inputs };
}

test('the automatic restart notice is not a user reply', () => {
  const notice = 'Harness 已重启，接着上次中断的地方继续。';
  const message = text => ({ type: 'user/message', time: 12_000, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } });
  const job = { job_id: 'J1', finished_at: 10 };
  assert.equal(hasUserReply([message(notice)], job, 'S1', notice), false);
  assert.equal(hasUserReply([message('用方案 A'), message(notice)], job, 'S1', notice), true);
  assert.equal(hasUserReply([message(notice)], job, 'S1'), true);
});

test('unknown configuration keys are reported in the log and the load marker', () => {
  const { warnings } = load({ workspace: ['/repo'] }, () => ({ jobs: [], total: 0 }));
  assert.ok(warnings.some(text => /未知配置项 workspace/.test(text)));
  const marker = JSON.parse(readFileSync(path.join(localAppData, 'dsh-codex-conductor', 'loaded.json'), 'utf8'));
  assert.deepEqual(marker.unknownConfig, ['workspace']);
});

test('maxRunningJobs refuses a dispatch at the limit without starting Codex', async () => {
  const run = argv => argv[0] === 'list' ? { jobs: [], total: argv.includes('--status') ? 2 : 0 }
    : { job_id: 'J1', status: 'completed', cwd: '/repo' };
  const args = { task: 'Inspect the repository layout.', acceptance: ['Layout is reported'], write: false };
  const full = load({ maxRunningJobs: 2 }, run);
  await assert.rejects(full.tools.codex_run.execute(args, exec()), /maxRunningJobs=2.*未启动 Codex/);
  assert.ok(!full.calls.some(argv => argv[0] === 'start'));
  const free = load({ maxRunningJobs: 3 }, run);
  assert.equal((await free.tools.codex_run.execute(args, exec())).job_id, 'J1');
  const unlimited = load({}, run);
  await unlimited.tools.codex_run.execute(args, exec());
  assert.ok(!unlimited.calls.some(argv => argv[0] === 'list' && argv.includes('--status')));
});

test('codex_cancel leaves another session\'s job alone', async () => {
  const { tools, calls } = load({}, argv => argv[0] === 'status'
    ? { job_id: argv[1], status: 'running', context: { owner: argv[1] === 'mine' ? 'S1' : argv[1] === 'legacy' ? null : 'S2' } }
    : { job_id: argv[1], status: 'cancelled' });
  await assert.rejects(tools.codex_cancel.execute({ job_id: 'theirs' }, exec()), /属于另一个会话，未取消/);
  assert.ok(!calls.some(argv => argv[0] === 'cancel'));
  for (const id of ['mine', 'legacy']) assert.equal((await tools.codex_cancel.execute({ job_id: id }, exec())).status, 'cancelled');
});

test('a repaired final report says so in the receipt', async () => {
  const report = { summary: 'done', criteria: [{ criterion: '1. ok', status: 'met', evidence: 'D:/a' }],
    files_changed: [], deviations: [], unresolved: [], blockers: [] };
  const { tools } = load({}, argv => ({ job_id: argv[1], status: 'completed', cwd: '/repo', log_dir: '/jobs/J1',
    structured: report, final_message_repaired: ['invalid_escape'] }));
  const value = await tools.codex_status.execute({ job_id: 'J1' }, exec());
  assert.match(tools.codex_status.output.render({}, value)[0].text, /转义修复（invalid_escape）.*\/jobs\/J1\/last_message\.txt/);
});

test('codex_runtime doctor forwards the runner self-check', async () => {
  const { tools, calls } = load({}, () => ({ status: 'completed', ok: true, checks: [{ name: 'python', ok: true, detail: '3.12' }] }));
  assert.equal((await tools.codex_runtime.execute({ action: 'doctor' }, exec())).ok, true);
  assert.deepEqual(calls, [['doctor']]);
});

test('products mode keeps gemini_write sources inside the workspace', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'conductor-sources-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'conductor-outside-'));
  t.after(() => { for (const dir of [root, outside]) rmSync(dir, { recursive: true, force: true }); });
  writeFileSync(path.join(outside, 'raw.md'), '原料');
  const spawns = [];
  const make = plannerReads => {
    const tools = {};
    apply({ tools: { register: tool => tools[tool.name] = tool, guard() {} }, on() {} },
      { workspaces: [root], plannerReads, gemini: { command: 'C:\\agy\\agy.exe' } },
      async () => ({ jobs: [], total: 0 }), (...args) => { spawns.push(args); throw new Error('spawn reached'); });
    return tools.gemini_write.execute({ prompt: '根据素材写第一章入门说明。', sources: [path.join(outside, 'raw.md')], output: 'chapter.md' }, exec('S1', root));
  };
  const refused = await make('products');
  assert.equal(refused.status, 'failed');
  assert.match(refused.error, /sources 超出本会话允许读取的范围/);
  assert.equal(spawns.length, 0);
  assert.doesNotMatch((await make('open')).error, /超出本会话允许读取的范围/);
});

test('the panel may clear the model and effort overrides', () => {
  assert.deepEqual(validatePanelSettings({ model: '', effort: '' }), { model: '', effort: '' });
  assert.throws(() => validatePanelSettings({ model: 'bad model' }));
});

test('a load marker held by a recycled PID is replaced', { skip: process.platform !== 'win32' }, async t => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => child.kill());
  const old = new Date(Date.now() - 3_600_000).toISOString();
  // A cold PowerShell on a CI runner can take longer than the 5 s the plugin allows itself at load.
  assert.equal(pidReused(child.pid, old, 60_000), true);
  assert.equal(pidReused(child.pid, new Date(Date.now() + 3_600_000).toISOString(), 60_000), false);
  if (!pidReused(child.pid, old)) return t.diagnostic('PowerShell is too slow here for the load-time check; marker replacement not exercised');
  const marker = path.join(localAppData, 'dsh-codex-conductor', 'loaded.json');
  writeFileSync(marker, JSON.stringify({ module: 'file:///C:/old/index.mjs', loadedAt: old, pid: child.pid }));
  load({}, () => ({ jobs: [], total: 0 }));
  assert.equal(JSON.parse(readFileSync(marker, 'utf8')).pid, process.pid);
});

test('the fixed executor requirements ride along with every handoff', async () => {
  assert.doesNotMatch(composePrompt('Inspect the layout.', ['Reported']), /用户的固定要求/);
  const file = path.join(localAppData, 'dsh-codex-conductor', 'executor-prompt.md');
  const { tools, inputs } = load({}, argv => argv[0] === 'list' ? { jobs: [], total: 0 } : { job_id: 'J1', status: 'completed', cwd: '/repo' });
  assert.match(readFileSync(file, 'utf8'), /^<!--/);
  const args = { task: 'Inspect the repository layout.', acceptance: ['Layout is reported'], write: false };
  await tools.codex_run.execute(args, exec());
  assert.doesNotMatch(JSON.parse(inputs.at(-1)).prompt, /用户的固定要求/);
  writeFileSync(file, '<!-- note -->\n提交信息用英文。\n');
  await tools.codex_run.execute(args, exec());
  const prompt = JSON.parse(inputs.at(-1)).prompt;
  assert.match(prompt, /## 用户的固定要求\n[^\n]*不增加权限[^\n]*\n提交信息用英文。\n\n## 最后汇报/);
  assert.doesNotMatch(prompt, /note/);
  writeFileSync(file, '');
});

test('gemini_write leaves one history line per call for the panel', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'conductor-history-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'notes.md'), '素材');
  const tools = {};
  apply({ tools: { register: tool => tools[tool.name] = tool, guard() {} }, on() {} }, { gemini: { command: 'C:\\agy\\agy.exe' } },
    async () => ({ jobs: [], total: 0 }), () => { throw new Error('spawn unavailable'); });
  const value = await tools.gemini_write.execute({ prompt: '根据素材写第一章入门说明。', sources: ['notes.md'], output: 'chapter.md' }, exec('S1', root));
  assert.equal(value.status, 'failed');
  const lines = readFileSync(path.join(localAppData, 'dsh-codex-conductor', 'gemini-history.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const last = lines.at(-1);
  assert.deepEqual([last.session, last.status, last.output], ['S1', 'failed', value.output]);
  assert.match(last.error, /spawn unavailable/);
});

test('the panel can clear limits and switch auto resume in the profile', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'conductor-profile-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const moduleUrl = 'file:///C:/plugins/conductor/index.mjs';
  const profileFile = path.join(dir, 'cordis.patch.yml');
  const save = (config, changes) => {
    writeFileSync(profileFile, `plugins:\n  - id: codex-conductor\n    name: ${moduleUrl}\n${config}`);
    saveRuntimeSettings({ moduleUrl, profileFile, changes });
    return readFileSync(profileFile, 'utf8').split('\n').slice(3).join('\n');
  };
  assert.equal(save('    config:\n      maxStorageMb: 500\n', { maxStorageMb: null, retries: 0, maxRunningJobs: 3 }),
    '    config:\n      retries: 0\n      maxRunningJobs: 3\n      maxStorageMb: null\n');
  assert.equal(save('    config:\n      model: m\n', { autoResume: { enabled: false } }),
    '    config:\n      autoResume:\n        enabled: false\n      model: m\n');
  assert.equal(save('    config:\n      autoResume:\n        maxAgeHours: 6\n        enabled: true\n', { autoResume: { enabled: false } }),
    '    config:\n      autoResume:\n        maxAgeHours: 6\n        enabled: false\n');
  assert.equal(save('', { autoResume: { enabled: false } }), '    config:\n      autoResume:\n        enabled: false\n');
  assert.throws(() => save('    config:\n      autoResume: { enabled: true }\n', { autoResume: { enabled: false } }), /分行 YAML/);
});
