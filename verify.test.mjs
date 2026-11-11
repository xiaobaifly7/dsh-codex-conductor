import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// apply() writes a planner template and runtime marker; keep both away from real DSH state.
const localAppData = mkdtempSync(path.join(tmpdir(), 'conductor-verify-test-'));
after(() => {
  assert.equal(path.dirname(localAppData), path.resolve(tmpdir()));
  rmSync(localAppData, { recursive: true, force: true });
});
const { apply, nextStep, normPath } = await import('./index.mjs');
const schema = JSON.parse(readFileSync(new URL('./report.v2.schema.json', import.meta.url), 'utf8'));
const exec = { agent: { id: 'verify-session', session: { header: { cwd: '/work/planner' }, log: [] } } };
const acceptance = ['核对原任务书及产物', '逐条核实结论的原始出处'];

function report(criteria = acceptance) {
  return { summary: '已核对结论及其出处',
    criteria: criteria.map(criterion => ({ criterion, status: 'met', evidence: 'docs/result.md:12 与 src/input.js:8 相符' })),
    files_changed: [], deviations: [], unresolved: [], blockers: [] };
}

function sourceJob() {
  return { job_id: 'SOURCE-1', status: 'completed', thread_id: 'original-thread',
    cwd: '/work/original', log_dir: '/runner/jobs/SOURCE-1', sandbox: 'workspace-write',
    context: { owner: exec.agent.id, task: '阅读 src/input.js 并生成带出处的分析报告', acceptance, write: true },
    task_options: { model: 'original-model', effort: 'low', service_tier: 'priority', use_user_config: true,
      writable_roots: ['/work/extra'] },
    scope: ['docs'], scope_paths: ['/work/original/docs'],
    files_changed: [{ path: 'docs/snapshot.md' }, { path: 'docs/result.md' }], write_paths: ['/work/original/docs/written.md'],
    structured: { ...report(), files_changed: ['docs/result.md'] } };
}

function harness({ source = sourceJob(), config = {}, running = false, jobs } = {}) {
  const tools = {};
  const handlers = {};
  const calls = [];
  let guard;
  let payload;
  let finishBackground;
  let backgroundFinished = false;
  const final = () => ({ job_id: 'VERIFY-1', status: 'completed', cwd: source.cwd,
    log_dir: '/runner/jobs/VERIFY-1', sandbox: source.sandbox === 'danger-full-access' ? source.sandbox : 'read-only',
    context: payload.context, structured: report(payload.context.acceptance), files_changed: [] });
  const run = async (_config, argv, options = {}) => {
    calls.push({ argv, ...options });
    if (argv[0] === 'start') {
      payload = JSON.parse(options.stdin);
      return running ? { job_id: 'VERIFY-1', status: 'running' } : final();
    }
    if (argv[0] === 'status' && argv[1] === 'SOURCE-1') return structuredClone(source);
    if (argv[0] === 'status' && argv[1] === 'VERIFY-1') {
      if (!running || backgroundFinished) return final();
      if (argv[3] === '20') return new Promise(resolve => {
        finishBackground = () => { backgroundFinished = true; resolve(final()); };
      });
      return { job_id: 'VERIFY-1', status: 'running' };
    }
    if (argv[0] === 'list') return { jobs: payload ? [final()] : [], total: payload ? 1 : 0 };
    if (argv[0] === 'products') return { status: 'completed', owner: argv[2], paths: [] };
    throw new Error(`Unexpected runner call: ${argv.join(' ')}`);
  };
  const previousLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = localAppData;
  try {
    apply({ tools: { register(tool) { tools[tool.name] = tool; }, guard(value) { guard = value; } },
      on(name, handler) { handlers[name] = handler; },
      get(key) { return key === 'jobs' ? jobs : undefined; } },
    { workspaces: ['/work'], allowHostAccess: true, waitSeconds: 0, model: 'new-default-model',
      effort: 'high', readOnlyEffort: 'medium', serviceTier: 'new-default-tier', ...config }, run);
  } finally {
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
  }
  return { tools, calls, verify: (args = {}, caller = exec) => tools.codex_verify.execute({ job_id: 'SOURCE-1', ...args }, caller),
    guard: caller => guard(caller),
    execute: (caller, next) => handlers['tools/execute'](caller, next),
    start: () => calls.find(call => call.argv[0] === 'start'), payload: () => payload,
    finishBackground: () => { assert.ok(finishBackground, 'background watcher must be running'); finishBackground(); } };
}

