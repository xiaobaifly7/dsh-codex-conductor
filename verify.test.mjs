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
const gemini = { command: 'C:\\tools\\agy.exe', model: 'gemini-4-carbon-high', effort: 'high' };

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

function harness({ source = sourceJob(), config = {}, running = false, jobs, verificationResult = {} } = {}) {
  const tools = {};
  const handlers = {};
  const calls = [];
  let guard;
  let payload;
  let finishBackground;
  let backgroundFinished = false;
  const final = () => ({ job_id: 'VERIFY-1', status: 'completed', cwd: source.cwd,
    log_dir: '/runner/jobs/VERIFY-1', sandbox: source.sandbox === 'danger-full-access' ? source.sandbox : 'read-only',
    context: payload.context, structured: report(payload.context.acceptance), files_changed: [],
    ...verificationResult });
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
    if (argv[0] === 'review') return { verification_status: JSON.parse(options.stdin).status };
    if (argv[0] === 'products') return { status: 'completed', owner: argv[2], paths: [] };
    throw new Error(`Unexpected runner call: ${argv.join(' ')}`);
  };
  const previousLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = localAppData;
  try {
    apply({ tools: { register(tool) { tools[tool.name] = tool; }, guard(value) { guard = value; } },
      on(name, handler) { handlers[name] = handler; },
      get(key) { return key === 'jobs' ? jobs : undefined; } },
    { workspaces: ['/work'], allowHostAccess: true, autoVerify: 'off', waitSeconds: 0, model: 'new-default-model',
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

test('codex_run validates, stores and prompts for must_verify indices', async () => {
  const input = { task: 'Inspect the project layout.', acceptance, write: false };
  for (const must_verify of [[0], [3], [1.5], ['1'], '1']) {
    const h = harness();
    await assert.rejects(h.tools.codex_run.execute({ ...input, must_verify }, exec), /must_verify.*1–2/);
    assert.equal(h.start(), undefined);
  }
  for (const must_verify of [undefined, [2]]) {
    const h = harness();
    await h.tools.codex_run.execute({ ...input, must_verify }, exec);
    assert.deepEqual(h.payload().context.must_verify, must_verify);
    assert.equal(h.payload().prompt.includes('验收第 2 条必须实测'), must_verify !== undefined);
  }
});

const option = (argv, flag) => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined;

test('Gemini verification leaves the model and effort to agy when unconfigured', async () => {
  const h = harness({ config: { gemini: { command: gemini.command } } });
  await h.verify();
  assert.equal(option(h.start().argv, '--engine'), 'gemini');
  assert.equal(option(h.start().argv, '--model'), undefined);
  assert.equal(option(h.start().argv, '--effort'), undefined);
});

test('Gemini execution passes effort only when explicitly configured or inherited', async () => {
  const h = harness({ config: { gemini: { command: gemini.command, model: gemini.model, forceEffort: true } } });
  await h.tools.codex_run.execute({ task: 'Inspect the project layout.', acceptance, write: false, engine: 'gemini' }, exec);
  assert.equal(option(h.start().argv, '--model'), gemini.model);
  assert.equal(option(h.start().argv, '--effort'), undefined);
  assert.match(h.tools.gemini_write.parameters.properties.effort.description, /模型名自带的档位/);
  const source = sourceJob();
  source.structured.criteria[0].status = 'not_met';
  source.engine = 'gemini';
  source.conversation_id = source.thread_id;
  delete source.thread_id;
  source.task_options = { ...source.task_options, model: null, effort: null };
  const resumed = harness({ source, config: { gemini } });
  await resumed.tools.codex_continue.execute({ job_id: source.job_id, fresh: false }, exec);
  assert.equal(option(resumed.start().argv, '--resume'), source.conversation_id);
  assert.equal(option(resumed.start().argv, '--model'), undefined);
  assert.equal(option(resumed.start().argv, '--effort'), undefined);
  const verification = harness({ source, config: { gemini: { command: gemini.command } } });
  await verification.verify({ engine: 'gemini' });
  assert.equal(option(verification.start().argv, '--resume'), undefined);
  assert.equal(option(verification.start().argv, '--effort'), undefined);
});

test('Gemini provider failure tells the planner how to redispatch on Codex', async () => {
  const failure = { status: 'failed', error_kind: 'provider_permanent', error: 'model not available',
    task_options: { engine: 'gemini' }, structured: undefined };
  const h = harness({ config: { gemini }, verificationResult: failure });
  assert.match((await h.verify()).next, /codex_verify.*SOURCE-1.*engine: "codex"/);
  const task = await h.tools.codex_run.execute({ task: 'Inspect the project layout.', acceptance, write: false, engine: 'gemini' }, exec);
  assert.match(task.next, /codex_run.*engine: "codex"/);
  assert.match(task.next, /model not available/);
  assert.match(nextStep({ ...failure, error_kind: 'bad_arguments', error: 'agy rejected flag --json-schema' }),
    /Gemini 启动参数无效.*--json-schema/);
});

test('a fresh Codex continuation without Gemini uses the current model and service tier', async () => {
  const source = sourceJob();
  source.structured.criteria[0].status = 'not_met';
  const h = harness({ source });
  await h.tools.codex_continue.execute({ job_id: source.job_id, fresh: true }, exec);
  assert.equal(option(h.start().argv, '--resume'), undefined);
  assert.equal(option(h.start().argv, '--model'), 'new-default-model');
  assert.equal(option(h.start().argv, '--service-tier'), 'new-default-tier');
});

test('codex_run uses the configured default engine and a per-task override', async () => {
  const args = { task: 'Inspect the project layout.', acceptance, write: false };
  for (const [requested, selected] of [[undefined, 'gemini'], ['codex', 'codex'], ['gemini', 'gemini']]) {
    const h = harness({ config: { gemini, defaultEngine: 'gemini', maxGeminiRunningJobs: 3, defaultHostAccess: true } });
    await h.tools.codex_run.execute({ ...args, ...(requested ? { engine: requested } : {}) }, exec);
    const { argv } = h.start();
    assert.equal(option(argv, '--sandbox'), 'danger-full-access');
    assert.equal(option(argv, '--engine') ?? 'codex', selected);
    assert.equal(option(argv, '--model'), selected === 'gemini' ? gemini.model : 'new-default-model');
    assert.equal(option(argv, '--effort'), selected === 'gemini' ? gemini.effort : 'medium');
    assert.equal(option(argv, '--max-engine-running'), selected === 'gemini' ? '3' : undefined);
    assert.equal(option(argv, '--service-tier'), selected === 'gemini' ? undefined : 'new-default-tier');
  }
});

test('codex_verify switches engines by default and starts an independent read-only session', async () => {
  for (const [from, override, enabled, to] of [
    ['codex', undefined, true, 'gemini'], ['gemini', undefined, true, 'codex'],
    ['codex', 'codex', true, 'codex'], ['gemini', undefined, false, 'gemini'],
  ]) {
    const source = sourceJob();
    if (from === 'gemini') {
      source.engine = 'gemini';
      source.conversation_id = source.thread_id;
      delete source.thread_id;
    }
    const h = harness({ source, config: { gemini, crossEngineVerify: enabled } });
    await h.verify(override ? { engine: override } : {});
    const { argv } = h.start();
    assert.equal(option(argv, '--engine') ?? 'codex', to);
    assert.equal(option(argv, '--resume'), undefined);
    assert.equal(option(argv, '--sandbox'), undefined);
    assert.equal(h.payload().context.write, false);
    assert.equal(h.payload().context.verification_of, 'SOURCE-1');
    assert.equal(option(argv, '--model'), from === to ? 'original-model' : to === 'gemini' ? gemini.model : 'new-default-model');
  }
});

test('codex_continue retains the native session and settings or starts fresh on an engine switch', async () => {
  for (const [from, to, fresh] of [['gemini', 'gemini', false], ['gemini', 'codex', false], ['codex', 'gemini', false], ['codex', 'codex', true]]) {
    const source = sourceJob();
    source.structured.criteria[0].status = 'not_met';
    if (from === 'gemini') {
      source.engine = 'gemini';
      source.conversation_id = source.thread_id;
      delete source.thread_id;
    }
    const h = harness({ source, config: { gemini, defaultEngine: from === 'codex' ? 'gemini' : 'codex' } });
    await h.tools.codex_continue.execute({ job_id: source.job_id, ...(to !== from ? { engine: to } : {}), fresh }, exec);
    const { argv } = h.start();
    assert.equal(option(argv, '--engine') ?? 'codex', to);
    assert.equal(option(argv, '--resume'), !fresh && from === to ? 'original-thread' : undefined);
    assert.equal(option(argv, '--model'), from === to && !fresh ? 'original-model' : to === 'gemini' ? gemini.model : 'new-default-model');
    assert.equal(option(argv, '--effort'), from === to ? 'low' : 'high');
    assert.equal(option(argv, '--sandbox'), 'workspace-write');
    assert.equal(option(argv, '--service-tier'), to === 'gemini' ? undefined : 'new-default-tier');
    assert.match(h.payload().prompt, /上轮未满足项/);
  }
});

test('terminal Codex failure starts Gemini only on a runner-confirmed no-write result', async () => {
  for (const [fallbackSafe, enabled] of [[true, true], [false, true], [true, false]]) {
    const source = { ...sourceJob(), status: 'failed', error_kind: 'upstream_rejected', fallback_safe: fallbackSafe };
    const h = harness({ source, config: { gemini, geminiFallback: enabled } });
    const value = await h.tools.codex_status.execute({ job_id: source.job_id }, exec);
    if (!fallbackSafe || !enabled) {
      assert.equal(h.start(), undefined);
      assert.equal(value.fallback, undefined);
      continue;
    }
    assert.equal(option(h.start().argv, '--engine'), 'gemini');
    assert.equal(option(h.start().argv, '--resume'), undefined);
    assert.equal(h.payload().context.fallback_of, source.job_id);
    assert.equal(h.payload().context.continuation.parent_job_id, source.job_id);
    assert.deepEqual(h.payload().context.acceptance, acceptance);
    assert.match(h.payload().prompt, /上一轮报告摘要/);
    assert.equal(value.fallback.job_id, 'VERIFY-1');
    assert.match(value.next, /已转交 Gemini 任务 VERIFY-1/);
  }
});

test('must_verify is checked before sampling and needs a matching independent result at closeout', async () => {
  const source = { ...sourceJob(), started_at: 10, finished_at: 20 };
  source.context.must_verify = [2, 1];
  const h = harness({ source, config: { closeoutEvidence: 'off' },
    verificationResult: { execution_status: 'completed', started_at: 21, finished_at: 23 } });
  const criteria = acceptance.map((_, i) => ({ index: i + 1, status: 'met', evidence: 'Reviewed the original report.' }));
  for (const status of ['verified', 'accepted_deviations']) {
    await assert.rejects(h.tools.codex_review.execute({ job_id: source.job_id, status, criteria }, exec),
      /验收第 2 条.*codex_verify[\s\S]*验收第 1 条/);
  }
  assert.ok(!h.calls.some(call => call.argv[0] === 'review'));
  await h.verify({ samples: 1 });
  const { context, prompt } = h.payload();
  assert.match(context.acceptance[0], /^原验收第 2 条（必须实测）/);
  assert.match(context.acceptance[1], /^原验收第 1 条（必须实测）/);
  assert.match(context.acceptance[3], /抽查 1 条/);
  assert.match(prompt, /第 5 条验收的 evidence/);
  for (const status of ['verified', 'accepted_deviations']) {
    const result = await h.tools.codex_review.execute({ job_id: source.job_id, status, criteria }, exec);
    assert.equal(result.verification_status, status);
  }
  delete source.context.must_verify;
  const legacy = harness({ source });
  assert.equal((await legacy.tools.codex_review.execute({ job_id: source.job_id, status: 'verified', criteria }, exec)).verification_status, 'verified');
});

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

test('codex_verify exposes engine selection and sample/wait bounds', () => {
  const { parameters } = harness().tools.codex_verify;
  assert.deepEqual(parameters.required, ['job_id']);
  assert.deepEqual(Object.keys(parameters.properties).sort(), ['engine', 'focus', 'job_id', 'samples', 'wait_seconds']);
  assert.deepEqual(parameters.properties.engine.enum, ['codex', 'gemini']);
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
      assert.match(text, /先验收已收到的报告，再选一单/, name);
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
    await assert.rejects(h.verify({ [field]: value }), field === 'job_id'
      ? { message: 'codex_verify: job_id 无效；请用 codex_jobs 找回 runner 任务编号' }
      : new RegExp(`codex_verify: ${field}`), String(value));
  }
  if (field === 'job_id') {
    for (const args of [undefined, {}]) await assert.rejects(h.tools.codex_verify.execute(args, exec), {
      message: 'codex_verify: job_id 无效；请用 codex_jobs 找回 runner 任务编号',
    });
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
    assert.equal(flag('--effort'), 'medium');
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
    assert.match(h.payload().prompt, /预期从原任务目录实际运行验收检查/);
    if (sandbox === 'danger-full-access') assert.match(h.payload().prompt, /放到项目外的临时目录/);
    else assert.match(h.payload().prompt, /放到 TMPDIR/);
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

test('verification uses readOnlyEffort when set and the original effort otherwise', async () => {
  for (const [readOnlyEffort, expected] of [['medium', 'medium'], ['', 'low']]) {
    const h = harness({ config: { readOnlyEffort } });
    await h.verify();
    const argv = h.start().argv;
    assert.equal(argv[argv.indexOf('--effort') + 1], expected, readOnlyEffort);
  }
});

test('unspecified original model options keep Codex defaults instead of changed plugin defaults', async () => {
  for (const options of [undefined, { effort: null, use_user_config: false }]) {
    const source = sourceJob();
    source.task_options = options;
    const h = harness({ source, config: { readOnlyEffort: '' } });
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
    '是否属实（属实/不属实/无法确认）', '不属实时实际是什么', '有结论不属实时记 not_met', '有无法确认时记 blocked', '条数与验收标准相同，不要为每条抽查结论另加一行',
    'summary 汇总抽查数和结果', '不要只复述原报告', '预期从原任务目录实际运行验收检查', 'files_changed 必须为 []']) {
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
  assert.match(context.acceptance[3], /全程保持项目和系统状态只读/);
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
  assert.match(done.result, /全程保持项目和系统状态只读/);
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
    assert.equal(h.tools.codex_run.description.includes('内容是否属实用 codex_verify'), plannerReads === 'products');
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

test('codex_verify is never subject to the close-out guard', async () => {
  // 收尾护栏默认开启；核验原任务正是收尾的一步，不查也不拦。
  const h = harness();
  await h.verify();
  assert.ok(h.calls.some(({ argv }) => argv[0] === 'start'));
  assert.ok(!h.calls.some(({ argv }) => argv[0] === 'list' && argv.includes('--started-between')));
});

test('a successor session may verify its predecessor\'s job; an unrelated session may not', async (t) => {
  const { createAliases } = await import('./handover.mjs');
  const aliases = createAliases(path.join(localAppData, 'dsh-codex-conductor'));
  aliases.link(exec.agent.id, 'successor-session');
  t.after(() => aliases.unlink(exec.agent.id, 'successor-session'));
  const h = harness();
  const caller = (id) => ({ agent: { ...exec.agent, id } });
  await h.verify({}, caller('successor-session'));
  assert.equal(h.payload().context.owner, 'successor-session');
  assert.equal(h.payload().context.verification_of, 'SOURCE-1');
  await assert.rejects(harness().verify({}, caller('stranger-session')), /不属于当前会话/);
});

test('verify_previous starts the verification with the new unit, only when their files cannot overlap', async () => {
  const unit = { task: '在另一个子目录整理测试夹具并补说明', acceptance: ['夹具说明已补全'], wait_seconds: 0 };
  const starts = (h) => h.calls.filter(({ argv }) => argv[0] === 'start').map(({ stdin }) => JSON.parse(stdin).context);
  // 只读新单：总是允许；核验任务与 codex_verify 派出的一样（原任务、归属、只读）。
  const readOnly = harness();
  const value = await readOnly.tools.codex_run.execute({ ...unit, write: false, verify_previous: 'SOURCE-1' }, exec);
  const [main, verification] = starts(readOnly);
  assert.equal(main.verification_of, undefined);
  assert.deepEqual([verification.verification_of, verification.owner, verification.write], ['SOURCE-1', exec.agent.id, false]);
  assert.equal(value.verify_previous.job_id, 'VERIFY-1');
  assert.match(value.next, /已同时派出对 SOURCE-1 的只读核验[\s\S]*codex_continue 返工原任务/);
  // 可写新单与被核验任务的 scope 或产物重叠（任一方向包含）：拒绝，什么都不派。
  for (const args of [{ cwd: '/work/original', scope: ['docs/sub'] }, { cwd: '/work/original' }, { cwd: '/work', scope: ['original'] }]) {
    const h = harness();
    await assert.rejects(h.tools.codex_run.execute({ ...unit, write: true, ...args, verify_previous: 'SOURCE-1' }, exec),
      /与任务 SOURCE-1 的产物或 scope 重叠，不能边改边核验[\s\S]*先 codex_verify SOURCE-1/, JSON.stringify(args));
    assert.equal(starts(h).length, 0);
  }
  // /mnt 下不分大小写。
  const mnt = { ...sourceJob(), cwd: '/mnt/E/Work', scope: ['docs'], scope_paths: ['/mnt/E/Work/docs'], files_changed: [], write_paths: [] };
  await assert.rejects(harness({ source: mnt }).tools.codex_run.execute({ ...unit, write: true, cwd: '/mnt/e/work', scope: ['DOCS/a.md'], verify_previous: 'SOURCE-1' }, exec),
    /重叠/);
  // 不重叠的可写新单：两单都派出。
  const apart = harness();
  await apart.tools.codex_run.execute({ ...unit, write: true, cwd: '/work/original', scope: ['fixtures'], verify_previous: 'SOURCE-1' }, exec);
  assert.equal(starts(apart).length, 2);
  // 不属于本会话的任务：拒绝。
  await assert.rejects(harness().tools.codex_run.execute({ ...unit, write: false, verify_previous: 'SOURCE-1' },
    { agent: { ...exec.agent, id: 'stranger-session' } }), /归属未知或不属于当前会话/);
});

test('verify_previous reports a verification that could not start without undoing the new unit', async () => {
  // 运行数上限只够一单：新单派出，核验被上限挡住，结果里说明，规划端之后再 codex_verify。
  const h = harness({ config: { maxRunningJobs: 1 } });
  const value = await h.tools.codex_run.execute({ task: '在另一个子目录整理测试夹具并补说明', acceptance: ['夹具说明已补全'], write: false,
    wait_seconds: 0, verify_previous: 'SOURCE-1' }, exec);
  assert.ok(value.job_id);
  assert.match(value.verify_previous.error, /maxRunningJobs/);
  assert.match(value.next, /对 SOURCE-1 的核验没有派出[\s\S]*之后再用 codex_verify SOURCE-1/);
});

test('two verifications can be in flight: verify_previous on two units starts one verification each', async () => {
  const h = harness();
  for (const task of ['在另一个子目录整理测试夹具并补说明', '再核对一遍发布说明的链接与版本号']) {
    await h.tools.codex_run.execute({ task, acceptance: ['结果已写清楚'], write: false, wait_seconds: 0, verify_previous: 'SOURCE-1' }, exec);
  }
  const contexts = h.calls.filter(({ argv }) => argv[0] === 'start').map(({ stdin }) => JSON.parse(stdin).context);
  assert.equal(contexts.filter((context) => context.verification_of === 'SOURCE-1').length, 2);
  assert.equal(contexts.filter((context) => !context.verification_of).length, 2);
});

test('a verification lists every criterion the original report marked blocked or not met as its own acceptance item', async () => {
  const source = sourceJob();
  source.structured.criteria[1] = { ...source.structured.criteria[1], status: 'blocked' };
  const h = harness({ source });
  await h.verify();
  const items = h.payload().context.acceptance;
  assert.equal(items.filter((item) => item.startsWith('原验收第 ')).length, 1);
  assert.match(items.at(-1), /^原验收第 2 条（原报告标 blocked）：逐条核实结论的原始出处——独立核实现在是否满足/);
  const clean = harness();
  await clean.verify();
  assert.ok(!clean.payload().context.acceptance.some((item) => item.startsWith('原验收第 ')));
  // 报告比验收多出一行且这一行对不上验收原文：按报告行号单列。
  const extra = sourceJob();
  extra.structured.criteria.push({ criterion: '额外抽查的一条', status: 'not_met', evidence: '不属实' });
  const hx = harness({ source: extra });
  await hx.verify();
  assert.equal(hx.payload().context.acceptance.at(-1), '原报告第 3 行（原报告标 not_met，未对上原验收清单）：额外抽查的一条——独立核实现在是否满足：满足记 met，不满足记 not_met，无法核实记 blocked，evidence 写出处。');
});
