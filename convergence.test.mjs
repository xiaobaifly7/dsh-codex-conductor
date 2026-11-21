import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { apply } from './index.mjs';

const task = '核对离线数据并保存可供复核的报告。';
const acceptance = ['核实原始读数', '核实报告输出'];
const owner = 'origin';
const question = (id, kind = 'implementation') => ({
  id, kind, message: '缺少本轮前置条件', question: '使用哪一项已授权的前置条件？', resolution: '',
});
const caller = (id = owner, log = []) => ({ agent: { id, session: { header: { cwd: '/work' }, log } } });

function fixture(t, config = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'convergence-'));
  const state = path.join(root, 'dsh-codex-conductor');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const records = new Map();
  const starts = [];
  const calls = [];
  let version = 'tree-1';
  const time = Date.now() / 1000 + 10;
  const add = (job_id, overrides = {}) => {
    const context = { owner, task, acceptance, write: true, ...overrides.context };
    const structured = {
      summary: '本轮执行结果', criteria: context.acceptance.map(criterion => ({
        criterion, status: 'blocked', evidence: '未获得该前置条件',
      })),
      files_changed: [], deviations: [], unresolved: [], blockers: [], ...overrides.structured,
    };
    const job = { job_id, status: 'completed', execution_status: 'completed', cwd: '/work',
      sandbox: context.write ? 'workspace-write' : 'read-only', log_dir: `/runner/jobs/${job_id}`,
      started_at: time + records.size, finished_at: time + records.size + 0.1, verification_status: 'unreviewed',
      report_status: 'valid', review_status: 'needs_attention', scope: ['docs'], files_changed: [],
      ...overrides, context, structured };
    records.set(job_id, job);
    return job;
  };
  const run = async (_cfg, argv, options) => {
    calls.push([argv, options?.stdin]);
    const [command, id] = argv;
    const pick = name => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
    const parent = job => job.context.continuation?.parent_job_id ?? job.context.routing?.parent_job_id;
    if (command === 'list') {
      const owners = argv.flatMap((item, index) => ['--owner', '--also-owner'].includes(item) ? [argv[index + 1]] : []);
      const jobs = [...records.values()].reverse().filter(job =>
        (!owners.length || owners.includes(job.context.owner)) &&
        (!pick('--parent-job') || parent(job) === pick('--parent-job')) &&
        (!pick('--thread-id') || job.thread_id === pick('--thread-id')) &&
        (!pick('--verification-of') || job.context.verification_of === pick('--verification-of')) &&
        (!pick('--status') || job.execution_status === pick('--status')) &&
        (!pick('--task-key') || createHash('sha256').update(job.context.task.trim()).digest('hex') === pick('--task-key')));
      return { jobs: jobs.slice(0, Number(pick('--limit'))), total: jobs.length };
    }
    if (command === 'status') return structuredClone(records.get(id) ?? { status: 'failed', error_kind: 'unknown_job' });
    if (command === 'summary') return { groups: [] };
    if (command === 'repeat-guard') return { status: 'completed' };
    if (command === 'verification-version') return { status: 'completed', verification_version: version };
    if (command === 'review') {
      const original = records.get(id);
      const review = JSON.parse(options.stdin);
      original.verification = { ...review, time: time + records.size + 20 };
      original.verification_status = review.status;
      return structuredClone(original);
    }
    assert.equal(command, 'start');
    const request = JSON.parse(options.stdin);
    starts.push(request);
    const verification = request.context.verification_of;
    return add(`new-${starts.length}`, { context: request.context,
      ...(verification ? { verification_version: version, verification_scope: request.context.routing?.verification_scope } : {}),
      structured: { criteria: request.context.acceptance.map(criterion => ({ criterion, status: 'met', evidence: '现场核对' })) } });
  };
  const load = (overrides = {}, plugin = apply) => {
    const tools = {};
    const previous = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = root;
    try {
      plugin({ tools: { register(tool) { tools[tool.name] = tool; }, guard() {} }, on() {} },
        { autoVerify: 'off', closeoutGuard: false, continueFreshAboveTokens: 0,
          reportSchema: '/fixtures/report.v2.schema.json', ...config, ...overrides }, run);
    } finally {
      if (previous === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = previous;
    }
    return tools;
  };
  return { records, add, load, starts, calls, state, setVersion(value) { version = value; } };
}