function backgroundJobs() {
  const entries = [];
  const view = job => ({ id: job.id, owner: job.owner, kind: job.kind, label: job.label, status: job.status });
  return { entries,
    list: owner => entries.filter(job => job.owner === owner).map(view),
    start(spec) {
      const job = { ...spec, id: `background-${entries.length + 1}`, status: 'running', logs: [] };
      entries.push(job);
      const work = spec.run({ append: text => job.logs.push(text), updateProgress() {} });
      job.done = work.done.then(result => { Object.assign(job, result); return result; });
      return job.id;
    },
    async wait(id, _milliseconds, owner) {
      const job = entries.find(entry => entry.id === id && entry.owner === owner);
      assert.ok(job);
      return view(job);
    },
    read(id, owner) {
      const job = entries.find(entry => entry.id === id && entry.owner === owner);
      assert.ok(job);
      const result = job.delivered ? undefined : job.result;
      job.delivered ||= result !== undefined;
      return { result };
    },
  };
}

test('codex_verify exposes only its four inputs and sample/wait bounds', () => {
  const { parameters } = harness().tools.codex_verify;
  assert.deepEqual(parameters.required, ['job_id']);
  assert.deepEqual(Object.keys(parameters.properties).sort(), ['focus', 'job_id', 'samples', 'wait_seconds']);
  assert.equal(parameters.properties.job_id.type, 'string');
  assert.equal(parameters.properties.focus.type, 'string');
  assert.equal(parameters.properties.samples.type, 'integer');
  assert.equal(parameters.properties.samples.minimum, 1);
  assert.equal(parameters.properties.samples.maximum, 30);
  assert.equal(parameters.properties.wait_seconds.type, 'integer');
  assert.equal(parameters.properties.wait_seconds.minimum, 0);
});

test('dispatch descriptions keep waiting on the current runner job and accept the returned report', () => {
  const { tools } = harness();
  for (const name of ['codex_run', 'codex_continue', 'codex_verify']) {
    for (const text of [tools[name].description, tools[name].parameters.properties.wait_seconds.description]) {
      for (const required of ['本轮', 'runner', 'job_id', 'codex_status', '报告', '验收']) {
        assert.ok(text.includes(required), `${name}: ${required}`);
      }
      assert.match(text, /wait_seconds\s*:\s*3600/, name);
      assert.match(text, /留在本轮/, name);
      assert.match(text, /报告.*直接验收/, name);
    }
  }
});

for (const [field, values] of [
  ['job_id', [undefined, null, '', ' ', '../SOURCE-1', 'SOURCE/1', 'SOURCE 1', 1]],
  ['focus', [null, 1, {}, []]],
  ['samples', [null, 0, -1, 31, 1.5, '8', NaN, Infinity]],
  ['wait_seconds', [null, -1, 0.5, '0', NaN, Infinity]],
]) test(`codex_verify rejects invalid ${field} before any runner call`, async () => {
  const h = harness();
  for (const value of values) {
    await assert.rejects(h.verify({ [field]: value }), new RegExp(`codex_verify: ${field}`), String(value));
  }
  if (field === 'job_id') {
    await assert.rejects(h.tools.codex_verify.execute(undefined, exec), /job_id/);
    await assert.rejects(h.tools.codex_verify.execute({}, exec), /job_id/);
  }
  assert.deepEqual(h.calls, []);
});

test('codex_verify requires the current session before querying the runner', async () => {
  const h = harness();
  for (const caller of [undefined, {}, { agent: {} }]) {
    await assert.rejects(h.tools.codex_verify.execute({ job_id: 'SOURCE-1' }, caller), /会话 ID/);
  }
  assert.deepEqual(h.calls, []);
});

test('codex_verify rejects another session and unknown ownership without dispatching', async () => {
  for (const owner of ['another-session', undefined, null, '']) {
    const source = sourceJob();
    source.context.owner = owner;
    const h = harness({ source });
    await assert.rejects(h.verify(), /归属未知或不属于当前会话/);
    assert.deepEqual(h.calls.map(call => call.argv), [['status', 'SOURCE-1', '--wait', '0']]);
  }
});

test('codex_verify rejects running and unknown states, including bridge failures', async () => {
  for (const [patch, message] of [
    [{ status: 'running' }, /还在运行[\s\S]*codex_status\(\{"job_id":"SOURCE-1","wait_seconds":3600\}\)/], [{ status: 'unknown' }, /状态未知/],
    [{ status: undefined }, /状态未知/], [{ status: 'queued' }, /状态未知/],
    [{ status: 'failed', error_kind: 'unknown_job' }, /状态未知/],
    [{ status: 'failed', error_kind: 'bridge_error' }, /状态未知/],
    [{ status: 'completed', error_kind: 'invalid_record' }, /状态未知/],
  ]) {
    const h = harness({ source: { ...sourceJob(), ...patch } });
    await assert.rejects(h.verify(), message);
    assert.equal(h.calls.length, 1);
    assert.equal(h.start(), undefined);
  }
});

