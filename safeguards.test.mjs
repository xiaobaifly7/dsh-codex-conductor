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

const { apply, hasUserReply } = await import('./index.mjs');
const { pidReused, validatePanelSettings } = await import('./runtime.mjs');

const exec = (id = 'S1', cwd = '/repo', log = []) => ({ agent: { id, session: { header: { cwd }, log } } });
function load(config, run) {
  const tools = {}, warnings = [], calls = [];
  apply({ tools: { register: tool => tools[tool.name] = tool, guard() {} }, on() {}, logger: { warn: text => warnings.push(text) } },
    config, async (_cfg, argv) => { calls.push(argv); return run(argv); });
  return { tools, warnings, calls };
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
  assert.equal(pidReused(child.pid, new Date(Date.now() - 3_600_000).toISOString()), true);
  assert.equal(pidReused(child.pid, new Date(Date.now() + 3_600_000).toISOString()), false);
  const marker = path.join(localAppData, 'dsh-codex-conductor', 'loaded.json');
  writeFileSync(marker, JSON.stringify({ module: 'file:///C:/old/index.mjs', loadedAt: new Date(Date.now() - 3_600_000).toISOString(), pid: child.pid }));
  load({}, () => ({ jobs: [], total: 0 }));
  assert.equal(JSON.parse(readFileSync(marker, 'utf8')).pid, process.pid);
});