test('repeat after two identical blocking outcomes survives reload and only follows dispatch ownership', async t => {
  const harness = fixture(t);
  const input = { task, acceptance, write: true, scope: ['docs'] };
  const outcome = { blockers: [question('same-output-boundary')] };
  harness.add('round-1', { thread_id: 'thread', structured: outcome });
  harness.add('round-2', { context: { routing: { parent_job_id: 'round-1' } }, structured: outcome });
  const tools = harness.load();
  await assert.rejects(tools.codex_run.execute(input, caller()), /round-1 → round-2.*same-output-boundary.*rerun_after_change/);
  assert.equal(harness.starts.length, 0);
  writeFileSync(path.join(harness.state, 'handover.json'), JSON.stringify({ links: { successor: { from: owner } } }));
  const reloaded = harness.load();
  await assert.rejects(reloaded.codex_continue.execute({ job_id: 'round-2' }, caller('successor')), /round-1 → round-2/);
  const unrelated = caller('observer', [{ type: 'job/registered', data: { owner: 'observer', label: 'Codex round-2' } }]);
  await assert.rejects(reloaded.codex_continue.execute({ job_id: 'round-2' }, unrelated), /不属于当前会话/);
  await reloaded.codex_run.execute(input, unrelated);
  await reloaded.codex_continue.execute({ job_id: 'round-2', rerun_after_change: '采集源已由用户恢复可用' }, caller('successor'));
  assert.equal(harness.starts.length, 2);
  assert.equal(harness.starts[1].context.continuation.parent_job_id, 'round-2');
});

test('different blockers on successive rework rounds leave the next dispatch available', async t => {
  const harness = fixture(t);
  harness.add('layer-1', { structured: { blockers: [question('missing-option')] } });
  harness.add('layer-2', { context: { continuation: { parent_job_id: 'layer-1' } }, structured: { blockers: [question('missing-input')] } });
  await harness.load().codex_continue.execute({ job_id: 'layer-2' }, caller());
  assert.equal(harness.starts.length, 1);
});

test('changed wording buys only one unchanged retry across reload and handover', async t => {
  const harness = fixture(t);
  const blocked = { blockers: [question('same-observation-gap')] };
  harness.add('first', { structured: blocked });
  harness.add('second', { context: { continuation: { parent_job_id: 'first' } }, structured: blocked });
  const original = harness.load();
  const attempted = await original.codex_continue.execute({ job_id: 'second', rerun_after_change: '环境条件据称已恢复' }, caller());
  const newest = harness.records.get(attempted.job_id);
  newest.structured = structuredClone(harness.records.get('second').structured);
  assert.equal(newest.context.routing.convergence_override, true);
  writeFileSync(path.join(harness.state, 'handover.json'), JSON.stringify({ links: { successor: { from: owner } } }));
  const tools = harness.load();
  for (const rerun_after_change of ['已再次确认环境变了', '现在据称改用另一方法']) {
    await assert.rejects(tools.codex_continue.execute({ job_id: newest.job_id, rerun_after_change }, caller('successor')), error => {
      assert.match(error.message, /已用完一次机会.*codex_review.*用户决定/);
      assert.ok(!error.message.includes('rerun_after_change'));
      return true;
    });
  }
  assert.equal(harness.starts.length, 1);
  await tools.codex_run.execute({ task, acceptance, write: true, scope: ['docs/report.md'] }, caller('successor'));
  assert.equal(harness.starts[1].context.routing?.convergence_override, undefined);
  harness.records.delete('new-2');
  newest.structured.blockers = [question('next-observation-gap')];
  await tools.codex_continue.execute({ job_id: newest.job_id }, caller('successor'));
  assert.equal(harness.starts[2].context.routing?.convergence_override, undefined);
});