test('codex_verify refuses missing original task, acceptance, directory or execution settings', async () => {
  for (const change of [
    source => { delete source.cwd; }, source => { delete source.log_dir; },
    source => { delete source.context.task; }, source => { source.context.acceptance = []; },
    source => { source.sandbox = 'unknown'; },
  ]) {
    const source = sourceJob();
    delete source.scope;
    delete source.scope_paths;
    change(source);
    const h = harness({ source });
    await assert.rejects(h.verify(), /原任务缺少/);
    assert.equal(h.start(), undefined);
  }
});

test('missing cwd with scope_paths and relative changed files returns a clear validation error', async () => {
  const source = sourceJob();
  delete source.cwd;
  const h = harness({ source });
  await assert.rejects(h.verify(), {
    name: 'Error',
    message: 'codex_verify: 原任务缺少目录、任务书、验收标准或执行设置，无法独立核验',
  });
  assert.deepEqual(h.calls.map(call => call.argv), [['status', 'SOURCE-1', '--wait', '0']]);
  assert.equal(h.start(), undefined);
});

test('all known terminal states can be independently verified', async () => {
  for (const status of ['completed', 'failed', 'cancelled']) {
    const h = harness({ source: { ...sourceJob(), status } });
    const result = await h.verify();
    assert.equal(result.status, 'completed');
    assert.equal(result.context.verification_of, 'SOURCE-1');
    assert.equal(h.calls.filter(call => call.argv[0] === 'start').length, 1);
  }
});

test('verification inherits original cwd and model options, never original write scope or thread', async () => {
  for (const sandbox of ['read-only', 'workspace-write', 'danger-full-access']) {
    const source = { ...sourceJob(), sandbox };
    const original = structuredClone(source);
    const h = harness({ source, config: { defaultHostAccess: true } });
    const result = await h.verify();
    const argv = h.start().argv;
    const flag = name => argv[argv.indexOf(name) + 1];
    assert.equal(flag('--cwd'), source.cwd);
    assert.equal(flag('--model'), source.task_options.model);
    assert.equal(flag('--effort'), source.task_options.effort);
    assert.equal(flag('--service-tier'), source.task_options.service_tier);
    assert.ok(argv.includes('--use-user-config'));
    if (sandbox === 'danger-full-access') assert.equal(flag('--sandbox'), sandbox);
    else assert.equal(argv.includes('--sandbox'), false);
    for (const forbidden of ['--resume', '--scope', '--writable-root']) assert.equal(argv.includes(forbidden), false, forbidden);
    assert.equal(h.payload().context.write, false);
    assert.equal(h.payload().context.owner, exec.agent.id);
    assert.equal(h.payload().context.verification_of, source.job_id);
    assert.equal(h.payload().context.continuation, undefined);
    assert.equal(result.context.verification_of, source.job_id);
    assert.match(h.payload().prompt, /新线程，不续接原作者的思路/);
    assert.match(h.payload().prompt, /写入范围为空/);
    if (sandbox === 'danger-full-access') assert.match(h.payload().prompt, /这是只读调查：不要修改任何文件/);
    assert.deepEqual(source, original);
  }
});

test('original false user-config and explicit empty model/tier do not use current defaults', async () => {
  const source = sourceJob();
  Object.assign(source.task_options, { use_user_config: false, model: null, service_tier: '' });
  const h = harness({ source });
  await h.verify();
  for (const flag of ['--use-user-config', '--model', '--service-tier']) assert.equal(h.start().argv.includes(flag), false, flag);
});

test('unspecified original model options keep Codex defaults instead of changed plugin defaults', async () => {
  for (const options of [undefined, { effort: null, use_user_config: false }]) {
    const source = sourceJob();
    source.task_options = options;
    const h = harness({ source });
    await h.verify();
    for (const flag of ['--use-user-config', '--model', '--service-tier', '--effort']) {
      assert.equal(h.start().argv.includes(flag), false, flag);
    }
  }
});

