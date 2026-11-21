import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { dispatch, execute, measure, modelTimings, platform, printTable, sampleCommand, sandboxPrefix, summarize } from './bench-live.mjs';

const state = fileURLToPath(new URL('../../state/', import.meta.url));
const driver = fileURLToPath(new URL('./bench_driver.py', import.meta.url));
const windows = process.platform === 'win32';

test('fixed sample counts, alternation, one framework retry and no extra C dispatch', async () => {
  const metric = { ok: true, metrics: { total_ms: 2 } };
  const samples = [];
  const modelOrder = [];
  let first = true;
  await measure(samples, (id, mode) => {
    if (first) { first = false; return { ok: false, error: 'fixture failure' }; }
    if (id === 'C.model') { modelOrder.push(mode); return { ok: false, error: 'model failure' }; }
    if (id === 'B.sandbox.search' && mode === 'wsl') return { skipped: true, reason: 'unsupported' };
    return metric;
  }, false);
  assert.equal(samples.length, 155);
  assert.deepEqual(modelOrder, Array.from({ length: 5 }, () => ['native', 'wsl']).flat());
  assert.equal(samples[0].attempts.length, 2);
  assert.equal(samples[0].retried, true);
  assert.ok(samples.filter(sample => sample.id === 'C.model').every(sample => sample.attempts.length === 1));
  assert.equal(summarize(samples).find(row => row.id === 'B.sandbox.search').wsl.skipped, 5);
  const noModel = [];
  await measure(noModel, id => { assert.notEqual(id, 'C.model'); return metric; }, true);
  assert.equal(noModel.length, 145);
  assert.equal(summarize(noModel).find(row => row.id === 'B.shell').wsl_over_native, 1);
});

test('sandbox argv follows platform help, including the older Linux workspace-write option', () => {
  const linux = { mode: 'wsl', codex: '/usr/bin/codex', cwd: '/mnt/d/work' };
  assert.deepEqual(sandboxPrefix('Usage: codex sandbox\n --permission-profile --cd', linux),
    ['/usr/bin/codex', 'sandbox', '--permission-profile', ':workspace', '-C', '/mnt/d/work', '--']);
  assert.deepEqual(sandboxPrefix('Commands: linux', linux, '--full-auto'),
    ['/usr/bin/codex', 'sandbox', 'linux', '--full-auto', '--']);
  assert.equal(sandboxPrefix('Commands: linux', linux, '--help'), null);
});

test('summary prints version stderr and explains an empty WSL layer', t => {
  const samples = [{ id: 'C.model', mode: 'wsl', status: 'skipped', attempts: [{ skipped: true, reason: 'Unavailable: node' }] }];
  const write = t.mock.method(process.stdout, 'write', () => true);
  try {
    printTable({ samples, summary: summarize(samples), errors: [],
      environment: { wsl: { versions: { node: { code: 127, stderr: 'bench: node: command not found' } } } } });
  } finally { write.mock.restore(); }
  const displayed = write.mock.calls.map(call => call.arguments[0]).join('');
  assert.match(displayed, /环境 \/ wsl node[^\n]*bench: node: command not found/);
  assert.match(displayed, /wsl C 层无数据：[^\n]*Unavailable: node/);
});