test('historical evidence stays visible without debt or later verification or shifted must_verify indices', async t => {
  const harness = fixture(t);
  const evidence = ['留存开工前的快照', '核实报告输出', '复查导出清单'];
  const job = harness.add('history-437', { context: { acceptance: evidence }, files_changed: [{ path: 'docs/report.md' }],
    structured: { criteria: evidence.map((criterion, index) => ({
      criterion, status: index === 0 ? 'blocked' : 'met', evidence: index === 0 ? '开工时未采集' : '输出可以复核',
    })) } });
  const review = { job_id: job.job_id, status: 'accepted_deviations', criteria: [
    { index: 1, status: 'blocked', evidence: '原记录没有采集', accepted: '对应时点已经过去，无法重采', historical_gap: 'missing_snapshot' },
    { index: 2, status: 'met', evidence: '读取了现有报告' },
    { index: 3, status: 'met', evidence: '清单与报告一致' },
  ] };
  const tools = harness.load();
  await tools.codex_review.execute(review, caller());
  const ledger = JSON.parse(readFileSync(path.join(harness.state, 'accepted-open.json'), 'utf8'));
  assert.deepEqual(ledger.items, []);
  assert.deepEqual(ledger.historical.map(item => [item.key, item.reason]), [['1', review.criteria[0].accepted]]);
  const reloaded = harness.load();
  assert.equal((await reloaded.codex_summary.execute({}, caller())).accepted_open_ledger.historical.length, 1);
  job.context.must_verify = [3];
  await reloaded.codex_continue.execute({ job_id: job.job_id, resolution: '检查交付文件与现行清单是否一致' }, caller());
  assert.deepEqual(harness.starts[0].context.acceptance, evidence.slice(1));
  assert.deepEqual(harness.starts[0].context.must_verify, [2]);
  await reloaded.codex_verify.execute({ job_id: job.job_id }, caller());
  assert.ok(!harness.starts[1].context.acceptance.some(text => text.includes(evidence[0])));
  job.context.must_verify = [1];
  await assert.rejects(reloaded.codex_review.execute(review, caller()), /historical_gap.*must_verify/);
  job.context.must_verify = [];
  job.context.acceptance[0] = '留存开工前的快照以校验数据完整性';
  await assert.rejects(reloaded.codex_review.execute(review, caller()), /historical_gap.*数据完整性/);
});

test('preflight rejects explicit required writes and preserves a real read-only investigation', async t => {
  const harness = fixture(t);
  const { codex_run, codex_continue } = harness.load();
  const read = { task: '【约束】\n- 全程只读：不写文件、不改配置。\n仅核实原始读数并汇报现状。', acceptance, write: false };
  await assert.rejects(codex_run.execute({ ...read, required_writes: ['docs/report.md'] }, caller()), /write=false.*全程只读.*report.md/);
  await assert.rejects(codex_run.execute({ ...read, task: `${read.task}\n- 写出 \`docs/report.md\`` }, caller()), /write=false.*report.md/);
  await assert.rejects(codex_run.execute({ ...read, task: `${read.task}\n【交付】\n- draft.md\n- draft-summary.json（含结论）` }, caller()), /write=false.*draft.md.*draft-summary.json/);
  await assert.rejects(codex_run.execute({ ...read, task, write: true, scope: ['docs'], required_writes: ['cache/probe.json'] }, caller()), /probe.json.*不在 scope.*docs/);
  harness.add('blocked-original', { context: { task: `${read.task}\n- 写出 \`docs/report.md\``, write: false },
    structured: { blockers: [question('write-conflict', 'task_conflict')] } });
  await assert.rejects(codex_continue.execute({ job_id: 'blocked-original', answers: [{ id: 'write-conflict', answer: '复用原权限' }] }, caller()), /全程只读.*report.md/);
  assert.equal(harness.starts.length, 0);
  await codex_run.execute(read, caller());
  assert.equal(harness.starts.length, 1);
});

test('closeout, hand-entered review IDs and answer IDs return resubmission data for owned jobs', async t => {
  const harness = fixture(t, { closeoutGuard: true });
  harness.add('runner-real', { structured: { blockers: [question('B1', 'task_conflict'), question('B2', 'task_conflict')] } });
  harness.add('runner-foreign', { context: { owner: 'another' } });
  const tools = harness.load();
  for (const attempt of [
    () => tools.codex_run.execute({ task, acceptance, write: false }, caller()),
    () => tools.codex_review.execute({ job_id: 'invented-id', status: 'accepted_deviations', criteria: [] }, caller()),
  ]) {
    await assert.rejects(attempt, error => {
      const resubmit = JSON.parse(error.message.split('\ncodex_review ')[1]);
      assert.equal(resubmit.job_id, 'runner-real');
      assert.deepEqual(resubmit.criteria.map(item => item.index), [1, 2]);
      assert.ok(!error.message.includes('runner-foreign'));
      return true;
    });
  }
  const receipt = await tools.codex_continue.execute({ job_id: 'runner-real', answers: [
    { id: 'B1', answer: '已选的答复' }, { id: 'B2', answer: '重复值甲' }, { id: 'B2', answer: '重复值乙' },
  ] }, caller());
  assert.deepEqual(receipt.resubmit, { job_id: 'runner-real', answers: [{ id: 'B1', answer: '已选的答复' }, { id: 'B2', answer: '<待填>' }] });
  assert.equal(harness.starts.length, 0);
});