test('self-reported changes cannot grant planner access to unwritten source files', async () => {
  const source = sourceJob();
  source.structured.files_changed.push('src/raw.js');
  const h = harness({ source, config: { plannerReads: 'products' } });
  await h.verify();
  const read = async file => {
    const caller = { ...exec, name: 'read', arguments: { file_path: file } };
    const reason = h.guard(caller);
    assert.ok(reason === undefined || typeof reason === 'string', 'host guards must return synchronously');
    if (reason !== undefined) return reason;
    const result = await h.execute(caller, async () => ({ isError: false, value: {}, content: [] }));
    return result.isError ? result.error.message : undefined;
  };
  assert.equal(await read('/work/original/docs/result.md'), undefined);
  assert.match(await read('/work/original/src/raw.js'), /原料/);
  assert.doesNotMatch(h.payload().prompt, /\/work\/original\/src\/raw\.js/);
});

test('verification preserves the host-access permission gate from normal dispatch', async () => {
  const h = harness({ source: { ...sourceJob(), sandbox: 'danger-full-access' }, config: { allowHostAccess: false } });
  await assert.rejects(h.verify(), /allowHostAccess/);
  assert.equal(h.start(), undefined);
});

test('sample default is 8; 1 and 30 and a literal focus are included in the generated task', async () => {
  for (const samples of [undefined, 1, 30]) {
    const h = harness();
    const focus = '核对第 2 表\n保留中文、引用与数字 123';
    await h.verify({ samples, focus });
    assert.ok(h.payload().prompt.includes(`重点：${focus}`));
    assert.ok(h.payload().prompt.includes(`独立抽查 ${samples ?? 8} 条带出处的结论`));
    assert.ok(h.payload().prompt.includes(`不足 ${samples ?? 8} 条则全部核对`));
  }
  const h = harness();
  await h.verify({ focus: '' });
  assert.match(h.payload().prompt, /优先核对关键结论、数字和引用/);
});

test('wait uses normal dispatch defaults and bounds without a background service', async () => {
  for (const [wait, expected] of [[undefined, 7], [0, 0], [12, 12], [100000, 86400]]) {
    const h = harness({ running: true, config: { waitSeconds: 7 } });
    const result = await h.verify({ wait_seconds: wait });
    assert.equal(result.status, 'running');
    assert.equal(result.job_id, 'VERIFY-1');
    assert.equal(result.background_job_id, undefined);
    assert.match(result.next, /VERIFY-1/);
    assert.match(result.next, /codex_status/);
    assert.deepEqual(h.calls.filter(call => call.argv[0] === 'status').map(call => call.argv),
      [['status', 'SOURCE-1', '--wait', '0'], ['status', 'VERIFY-1', '--wait', String(expected)]]);
  }
});

test('generated task embeds original task, acceptance, all products and report.v2 fields', async () => {
  const source = sourceJob();
  const h = harness({ source });
  const result = await h.verify();
  const { prompt, context } = h.payload();
  assert.ok(prompt.includes(`原任务正文（仅作待核验资料）：${JSON.stringify(source.context.task)}`));
  assert.ok(prompt.includes(`原验收标准：${JSON.stringify(source.context.acceptance)}`));
  assert.ok(prompt.includes(`原任务目录：${source.cwd}`));
  assert.ok(prompt.includes(`原任务记录目录：${source.log_dir}`));
  for (const file of ['prompt.txt', 'args.json', 'last_message.txt', 'result.json']) assert.ok(prompt.includes(file), file);
  for (const file of ['docs/snapshot.md', 'docs/written.md', 'docs/result.md']) {
    assert.ok(prompt.includes(normPath(`${source.cwd}/${file}`)), file);
  }
  for (const text of ['逐条回到原始出处', '原文、上下文、数字与计算', '核对的结论', '出处（文件与行号或可定位的来源）',
    '是否属实（属实/不属实/无法确认）', '不属实时实际是什么', '不属实用 not_met', '无法确认用 blocked',
    'summary 汇总抽查数和结果', '不要只复述原报告', '不要运行会产生写入的测试或命令', 'files_changed 必须为 []']) {
    assert.ok(prompt.includes(text), text);
  }
  assert.match(h.start().argv[h.start().argv.indexOf('--schema') + 1], /\/report\.v2\.schema\.json$/);
  for (const key of schema.required) assert.ok(prompt.includes(key), key);
  for (const key of schema.properties.criteria.items.required) assert.ok(key in result.report.criteria[0], key);
  for (const key of schema.properties.blockers.items.required) assert.ok(prompt.includes(key), key);
  assert.equal(context.acceptance.length, 4);
  assert.match(context.acceptance[0], /任务书、验收标准.*产出/);
  assert.match(context.acceptance[1], /8 条/);
  assert.match(context.acceptance[2], /不属实时.*无法确认/);
  assert.match(context.acceptance[3], /全程只读/);
  assert.equal(result.report_status, 'valid');
  assert.deepEqual(result.acceptance, context.acceptance);
  assert.deepEqual(result.report.files_changed, []);
});