test('Windows real bridge with FAKE_CODEX, PowerShell argv, and actual timestamp forwarding', { skip: !windows }, async t => {
  assert.equal(path.relative(state, realpathSync.native(state)), '');
  const root = mkdtempSync(path.join(state, 'bench-test-'));
  t.after(() => {
    assert.equal(path.relative(root, realpathSync.native(root)), '');
    rmSync(root, { recursive: true });
  });
  const work = path.join(root, 'work');
  for (const name of ['work', 'codex-home', 'runner', 'tmp']) mkdirSync(path.join(root, name));
  const yaml = readFileSync(new URL('../config/cordis.patch.yml', import.meta.url), 'utf8');
  const settings = Object.fromEntries([...yaml.matchAll(/^ {8}(\w+): (.+)$/gm)].map(([, k, value]) => [k, value.trim()]));
  settings.pwsh = path.join(settings.pwshDir, 'pwsh.exe');
  const p = platform('native', settings, work, root, process.env);
  p.clock = { offset_ms: 0 };
  const fake = await dispatch(p, { task: 'Fake no-op', acceptance: ['Fake receipt'], write: false }, true);
  assert.equal(fake.ok, true, JSON.stringify(fake));
  assert.equal(fake.receipt.status, 'completed');
  assert.ok(fake.metrics.total_ms >= fake.metrics.dispatch_ms && fake.metrics.to_receipt_ms >= 0);
  const spans = ['dispatch_to_worker_birth_ms', 'worker_birth_to_attempt_ms', 'attempt_to_fake_entry_ms',
    'fake_entry_to_exit_ms', 'fake_exit_to_finalizing_ms', 'finalizing_to_receipt_ms', 'receipt_to_host_ms']
    .map(key => fake.metrics[key]);
  assert.ok(spans.every(Number.isFinite), JSON.stringify(fake.metrics));
  assert.equal(spans.reduce((total, span) => total + span, 0), fake.metrics.total_ms);

  const written = await sampleCommand(p, 'B.write', [], '.bench-files');
  assert.equal(written.ok, true, JSON.stringify(written));
  assert.match(written.result.stdout, /500 files x 4096 bytes/);
  assert.equal(existsSync(path.join(work, '.bench-files')), false);
  const missing = await p.direct(['nonexistent-conductor-bench-tool', '--version']);
  assert.notEqual(missing.code, 0);
  const help = await p.direct([p.codex, 'sandbox', '--help']);
  assert.equal(help.code, 0, JSON.stringify(help));
  const prefix = sandboxPrefix(help.stdout + help.stderr, p);
  assert.ok(prefix);
  const parsed = await p.direct([...prefix.slice(0, -1), '--help']);
  assert.equal(parsed.code, 0, JSON.stringify(parsed));
  assert.match(parsed.stdout, /--permission-profile/);

  const commands = ['git status --porcelain', 'git log --oneline -5', 'rg -c codex .', 'node -p version', 'node -e write'];
  const events = [{ type: 'thread.started' }, ...commands.flatMap((command, id) => ['item.started', 'item.completed']
    .map(type => ({ type, item: { type: 'command_execution', id, command, exit_code: 0, aggregated_output: 'first\nsecond' } }))),
  { type: 'turn.completed' }];
  const stream = events.map(event => JSON.stringify(event)).join('\n') + '\n';
  const stub = path.join(root, 'events.mjs');
  writeFileSync(stub, 'process.stdout.write(' + JSON.stringify(stream) + ');\n');
  const traced = await execute(p.python, ['-B', driver, 'trace', process.execPath, stub, '-o', path.join(root, 'last_message.txt')],
    { cwd: work, env: p.env });
  assert.equal(traced.code, 0, JSON.stringify(traced));
  assert.equal(traced.stdout, stream);
  const clocks = readFileSync(path.join(root, 'bench-events.json'), 'utf8');
  const timing = modelTimings({ 'events.jsonl': '{"type":"runner.phase"}\n' + stream, 'bench-events.json': clocks },
    JSON.parse(clocks).launch_epoch_ms - 20, 0, 1000, commands);
  assert.equal(timing.metrics.dispatch_to_launch_ms, 20);
  assert.equal(timing.commands.length, 5);
  assert.equal(timing.commands[0].first_output_line, 'first');
  assert.equal(timing.metrics.commands_ms, timing.commands.reduce((sum, item) => sum + item.elapsed_ms, 0));
  assert.throws(() => modelTimings({ 'events.jsonl': stream, 'bench-events.json': clocks }, 0, 0, 1000, commands.toReversed()),
    /ordered benchmark commands/);
});