test('asset-less blocked rounds skip automatic and explicit verification; first and changed checks still run', async t => {
  // blocked-44s 只在等 task_conflict 的回答，默认 autoVerifySkipQuestions 下根本不自动核验；这里关掉它，测无产物跳过本身。
  const harness = fixture(t, { autoVerify: 'flagged', autoVerifySkipQuestions: false });
  harness.add('blocked-44s', { duration_s: 44, context: { must_verify: [1] },
    structured: { blockers: [question('scope-denied', 'task_conflict')] } });
  harness.add('with-product', { files_changed: [{ path: 'docs/report.md' }], context: { must_verify: [1] } });
  const tools = harness.load();
  assert.match((await tools.codex_status.execute({ job_id: 'blocked-44s' }, caller())).auto_verify.skipped, /未记录改动或可核验结果/);
  await assert.rejects(tools.codex_verify.execute({ job_id: 'blocked-44s' }, caller()), /未记录改动或可核验结果/);
  assert.equal(harness.starts.length, 0);
  await tools.codex_verify.execute({ job_id: 'with-product' }, caller());
  assert.match(harness.starts[0].context.acceptance[0], /原验收第 1 条/);
  const reloaded = harness.load();
  await assert.rejects(reloaded.codex_verify.execute({ job_id: 'with-product' }, caller()), /文件及核验范围未变.*new-1/);
  await reloaded.codex_verify.execute({ job_id: 'with-product', focus: '新增抽查主题' }, caller());
  harness.setVersion('tree-2');
  await reloaded.codex_verify.execute({ job_id: 'with-product' }, caller());
  assert.equal(harness.starts.length, 3);
});

test('reported met including must_verify still triggers automatic and explicit verification with zero changed files', async t => {
  const harness = fixture(t, { autoVerify: 'flagged' });
  const checks = ['确认条件一', '确认条件二', '确认条件三', '复测关键结果', '检查副作用'];
  const overrides = { context: { acceptance: checks, must_verify: [4] }, duration_s: 44,
    structured: { summary: '上轮已完成，本轮只读核对，未修改文件',
      criteria: checks.map((criterion, index) => ({ criterion, status: index < 3 ? 'blocked' : 'met',
        evidence: index < 3 ? '本轮未执行' : '上轮结果，本轮只读检查' })) } };
  harness.add('automatic-mixed', overrides);
  const tools = harness.load();
  const automatic = (await tools.codex_status.execute({ job_id: 'automatic-mixed' }, caller())).auto_verify;
  assert.equal(harness.records.get(automatic.job_id).context.verification_of, 'automatic-mixed');
  harness.add('explicit-mixed', overrides);
  const explicit = await harness.load({ autoVerify: 'off' }).codex_verify.execute({ job_id: 'explicit-mixed' }, caller());
  assert.equal(harness.records.get(explicit.job_id).context.verification_of, 'explicit-mixed');
  assert.ok(harness.starts.every(start => start.context.acceptance[0].includes('原验收第 4 条')));
});

test('turning off convergence, historical gaps and verification reuse preserves the baseline runner trace', async t => {
  const trace = async (plugin, config) => {
    const harness = fixture(t);
    const source = harness.add('source', { thread_id: 'thread', structured: { blockers: [question('missing-input')] } });
    const tools = harness.load(config, plugin);
    await tools.codex_run.execute({ task, acceptance, write: false }, caller());
    await tools.codex_continue.execute({ job_id: source.job_id }, caller());
    await tools.codex_review.execute({ job_id: source.job_id, status: 'needs_changes',
      criteria: acceptance.map((_item, index) => ({ index: index + 1, status: 'blocked', evidence: '前置仍缺失' })) }, caller());
    await tools.codex_verify.execute({ job_id: source.job_id }, caller());
    return harness.calls.map(([argv, stdin]) => {
      const payload = stdin && JSON.parse(stdin);
      if (payload?.context?.dispatcher) delete payload.context.dispatcher;
      return [argv, payload];
    });
  };
  const actual = await trace(apply, { convergenceGuard: false, historicalGapReview: false, verificationReuse: false });
  const baselineEntry = process.env.CONDUCTOR_BASELINE_ENTRY;
  if (baselineEntry) {
    const baseline = await import(pathToFileURL(baselineEntry));
    assert.deepEqual(actual, await trace(baseline.apply, {}));
  }
  assert.deepEqual(actual.map(([argv]) => argv[0]), [
    'repeat-guard', 'start', 'status', 'list', 'list', 'repeat-guard', 'list', 'start',
    'status', 'review', 'status', 'list', 'repeat-guard', 'start',
  ]);
  assert.ok(actual.every(([argv]) => !argv.includes('--task-key') && !argv.includes('--verification-of')));
});