test('verification reuses background registration, result processing and status/jobs association', async () => {
  const jobs = backgroundJobs();
  const h = harness({ jobs, running: true, config: { plannerReads: 'products' } });
  const result = await h.verify({ wait_seconds: 60 });
  assert.equal(result.job_id, 'VERIFY-1');
  assert.equal(result.background_job_id, 'background-1');
  assert.equal(result.status, 'running');
  assert.match(result.next, /VERIFY-1/);
  assert.match(result.next, /codex_status/);
  assert.match(result.note, /job_output/);
  assert.equal(jobs.entries.length, 1);
  const job = jobs.entries[0];
  assert.equal(job.kind, 'codex');
  assert.equal(job.owner, exec.agent.id);
  assert.match(job.label, /Codex VERIFY-1/);
  assert.match(job.label, /独立核验/);
  assert.equal(h.calls.some(call => call.argv[0] === 'status' && call.argv[3] === '60'), false);
  const pending = await h.tools.codex_status.execute({ job_id: 'VERIFY-1' }, exec);
  assert.equal(pending.background_job_id, result.background_job_id);
  assert.equal(jobs.entries.length, 1, 'status must reuse the existing background entry');
  h.finishBackground();
  const done = await job.done;
  assert.equal(done.status, 'completed');
  assert.equal(job.result, done.result);
  assert.match(done.result, /独立核验任务；核验对象：SOURCE-1/);
  assert.match(done.result, /完整结果入口/);
  assert.match(done.result, /全程只读/);
  const status = await h.tools.codex_status.execute({ job_id: 'VERIFY-1' }, exec);
  assert.equal(status.context.verification_of, 'SOURCE-1');
  assert.equal(status.report_status, 'valid');
  assert.doesNotMatch(status.next, /codex_verify/);
  assert.match(status.next, /原任务 SOURCE-1.*独立核验已结束/);
  assert.match(status.next, /codex_review/);
  const history = await h.tools.codex_jobs.execute({}, exec);
  assert.equal(history.jobs[0].context.verification_of, 'SOURCE-1');
  assert.equal(history.jobs[0].background_job_id, result.background_job_id);
  assert.equal(jobs.entries.length, 1);
  assert.equal(h.calls.filter(call => call.argv[0] === 'start').length, 1);
  assert.equal(jobs.read(job.id, exec.agent.id).result, done.result);
  assert.equal(jobs.read(job.id, exec.agent.id).result, undefined);
});

test('open nextStep remains the default; products points mechanical checks to codex_verify', async () => {
  const completed = { ...sourceJob(), report: report() };
  const open = nextStep(completed);
  assert.equal(nextStep(completed, undefined, undefined, { plannerReads: 'open' }), open);
  assert.match(open, /用只读检查逐条核验/);
  assert.doesNotMatch(open, /codex_verify/);
  assert.doesNotMatch(open, /本轮已关闭/);
  const products = nextStep(completed, undefined, undefined, { plannerReads: 'products' });
  assert.match(products, /先对产物做机械核对/);
  assert.match(products, /产物在不在、结论有没有带出处、数字对不对得上/);
  assert.match(products, /内容是否属实用 codex_verify/);
  assert.doesNotMatch(products, /用只读检查逐条核验/);
  assert.doesNotMatch(products, /本轮已关闭/);
  for (const plannerReads of ['open', 'products']) {
    const h = harness({ config: { plannerReads } });
    const result = await h.verify();
    assert.doesNotMatch(result.next, /codex_verify/);
    assert.match(result.next, /原任务 SOURCE-1.*独立核验已结束/);
    assert.match(result.next, /先机械核对抽查条数、出处与证据是否齐全.*codex_review/);
    assert.match(result.next, /不把核验结束当作全部通过/);
    assert.equal(h.tools.codex_run.description.includes('codex_verify'), plannerReads === 'products');
  }
});

test('nextStep closes verified and accepted_deviations jobs before products or verification guidance', () => {
  for (const verification_status of ['verified', 'accepted_deviations']) {
    for (const plannerReads of ['open', 'products']) {
      for (const verification_of of [undefined, 'ORIGINAL-1']) {
        const completed = { ...sourceJob(), report: report(), verification_status };
        if (verification_of) completed.context.verification_of = verification_of;
        const next = nextStep(completed, undefined, undefined, { plannerReads });
        assert.match(next, /本轮已关闭/);
        assert.ok(next.includes(verification_status));
        assert.match(next, /codex_output artifact=review/);
        assert.doesNotMatch(next, /codex_verify|codex_review|机械核对|独立核验已结束/);
      }
    }
  }
});