test('rewritten report rows match acceptance by position; answers to the stuck question are new input', async t => {
  const harness = fixture(t);
  const rows = (labels, kind = 'implementation', id = 'same-gap') => ({ blockers: [question(id, kind)],
    criteria: labels.map((label, i) => ({ criterion: label, status: i ? 'met' : 'blocked', evidence: '未获得该前置条件' })) });
  const rewritten = acceptance.map((text, i) => `${i + 1}. ${text}（执行端改写）`);
  const chain = (name, structured) => {
    harness.add(`${name}-1`, { structured });
    harness.add(`${name}-2`, { context: { continuation: { parent_job_id: `${name}-1` } }, structured });
  };
  chain('pos', rows(rewritten));
  chain('short', rows(rewritten.slice(0, 1)));
  chain('renumbered', rows([...rewritten].reverse()));
  chain('ask', rows(rewritten, 'user_input', 'pick-input'));
  const tools = harness.load();
  await assert.rejects(tools.codex_continue.execute({ job_id: 'pos-2' }, caller()), /pos-1 → pos-2 卡在 验收 1=blocked、implementation:same-gap/);
  // 条数不等或编号和位置对不上时，保持不按位置对应。
  await tools.codex_continue.execute({ job_id: 'short-2' }, caller());
  await tools.codex_continue.execute({ job_id: 'renumbered-2' }, caller());
  assert.equal(harness.starts.length, 2);
  // 只换说法、不回答卡住的问题照样拦；回答了它就是新输入。
  await assert.rejects(tools.codex_continue.execute({ job_id: 'ask-2', resolution: '按原约束继续' }, caller()), /ask-1 → ask-2.*user_input:pick-input/);
  await tools.codex_continue.execute({ job_id: 'ask-2', answers: [{ id: 'pick-input', answer: '改用已授权的第二项' }] }, caller());
  assert.equal(harness.starts.length, 3);
  assert.deepEqual(harness.starts[2].context.continuation.answers, [{ id: 'pick-input', answer: '改用已授权的第二项' }]);
});

test('resubmitting the same answer to the same stuck question is still a repeat; a different answer goes through', async t => {
  const harness = fixture(t);
  const structured = { blockers: [question('pick-input', 'user_input')] };
  const same = [{ id: 'pick-input', answer: '用第二项' }];
  harness.add('q-1', { structured });
  harness.add('q-2', { context: { continuation: { parent_job_id: 'q-1', answers: same, resolution: '' } }, structured });
  const tools = harness.load();
  await assert.rejects(tools.codex_continue.execute({ job_id: 'q-2', answers: same }, caller()), /q-1 → q-2 卡在/);
  assert.equal(harness.starts.length, 0);
  await tools.codex_continue.execute({ job_id: 'q-2', answers: [{ id: 'pick-input', answer: '改用第三项' }] }, caller());
  assert.equal(harness.starts.length, 1);
});

test('review receipts keep a failed write\'s reason; truncated change lists still name out-of-scope files', async t => {
  const harness = fixture(t);
  const files = Array.from({ length: 40 }, (_, i) => ({ path: i === 35 ? 'src/evil.py' : `docs/f${i}.md`, change: 'modified' }));
  harness.add('ask', { scope_paths: ['docs'], files_changed: files, files_changed_total: 40, files_changed_source: 'snapshot',
    structured: { blockers: [question('q1', 'user_input')] } });
  const tools = harness.load();
  const failed = { status: 'failed', error_kind: 'bridge_error', error: 'runner exited 2: Invalid review: criteria[0].index 9 out of range' };
  assert.match(tools.codex_review.output.render({}, failed)[0].text, /错误：runner exited 2: Invalid review/);
  const value = await tools.codex_status.execute({ job_id: 'ask' }, caller());
  assert.match(tools.codex_status.output.render({}, value)[0].text, /其中超出 scope 的：src\/evil\.py/);
});
