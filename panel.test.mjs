import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createPanelApi, panelSettings, registerPanel, PANEL_PATH } from './panel.mjs';
import './client-panel.test.mjs';

const routes = [
  ['GET', '/status'], ['GET', '/attention'], ['GET', '/settings'], ['POST', '/settings', { model: 'new-model' }],
  ['POST', '/settings/apply', { changes: { model: 'new-model' }, confirm: true }], ['POST', '/settings/cancel', {}],
  ['GET', '/jobs'], ['GET', '/output?job_id=job-1'],
  ['POST', '/cancel', { job_id: 'job-1', confirm: true }],
  ['GET', '/prompt'], ['POST', '/prompt', { text: 'updated' }], ['POST', '/reload', {}],
  ['GET', '/selftest/request'], ['POST', '/selftest/result', {}],
  ['GET', '/prompt/backups'], ['GET', '/prompt/backup?name=planner.md.bak'], ['GET', '/doctor'], ['GET', '/gemini'],
  ['POST', '/session/send', { sessionId: 'session-a', message: 'hello' }], ['POST', '/session/resume', { sessions: ['session-a'] }],
  ['POST', '/session/goal', { sessionId: 'session-a', maxGoalRounds: 3 }], ['GET', '/session/results'],
  ['POST', '/rollback', { job_id: 'job-1', confirm: true }],
  ['POST', '/handover/request', { sessionId: 'session-a' }], ['POST', '/handover/answer', { sessionId: 'session-a', accept: false }],
  ['POST', '/auto-answer/action', { id: 'c8fe4dc0-9678-49f0-8e54-f63941a713b2', action: 'answer' }],
];

// Model Cordis injection ownership: only changed dependencies restart a child callback.
function serviceContext(t, services = {}) {
  const injections = new Set();
  const ctx = {
    get: (name) => services[name],
    inject: t.mock.fn((dependencies, callback) => {
      let cleanup;
      const injection = { dependencies, update() {
        cleanup?.();
        cleanup = dependencies.every((name) => services[name] != null) ? callback(Object.create(ctx)) : undefined;
      } };
      injections.add(injection);
      injection.update();
      const fiber = { dispose() {
        injections.delete(injection);
        cleanup?.();
        cleanup = undefined;
      } };
      t.after(() => fiber.dispose());
      return fiber;
    }),
    set(name, value) {
      services[name] = value;
      for (const injection of injections) if (injection.dependencies.includes(name)) injection.update();
    },
  };
  return ctx;
}

function fixture(t, options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'conductor-panel-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plannerFile = path.join(root, 'planner.md');
  writeFileSync(plannerFile, '原有规划要求🙂\n');
  const cfg = { model: 'gpt-6', effort: 'high', readOnlyEffort: '', serviceTier: 'fast',
    plannerAnswers: false, lockTimeoutSeconds: 10, maxStorageMb: 256,
    runner: 'private-runner', profileFile: 'private-profile', token: 'private-token',
    gemini: { model: 'gemini-4', effort: 'medium', command: 'private-command', token: 'private-token' } };
  const state = { state: 'synchronized', active_tasks: 0, can_reload: true };
  const jobs = [{ job_id: 'job-1', started_at: 123, status: 'running', execution_status: 'running',
    context: { task: '🙂'.repeat(65), secret: 'private-context' }, verification_status: 'needs_changes',
    cwd: 'private-directory', report: { secret: 'private-report' } }];
  const runtime = { execute: t.mock.fn(async (args) => args.action === 'status' ? state : { status: 'reloaded', saved: true }),
    cancelPending: t.mock.fn(() => ({ cancelled: true })) };
  const conductor = {
    list: t.mock.fn(async () => ({ total: jobs.length, jobs, next_offset: null })),
    output: t.mock.fn(async () => ({ text: '报告🙂', next_offset: 4, eof: true })),
    cancel: t.mock.fn(async (job_id) => ({ job_id, status: 'cancelled' })),
    doctor: t.mock.fn(async () => ({ status: 'completed', ok: true, checks: [{ name: 'python', ok: true, detail: '3.12' }] })),
    rollback: t.mock.fn(async (job_id, { check }) => ({ status: 'completed', job_id, rolled_back: !check, checked: true, files: 3 })),
  };
  const connection = { requestRejection: t.mock.fn(() => undefined) };
  const web = { register: t.mock.fn((route) => { handler = route.handler; return unregister; }) };
  const unregister = t.mock.fn(() => { handler = undefined; });
  const settings = {};
  let handler;
  const services = { webServer: web, settings, connection, ...options.services };
  const ctx = serviceContext(t, services);
  const apiOptions = { cfg, conductor, runtime, plannerFile, selftestDirectory: root, ...options.api };
  const registration = registerPanel({ ctx, ...apiOptions });
  async function request(method, route, body, { raw, chunks, contentType = 'application/json' } = {}) {
    if (!handler) return { status: 404 };
    const bytes = Buffer.from(raw ?? (body === undefined ? '' : JSON.stringify(body)));
    const req = { method, url: PANEL_PATH + route, headers: { 'content-type': contentType },
      async *[Symbol.asyncIterator]() { yield* chunks ?? [bytes]; } };
    const headers = {};
    const res = { setHeader: (name, value) => { headers[name] = value; },
      end: (value) => { res.body = JSON.parse(value); } };
    await handler(req, res);
    assert.equal(headers['Content-Type'], 'application/json; charset=utf-8');
    assert.equal(headers['Cache-Control'], 'no-store');
    return { status: res.statusCode, body: res.body };
  }
  const calls = () => { assert.equal(conductor.doctor.mock.callCount() + conductor.rollback.mock.callCount(), 0); return [runtime.execute, conductor.list, conductor.output, conductor.cancel]
    .map((fn) => fn.mock.callCount()); };
  return { root, plannerFile, cfg, state, jobs, runtime, conductor, connection, web, ctx, services,
    unregister, registration, request, calls, api: createPanelApi(apiOptions) };
}

function rejected(response, status, message) {
  if (status === undefined) assert.ok(response.status >= 400, JSON.stringify(response));
  else assert.equal(response.status, status, JSON.stringify(response));
  assert.equal(typeof response.body.error, 'string');
  if (message) assert.match(response.body.error, message);
}

test('panel reads return HTTP 504 within 15 seconds even when query services never settle', async (t) => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals = [];
  f.runtime.execute.mock.mockImplementation((_args, { signal }) => {
    signals.push(signal);
    return new Promise(() => {});
  });
  for (const method of ['list', 'output']) f.conductor[method].mock.mockImplementation((...args) => {
    signals.push(args.at(-1));
    return new Promise(() => {});
  });
  let settled = false;
  const responses = Promise.all(['/status', '/jobs?filter=all&offset=0', '/attention', '/output?job_id=J']
    .map((route) => f.request('GET', route))).then((result) => { settled = true; return result; });
  t.mock.timers.tick(14_999);
  await new Promise(setImmediate);
  assert.equal(settled, false);
  assert.equal((await f.request('GET', '/settings')).status, 200);
  assert.equal((await f.request('GET', '/prompt')).status, 200);
  t.mock.timers.tick(1);
  for (const response of await responses) rejected(response, 504, /查询超过 15 秒.*重试/);
  assert.equal(signals.length, 4);
  assert.ok(signals.every((signal) => signal.aborted));
  assert.equal(f.conductor.cancel.mock.callCount(), 0);
});

test('panel report pagination shares one deadline and cannot swallow its timeout as optional context', async (t) => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let contextSignal;
  f.conductor.output.mock.mockImplementation(async (_id, { artifact, offset }, signal) => {
    if (artifact === 'report') return { text: 'report', eof: true };
    contextSignal = signal;
    if (offset > 0) return new Promise(() => {});
    await new Promise((resolve) => setTimeout(resolve, 9000));
    return { text: '{', next_offset: 8000, eof: false };
  });
  const response = f.request('GET', '/output?job_id=J');
  await new Promise(setImmediate);
  t.mock.timers.tick(9000);
  await new Promise(setImmediate);
  assert.equal(f.conductor.output.mock.callCount(), 3);
  t.mock.timers.tick(6000);
  rejected(await response, 504, /查询超过 15 秒/);
  assert.equal(contextSignal.aborted, true);
});

const selftestSample = () => ({
  settingsRegistered: true, sections: { 运行状态: true, 常用设置: true, 最近任务: true, 规划提示词: true },
  status: { version: '0.9.61', model: 'gpt-6', effort: '高', serviceTier: 'fast' }, taskCount: 1,
  report: { opened: true, summary: true, criteria: true, firstCriterion: '第 1 条：面板正常渲染 —— 通过' },
  http: [{ path: '/status', status: 200 }, { path: '/output?job_id=job-1&offset=0&limit=8000', status: 200 }],
  errors: [], userAgent: 'Mozilla/5.0 Electron/40.0.0', origin: 'http://localhost:1234', timedOut: false,
});

test('selftest without a request neither creates files nor calls the panel services', async (t) => {
  const f = fixture(t);
  const before = readdirSync(f.root);
  for (let i = 0; i < 2; i++) assert.deepEqual(await f.request('GET', '/selftest/request'), { status: 200, body: { request: null } });
  assert.deepEqual(readdirSync(f.root), before);
  assert.deepEqual(f.calls(), [0, 0, 0, 0]);
  const missing = fixture(t, { api: { selftestDirectory: path.join(f.root, 'absent') } });
  assert.deepEqual((await missing.request('GET', '/selftest/request')).body, { request: null });
  const headless = fixture(t, { api: { selftestDirectory: '' } });
  assert.deepEqual((await headless.request('GET', '/selftest/request')).body, { request: null });
  rejected(await headless.request('POST', '/selftest/result', { id: '', claim: '', result: selftestSample() }), 409);
  assert.deepEqual(readdirSync(f.root), before);
});

test('selftest atomically claims each request once and atomically replaces the last result', async (t) => {
  const f = fixture(t);
  for (const input of [{}, { id: 'desktop-🙂' }]) {
    writeFileSync(path.join(f.root, 'panel-selftest-request.json'), JSON.stringify(input));
    const responses = await Promise.all(Array.from({ length: 3 }, () => f.request('GET', '/selftest/request')));
    const claims = responses.map((item) => item.body.request).filter(Boolean);
    assert.equal(claims.length, 1);
    const request = claims[0];
    assert.equal(request.id, input.id ?? request.claim);
    assert.equal(readdirSync(f.root).filter((name) => name.endsWith('.processing.json')).length, 1);
    const body = { ...request, result: selftestSample() };
    const response = await f.request('POST', '/selftest/result', body);
    assert.deepEqual(response, { status: 200, body: { saved: true } });
    const saved = JSON.parse(readFileSync(path.join(f.root, 'panel-selftest-result.json'), 'utf8'));
    assert.deepEqual(saved, { id: request.id, version: JSON.parse(readFileSync(new URL('./package.json', import.meta.url))).version,
      pid: process.pid, receivedAt: saved.receivedAt, ...body.result });
    assert.ok(Number.isFinite(Date.parse(saved.receivedAt)));
    assert.deepEqual(readdirSync(f.root).sort(), ['panel-selftest-result.json', 'planner.md']);
    rejected(await f.request('POST', '/selftest/result', body), 409);
  }
  assert.deepEqual(f.calls(), [0, 0, 0, 0]);
  assert.equal(f.runtime.cancelPending.mock.callCount(), 0);
  assert.equal(readFileSync(f.plannerFile, 'utf8'), '原有规划要求🙂\n');
});

test('selftest rejects malformed requests and invalid, unclaimed or oversized results', async (t) => {
  const f = fixture(t);
  for (const request of ['{', 'null', '[]', '{"id":12}', '{"id":"' + 'x'.repeat(129) + '"}', '{"path":"elsewhere"}', ' '.repeat(4097)]) {
    writeFileSync(path.join(f.root, 'panel-selftest-request.json'), request);
    rejected(await f.request('GET', '/selftest/request'), request.length > 4096 ? 413 : 400);
  }
  writeFileSync(path.join(f.root, 'panel-selftest-request.json'), '{"id":"valid"}');
  const request = (await f.request('GET', '/selftest/request')).body.request;
  const result = selftestSample();
  const invalid = [null, [], {}, { ...result, injected: true }, { ...result, settingsRegistered: 1 },
    { ...result, sections: { ...result.sections, 最近任务: 'yes' } }, { ...result, status: { ...result.status, model: 42 } },
    { ...result, taskCount: -1 }, { ...result, taskCount: 21 }, { ...result, timedOut: 'false' },
    { ...result, report: { ...result.report, firstCriterion: '🙂'.repeat(81) } },
    { ...result, errors: [123] }, { ...result, userAgent: null }, { ...result, origin: false },
    { ...result, http: [{ path: '/reload', status: 200 }] }, { ...result, http: [{ path: '/status', status: '200' }] },
    { ...result, http: [{ path: '/status', status: 600 }] }];
  for (const value of invalid) rejected(await f.request('POST', '/selftest/result', { ...request, result: value }), 400);
  rejected(await f.request('POST', '/selftest/result', { ...request, pid: 1, result }), 400);
  rejected(await f.request('POST', '/selftest/result', { ...request, id: 'wrong', result }), 409);
  rejected(await f.request('POST', '/selftest/result', { ...request, claim: 'unknown', result }), 409);
  const oversized = JSON.stringify({ ...request, result: { ...result, errors: ['x'.repeat(65536)] } });
  rejected(await f.request('POST', '/selftest/result', undefined, { raw: oversized }), 413);
  await assert.rejects(f.api('POST', PANEL_PATH + '/selftest/result', {}, JSON.parse(oversized)), { status: 413 });
  assert.equal(readdirSync(f.root).some((name) => name === 'panel-selftest-result.json' || name.endsWith('.tmp')), false);
  assert.deepEqual(f.calls(), [0, 0, 0, 0]);
  assert.equal((await f.request('POST', '/selftest/result', { ...request, result })).status, 200);
});

test('panel settings expose editable fields and read scope counts while redacting private configuration', () => {
  const cfg = { model: 'model', effort: 'high', readOnlyEffort: '', serviceTier: '', plannerAnswers: true,
    lockTimeoutSeconds: 1.5, maxStorageMb: 256, token: 'secret', runner: 'secret',
    gemini: { model: 'gemini', effort: 'low', command: 'secret' } };
  const expected = { acceptOpenEvidence: 'strict', ownerDecisions: 'planner', model: 'model', effort: 'high', readOnlyEffort: '', serviceTier: '', plannerAnswers: true,
    lockTimeoutSeconds: 1.5, maxStorageMb: 256, plannerReads: 'open', plannerReadAllowCount: 0, gemini: { model: 'gemini', effort: 'low', accountPool: false },
    defaultEngine: 'codex', lockEngine: false, crossEngineVerify: true, geminiFallback: true, maxGeminiRunningJobs: null,
    timeoutSeconds: null, idleTimeoutSeconds: null, retries: null, maxRunningJobs: null, autoResume: { enabled: true },
    roots: [], allowHostAccess: false, defaultHostAccess: false, unknownConfig: [], autoVerify: 'flagged',
    toolPolicy: 'denylist', allowTools: [], plannerReadAllow: [], maxSessionJobs: null, maxSessionTokens: null, jobDiff: false, closeoutGuard: true, handoverSuggestMessages: 5000, acceptanceWarnAbove: 8, continueFreshAboveTokens: 100000, closeoutEvidence: 'independent',
    effortOverride: 'planner', repeatFailureGuard: { enabled: true, minSeconds: 60, failures: 2, windowHours: 24 }, seenTools: [] };
  assert.deepEqual(panelSettings(cfg), expected);
  const tools = { toolPolicy: 'allowlist', allowTools: ['codex_run', 'mcp__docs__*'], maxSessionJobs: 20, maxSessionTokens: 5000000,
    jobDiff: true, seenTools: new Set(['zeta_tool', 'alpha_tool']) };
  const shown = panelSettings({ ...cfg, ...tools });
  assert.deepEqual(shown, { ...expected, ...tools, seenTools: ['alpha_tool', 'zeta_tool'] });
  assert.notEqual(shown.allowTools, tools.allowTools, 'arrays are copied, not shared with the live configuration');
  assert.deepEqual(panelSettings({ ...cfg, timeoutSeconds: 900, idleTimeoutSeconds: 60, retries: 0, maxRunningJobs: 2,
    autoResume: { enabled: false, message: 'private-message', exclude: ['private-session'] }, roots: ['*'], allowHostAccess: true,
    defaultHostAccess: true, unknownConfig: ['timoutSeconds'] }),
  { ...expected, timeoutSeconds: 900, idleTimeoutSeconds: 60, retries: 0, maxRunningJobs: 2, autoResume: { enabled: false },
    roots: ['*'], allowHostAccess: true, defaultHostAccess: true, unknownConfig: ['timoutSeconds'] });
  assert.deepEqual(cfg.gemini, { model: 'gemini', effort: 'low', command: 'secret' });
  assert.deepEqual(panelSettings({ ...cfg, gemini: { ...cfg.gemini, accountPool: 'D:\\private\\pool.json' }, defaultEngine: 'gemini',
    crossEngineVerify: false, geminiFallback: false, maxGeminiRunningJobs: 3 }),
  { ...expected, gemini: { ...expected.gemini, accountPool: true }, defaultEngine: 'gemini', crossEngineVerify: false,
    geminiFallback: false, maxGeminiRunningJobs: 3 }, 'the pool path itself is not shown');
  assert.equal(panelSettings({ ...cfg, gemini: undefined }).gemini, null);
  assert.deepEqual(panelSettings({ ...cfg, plannerReads: 'products', plannerReadAllow: ['C:\\private', '/mnt/e/allowed'] }),
    { ...expected, plannerReads: 'products', plannerReadAllowCount: 2, plannerReadAllow: ['C:\\private', '/mnt/e/allowed'] });
});

test('panel read scope switch uses existing save and confirmed apply routes and reports the extra readable paths', async (t) => {
  const f = fixture(t);
  f.cfg.plannerReads = 'products';
  f.cfg.plannerReadAllow = ['C:\\private'];
  const status = await f.request('GET', '/status');
  assert.equal(status.body.settings.plannerReads, 'products');
  assert.equal(status.body.settings.plannerReadAllowCount, 1);
  assert.deepEqual(status.body.settings.plannerReadAllow, ['C:\\private']);
  for (const plannerReads of ['open', 'products']) {
    assert.equal((await f.request('POST', '/settings', { plannerReads })).status, 200);
    assert.deepEqual(f.runtime.execute.mock.calls.at(-1).arguments,
      [{ action: 'reload', when: 'idle' }, { panel: true }, { plannerReads }]);
    assert.equal((await f.request('POST', '/settings/apply', { changes: { plannerReads }, confirm: true })).status, 200);
    assert.deepEqual(f.runtime.execute.mock.calls.at(-1).arguments,
      [{ action: 'reload', when: 'now' }, { panel: true }, { plannerReads }]);
  }
  const calls = f.runtime.execute.mock.callCount();
  for (const changes of [{ plannerReads: true }, { plannerReads: 'all' }, { plannerReadAllowCount: 0 }, { seenTools: [] }]) {
    assert.equal((await f.request('POST', '/settings', changes)).status, 400);
  }
  assert.equal((await f.request('POST', '/settings/apply', { changes: { plannerReads: 'open' } })).status, 400);
  assert.equal(f.runtime.execute.mock.callCount(), calls);
});

test('panel registers its prefix in an injection child and disposes with it', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.ctx.inject.mock.calls[0].arguments[0], ['webServer', 'settings']);
  assert.equal(f.web.register.mock.callCount(), 1);
  const [route] = f.web.register.mock.calls[0].arguments;
  assert.equal(route.kind, 'prefix');
  assert.equal(route.path, PANEL_PATH);
  f.registration.dispose();
  assert.equal(f.unregister.mock.callCount(), 1);
  const jobs = { attachController: t.mock.fn() };
  fixture(t, { services: { jobs } });
  assert.deepEqual(jobs.attachController.mock.calls[0].arguments, ['codex-conductor-panel']);
  assert.doesNotThrow(() => fixture(t, { services: { jobs: {} } }));
});

test('panel stays idle without optional services, including a headless context', async (t) => {
  for (const services of [{ webServer: undefined }, { settings: undefined }, { webServer: {} }]) {
    const missing = fixture(t, { services });
    assert.equal((await missing.request('GET', '/status')).status, 404);
    assert.equal(missing.web.register.mock.callCount(), 0);
    missing.registration.dispose();
    assert.equal(missing.unregister.mock.callCount(), 0);
  }
  const headless = serviceContext(t);
  assert.doesNotThrow(() => registerPanel({ ctx: headless }));
  assert.equal(registerPanel({ ctx: {} }), undefined);
});

test('panel registers when web/settings services arrive after plugin load in either order', async (t) => {
  for (const order of [['webServer', 'settings'], ['settings', 'webServer']]) {
    const f = fixture(t, { services: { webServer: undefined, settings: undefined } });
    const services = { webServer: f.web, settings: {} };
    assert.equal((await f.request('GET', '/status')).status, 404);
    f.ctx.set(order[0], services[order[0]]);
    assert.equal(f.web.register.mock.callCount(), 0);
    f.ctx.set(order[1], services[order[1]]);
    assert.equal(f.web.register.mock.callCount(), 1);
    assert.equal((await f.request('GET', '/status')).status, 200);
  }
});

test('panel unregisters when either dependency disappears and registers again on return', async (t) => {
  for (const dependency of ['webServer', 'settings']) {
    const f = fixture(t);
    const service = f.services[dependency];
    f.ctx.set(dependency, undefined);
    assert.equal(f.unregister.mock.callCount(), 1);
    assert.equal((await f.request('GET', '/status')).status, 404);
    f.ctx.set(dependency, service);
    assert.equal(f.web.register.mock.callCount(), 2);
    assert.equal((await f.request('GET', '/status')).status, 200);
    f.registration.dispose();
    assert.equal(f.unregister.mock.callCount(), 2);
    f.ctx.set(dependency, service);
    assert.equal(f.web.register.mock.callCount(), 2);
    assert.equal((await f.request('GET', '/status')).status, 404);
  }
});

test('panel reads the current connection on every request as authentication appears and disappears', async (t) => {
  const f = fixture(t, { services: { connection: undefined } });
  rejected(await f.request('GET', '/status'), 503);
  const connection = { requestRejection: () => 401 };
  f.ctx.set('connection', connection);
  rejected(await f.request('GET', '/status'), 401);
  f.ctx.set('connection', f.connection);
  assert.equal((await f.request('GET', '/status')).status, 200);
  f.ctx.set('connection', undefined);
  rejected(await f.request('GET', '/status'), 503);
  f.ctx.set('connection', connection);
  rejected(await f.request('GET', '/status'), 401);
  assert.equal(f.web.register.mock.callCount(), 1);
  assert.equal(f.unregister.mock.callCount(), 0);
});

test('panel status names the pooled Gemini account and the job list marks Gemini runs', async (t) => {
  const f = fixture(t);
  const pool = path.join(f.root, 'pool.json');
  f.cfg.gemini.accountPool = pool;
  writeFileSync(pool, JSON.stringify({ activeAccountIds: { google: 'acc_2' }, accounts: [
    { id: 'acc_1', dir: 'D:/pool/1', enabled: true, refreshToken: 'private-token' },
    { id: 'acc_2', alias: 'work', dir: 'D:/pool/2', enabled: true, refreshToken: 'private-token' }] }));
  let status = await f.request('GET', '/status');
  assert.deepEqual(status.body.geminiAccount, { id: 'acc_2', alias: 'work' });
  assert.ok(!JSON.stringify(status.body).includes('private'), 'only the account name leaves the pool');
  writeFileSync(pool, JSON.stringify({ accounts: [] }));
  status = await f.request('GET', '/status');
  assert.match(status.body.geminiAccount.error, /没有可用账号/);
  f.jobs.push({ job_id: 'job-2', started_at: 124, status: 'completed', engine: 'gemini', context: { task: 't', fallback_of: 'job-1' } },
    { job_id: 'job-3', started_at: 125, status: 'completed', task_options: { engine: 'gemini' }, context: { task: 't' } });
  const { jobs } = (await f.request('GET', '/jobs')).body;
  assert.deepEqual(jobs.map((job) => [job.engine, job.fallback_of]), [[undefined, undefined], ['gemini', 'job-1'], ['gemini', undefined]]);
});

test('panel HTTP implements every valid route using only stub runtime/conductor', async (t) => {
  const f = fixture(t);
  const status = await f.request('GET', '/status');
  assert.deepEqual(status, { status: 200, body: { runtime: f.state, settings: panelSettings(f.cfg), history: null, handover: null } });
  assert.deepEqual(f.runtime.execute.mock.calls[0].arguments[0], { action: 'status' });
  assert.equal(f.runtime.execute.mock.calls[0].arguments[1].panel, true, 'status polls are marked as panel reads');
  assert.ok(f.runtime.execute.mock.calls[0].arguments[1].signal instanceof AbortSignal);
  assert.equal(f.conductor.list.mock.callCount(), 0);
  t.mock.method(Date, 'now', () => 1800000000000);
  assert.deepEqual(await f.request('GET', '/attention'), { status: 200, body: { total: 1 } });
  assert.deepEqual(f.conductor.list.mock.calls[0].arguments.slice(0, 1),
    [{ needs_attention: true, limit: 1, started_between: [1799913600, 1800000000] }]);
  assert.deepEqual(await f.request('GET', '/settings'), { status: 200, body: panelSettings(f.cfg) });
  const settings = { model: 'codex/gpt-6:latest', plannerAnswers: true, gemini: { effort: 'high' } };
  assert.deepEqual(await f.request('POST', '/settings', settings),
    { status: 200, body: { saved: true, runtime: { status: 'reloaded', saved: true } } });
  assert.deepEqual(f.runtime.execute.mock.calls.at(-1).arguments, [{ action: 'reload', when: 'idle' }, { panel: true }, settings]);
  assert.equal((await f.request('POST', '/settings/apply', { changes: settings, confirm: true })).body.saved, true);
  assert.deepEqual(f.runtime.execute.mock.calls.at(-1).arguments, [{ action: 'reload', when: 'now' }, { panel: true }, settings]);
  assert.deepEqual(await f.request('POST', '/settings/cancel', {}), { status: 200, body: { cancelled: true } });
  for (const [query, expected] of [['', {}], ['?filter=all', {}], ['?filter=running', { status: 'running' }],
    ['?filter=attention', { needs_attention: true }]]) {
    const response = await f.request('GET', '/jobs' + query);
    assert.deepEqual(response, { status: 200, body: { total: 1, next_offset: null, jobs: [{ job_id: 'job-1', started_at: 123,
      status: 'running', execution_status: 'running', title: '🙂'.repeat(60), needs_attention: true,
      cwd: 'private-directory', verification_status: 'needs_changes' }] } });
    assert.deepEqual(f.conductor.list.mock.calls.at(-1).arguments.slice(0, 1), [{ limit: 20, offset: 0, ...expected }]);
  }
  assert.deepEqual(await f.request('GET', '/output?job_id=job-1'),
    { status: 200, body: { text: '报告🙂', next_offset: 4, eof: true } });
  assert.deepEqual(f.conductor.output.mock.calls[0].arguments.slice(0, 2), ['job-1', { artifact: 'report', offset: 0, limit: 8000 }]);
  assert.deepEqual(f.conductor.output.mock.calls[1].arguments.slice(0, 2), ['job-1', { artifact: 'context', offset: 0, limit: 8000 }]);
  assert.equal((await f.request('GET', '/output?job_id=J_2&offset=12&limit=20000')).status, 200);
  assert.deepEqual(f.conductor.output.mock.calls.at(-1).arguments.slice(0, 2), ['J_2', { artifact: 'report', offset: 12, limit: 20000 }]);
  // A job that ended before writing its report is a 404 with a readable hint, not a task-service failure.
  for (const error_kind of ['artifact_empty', 'artifact_missing']) {
    f.conductor.output.mock.mockImplementationOnce(async () => ({ status: 'failed', error_kind, execution_status: 'failed' }));
    const missing = await f.request('GET', '/output?job_id=J_3');
    assert.equal(missing.status, 404);
    assert.match(missing.body.error, /没有这份内容.*错误日志/);
  }
  assert.deepEqual(await f.request('POST', '/cancel', { job_id: 'job-1', confirm: true }),
    { status: 200, body: { job_id: 'job-1', status: 'cancelled' } });
  assert.deepEqual(f.conductor.cancel.mock.calls[0].arguments, ['job-1']);
  assert.deepEqual(await f.request('GET', '/prompt'), { status: 200, body: { text: '原有规划要求🙂\n', injected: false } });
  assert.deepEqual(await f.request('POST', '/prompt', { text: '新规划🙂\n' }), { status: 200, body: { saved: true } });
  assert.equal(readFileSync(f.plannerFile, 'utf8'), '新规划🙂\n');
  const backups = readdirSync(f.root).filter((name) => name.endsWith('.bak'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(path.join(f.root, backups[0]), 'utf8'), '原有规划要求🙂\n');
  assert.equal((await f.request('POST', '/prompt', { text: '' })).status, 200);
  assert.equal(readFileSync(f.plannerFile, 'utf8'), '');
  const unrelated = ['planner.md.bak', 'planner.md.2026-01-01T00-00-00-000Z.not-a-uuid.bak', 'other.md.2026-01-01T00-00-00-000Z.00000000-0000-4000-8000-000000000000.bak'];
  for (const name of unrelated) writeFileSync(path.join(f.root, name), 'keep');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  for (let n = 0; n < 12; n++) {
    t.mock.timers.tick(1); // backup names sort by their millisecond timestamp
    assert.equal((await f.request('POST', '/prompt', { text: `第 ${n} 版` })).status, 200);
  }
  const kept = readdirSync(f.root).filter((name) => name.endsWith('.bak') && !unrelated.includes(name)).sort();
  assert.equal(kept.length, 10, 'only the ten newest prompt backups remain');
  assert.deepEqual(kept.map((name) => readFileSync(path.join(f.root, name), 'utf8')), Array.from({ length: 10 }, (_, n) => `第 ${n + 1} 版`));
  for (const name of unrelated) assert.equal(readFileSync(path.join(f.root, name), 'utf8'), 'keep');
  assert.deepEqual(await f.request('POST', '/reload', {}), { status: 200, body: { status: 'reloaded', saved: true } });
  assert.deepEqual(f.runtime.execute.mock.calls.at(-1).arguments, [{ action: 'reload', when: 'idle' }, { panel: true }, undefined]);
});

test('panel returns pending report pages as HTTP 200 without reading optional context', async (t) => {
  const f = fixture(t);
  for (const pending of [
    { job_id: 'J', artifact: 'report', execution_status: 'running', status: 'pending', error_kind: 'artifact_pending', retryable: true },
    { job_id: 'J', artifact: 'report', execution_status: 'running', status: 'pending' },
  ]) {
    f.conductor.output.mock.mockImplementation(async () => pending);
    for (const offset of [0, 8000]) {
      const before = f.conductor.output.mock.callCount();
      assert.deepEqual(await f.request('GET', `/output?job_id=J&offset=${offset}`), {
        status: 200, body: { ...pending, status: 'pending', error_kind: 'artifact_pending',
          message: '这个任务还在运行，报告会在任务结束后生成。' },
      });
      assert.equal(f.conductor.output.mock.callCount(), before + 1);
    }
  }
  for (const failure of [
    { status: 'failed', error_kind: 'artifact_read_failed' },
    { status: 'pending', error_kind: 'artifact_read_failed' },
    { status: 'pending', error: 'runner read failed' },
  ]) {
    f.conductor.output.mock.mockImplementation(async () => failure);
    rejected(await f.request('GET', '/output?job_id=J'), 502);
  }
});

test('panel stops optional context pagination on pending without losing a ready report', async (t) => {
  const f = fixture(t);
  const report = { text: '报告', eof: true };
  for (const pendingAt of [0, 8000]) {
    const reads = [];
    f.conductor.output.mock.mockImplementation(async (_id, { artifact, offset }) => {
      if (artifact === 'report') return report;
      reads.push(offset);
      return offset === pendingAt ? { status: 'pending', error_kind: 'artifact_pending', retryable: true }
        : { text: '{', eof: false, next_offset: pendingAt };
    });
    assert.deepEqual(await f.request('GET', '/output?job_id=J'), { status: 200, body: report });
    assert.deepEqual(reads, pendingAt === 0 ? [0] : [0, 8000]);
  }
});

test('selftest saves a pending report note without reporting an error', async (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.root, 'panel-selftest-request.json'), '{}');
  const request = (await f.request('GET', '/selftest/request')).body.request;
  const result = selftestSample();
  result.report = { opened: true, summary: false, criteria: false, firstCriterion: '', note: '报告尚未生成（任务运行中）' };
  for (const note of [true, null, '🙂'.repeat(129)]) {
    rejected(await f.request('POST', '/selftest/result', { ...request,
      result: { ...result, report: { ...result.report, note } } }), 400);
  }
  assert.equal((await f.request('POST', '/selftest/result', { ...request, result })).status, 200);
  const saved = JSON.parse(readFileSync(path.join(f.root, 'panel-selftest-result.json'), 'utf8'));
  assert.deepEqual(saved.report, result.report);
  assert.deepEqual(saved.errors, []);
});

test('panel report reads full Unicode context internally and exposes only acceptance on its first page', async (t) => {
  const f = fixture(t);
  const acceptance = ['保存设置后刷新仍可见', '🙂'.repeat(350)];
  const context = Array.from(JSON.stringify({ task: '私有任务🙂'.repeat(2000), acceptance, owner: 'private-owner' }));
  const report = { text: '报告🙂', next_offset: 4, eof: true };
  f.conductor.output.mock.mockImplementation(async (id, { artifact, offset, limit }) => {
    assert.equal(id, 'job-1');
    if (artifact === 'report') return report;
    assert.equal(artifact, 'context');
    const end = Math.min(context.length, offset + limit);
    return { text: context.slice(offset, end).join(''), next_offset: end < context.length ? end : null,
      eof: end >= context.length, source_path: 'private-path' };
  });
  assert.deepEqual(await f.request('GET', '/output?job_id=job-1'), { status: 200, body: { ...report, acceptance } });
  assert.deepEqual(f.conductor.output.mock.calls.map(({ arguments: [, options] }) => options), [
    { artifact: 'report', offset: 0, limit: 8000 },
    { artifact: 'context', offset: 0, limit: 8000 },
    { artifact: 'context', offset: 8000, limit: 8000 },
  ]);
  assert.deepEqual(await f.request('GET', '/output?job_id=job-1&offset=4'), { status: 200, body: report });
  assert.equal(f.conductor.output.mock.callCount(), 4);
  rejected(await f.request('GET', '/output?job_id=job-1&artifact=events'), 400);
  assert.equal(f.conductor.output.mock.callCount(), 4);
});

test('panel keeps reports readable when legacy context is missing, invalid or unavailable', async (t) => {
  const f = fixture(t);
  const report = { text: '报告', eof: true };
  for (const context of [{ status: 'failed', error_kind: 'legacy_context_missing' }, { text: '{', eof: true },
    { text: '{}', eof: true }, { text: '{"acceptance":"invalid"}', eof: true },
    { text: '{', eof: false, next_offset: 0 }, new Error('context bridge unavailable')]) {
    f.conductor.output.mock.mockImplementation(async (_id, { artifact }) => {
      if (artifact === 'report') return report;
      if (context instanceof Error) throw context;
      return context;
    });
    assert.deepEqual(await f.request('GET', '/output?job_id=job-1'), { status: 200, body: report });
  }
});

test('panel attention counts the last 24 hours with one runner query', async (t) => {
  const f = fixture(t);
  const now = 1800000000;
  t.mock.method(Date, 'now', () => now * 1000);
  f.conductor.list.mock.mockImplementation(async () => ({ total: 102, jobs: [{ job_id: 'recent' }] }));
  assert.deepEqual(await f.request('GET', '/attention'), { status: 200, body: { total: 102 } });
  assert.deepEqual(f.conductor.list.mock.calls.map(({ arguments: args }) => args.slice(0, 1)),
    [[{ needs_attention: true, limit: 1, started_between: [now - 86400, now] }]]);
  for (const page of [{ total: 1, jobs: [] }, { total: 1, jobs: null }, { total: -1, jobs: [] }]) {
    f.conductor.list.mock.mockImplementation(async () => page);
    rejected(await f.request('GET', '/attention'), 502, /列表.*请/);
  }
});

test('panel cancellation returns 409 for already-written settings and 500 for internal failures', async (t) => {
  const f = fixture(t);
  f.runtime.cancelPending.mock.mockImplementation(() => {
    throw Object.assign(new Error('设置已写入，不能撤销。请等待加载后再保存新的设置。'), { status: 409 });
  });
  rejected(await f.request('POST', '/settings/cancel', {}), 409, /设置已写入，不能撤销/);
  f.runtime.cancelPending.mock.mockImplementation(() => { throw new Error('unexpected cancellation failure'); });
  rejected(await f.request('POST', '/settings/cancel', {}), 500);
  f.runtime.cancelPending.mock.mockImplementation(() => ({ cancelled: true }));
  assert.equal((await f.request('POST', '/settings/cancel', {})).status, 200);
});

test('panel settings immediately apply only with literal confirmation and cancellation obeys the save lock', async (t) => {
  const f = fixture(t);
  for (const confirm of [undefined, false, 'true', 1, null]) {
    rejected(await f.request('POST', '/settings/apply', { changes: { effort: 'max' }, confirm }), 400, /确认/);
  }
  for (const changes of [undefined, {}, { effort: 'invalid' }, { runner: 'untrusted' }]) {
    rejected(await f.request('POST', '/settings/apply', { changes, confirm: true }), 400);
  }
  rejected(await f.request('POST', '/settings/cancel', { file: 'untrusted' }), 400);
  assert.deepEqual(f.calls(), [0, 0, 0, 0]);
  assert.equal(f.runtime.cancelPending.mock.callCount(), 0);
  let finish;
  const entered = Promise.withResolvers();
  f.runtime.execute.mock.mockImplementation(() => new Promise((resolve) => { finish = resolve; entered.resolve(); }));
  const save = f.request('POST', '/settings', { effort: 'max' });
  await entered.promise;
  rejected(await f.request('POST', '/settings/cancel', {}), 409);
  finish({ status: 'waiting_for_idle', saved: true, active_tasks: 1, pending_settings: { changes: { effort: 'max' } } });
  assert.equal((await save).body.runtime.pending_settings.changes.effort, 'max');
  assert.deepEqual(await f.request('POST', '/settings/cancel', {}), { status: 200, body: { cancelled: true } });
});

test('panel jobs pages preserve the filter and runner next offset', async (t) => {
  const f = fixture(t);
  f.conductor.list.mock.mockImplementation(async () => ({ total: 61, next_offset: 40, jobs: f.jobs }));
  const response = await f.request('GET', '/jobs?filter=attention&offset=20');
  assert.equal(response.status, 200);
  assert.equal(response.body.total, 61);
  assert.equal(response.body.next_offset, 40);
  assert.deepEqual(f.conductor.list.mock.calls[0].arguments.slice(0, 1), [{ limit: 20, offset: 20, needs_attention: true }]);
  rejected(await f.request('GET', '/jobs?offset=-1'), 400, /页码/);
  assert.equal(f.conductor.list.mock.callCount(), 1);
});

test('panel HTTP rejects unauthenticated requests and absent authentication on every route before side effects', async (t) => {
  for (const mode of ['logged-out', 'cross-origin', 'missing-service', 'missing-method']) {
    const f = fixture(t);
    if (mode === 'logged-out') f.connection.requestRejection.mock.mockImplementation(() => 401);
    else if (mode === 'cross-origin') f.connection.requestRejection.mock.mockImplementation(() => 403);
    else f.services.connection = mode === 'missing-service' ? undefined : {};
    const requestFile = path.join(f.root, 'panel-selftest-request.json');
    writeFileSync(requestFile, '{}');
    const before = readFileSync(f.plannerFile);
    for (const [method, route, body] of routes) {
      rejected(await f.request(method, route, body), mode === 'logged-out' ? 401 : mode === 'cross-origin' ? 403 : 503);
    }
    assert.deepEqual(f.calls(), [0, 0, 0, 0]);
    assert.equal(f.runtime.cancelPending.mock.callCount(), 0);
    assert.deepEqual(readFileSync(f.plannerFile), before);
    assert.equal(readFileSync(requestFile, 'utf8'), '{}');
    assert.deepEqual(readdirSync(f.root).sort(), ['panel-selftest-request.json', 'planner.md']);
  }
  const f = fixture(t);
  f.connection.requestRejection.mock.mockImplementation(() => 403);
  rejected(await f.request('POST', '/prompt', undefined, { raw: '{', contentType: 'text/plain' }), 403, /来源.*DSH/);
  assert.deepEqual(f.calls(), [0, 0, 0, 0]);
});

test('panel HTTP GET cannot write settings/prompt, cancel tasks or reload runtime', async (t) => {
  const f = fixture(t);
  const original = readFileSync(f.plannerFile);
  for (const route of ['/status', '/settings', '/jobs', '/output?job_id=job-1', '/prompt']) {
    assert.equal((await f.request('GET', route, { model: 'overwrite', text: 'overwrite', confirm: true })).status, 200);
  }
  for (const route of ['/cancel', '/reload', '/settings/apply', '/settings/cancel']) rejected(await f.request('GET', route), 405);
  assert.deepEqual(f.runtime.execute.mock.calls.map(({ arguments: args }) => args.slice(0, 1)), [[{ action: 'status' }]]);
  assert.equal(f.conductor.cancel.mock.callCount(), 0);
  assert.deepEqual(readFileSync(f.plannerFile), original);
  assert.deepEqual(readdirSync(f.root), ['planner.md']);
});

test('panel HTTP rejects unknown routes, unsupported methods and duplicate/unknown query fields', async (t) => {
  const f = fixture(t);
  for (const route of ['', '/', '/unknown', 'evil/status']) rejected(await f.request('GET', route), 404);
  for (const [method, route] of [['DELETE', '/settings'], ['PUT', '/prompt'], ['HEAD', '/status'],
    ['POST', '/status'], ['POST', '/jobs'], ['POST', '/output']]) {
    rejected(await f.request(method, route, {}), 405);
  }
  for (const [method, route, body] of routes) {
    rejected(await f.request(method, route + (route.includes('?') ? '&' : '?') + 'unknown=x', body), 400);
  }
  for (const route of ['/jobs?filter=all&filter=running', '/output?job_id=J&job_id=K',
    '/output?job_id=J&offset=0&offset=1', '/output?job_id=J&limit=1&limit=2',
    '/status?x=1&x=2', '/status?__proto__=x', '/jobs?constructor=x', '/jobs?filter=unknown']) {
    rejected(await f.request('GET', route), 400);
  }
  assert.deepEqual(f.calls(), [0, 0, 0, 0]);
});

test('panel HTTP POST requires JSON, valid syntax and no more than 1 MiB of streamed bytes', async (t) => {
  const f = fixture(t);
  for (const [, route, body] of routes.filter(([method]) => method === 'POST')) {
    for (const contentType of ['', 'text/plain', 'application/jsonp', 'application/x-www-form-urlencoded']) {
      rejected(await f.request('POST', route, body, { contentType }), 415);
    }
    for (const raw of ['', '{', '{"text":}', 'undefined']) rejected(await f.request('POST', route, undefined, { raw }), 400);
    rejected(await f.request('POST', route, undefined,
      { chunks: [Buffer.alloc(600000, 'a'), Buffer.alloc(448577, 'b')] }), 413);
  }
  assert.deepEqual(f.calls(), [0, 0, 0, 0]);
  assert.equal(readFileSync(f.plannerFile, 'utf8'), '原有规划要求🙂\n');
  const prefix = Buffer.from('{"text":"');
  const suffix = Buffer.from('"}');
  const payload = Buffer.concat([prefix, Buffer.alloc(1024 * 1024 - prefix.length - suffix.length, 'a'), suffix]);
  assert.equal((await f.request('POST', '/prompt', undefined, { chunks: [payload.subarray(0, 17), payload.subarray(17)],
    contentType: 'Application/JSON; charset=utf-8' })).status, 200);
  const bytesBefore = readFileSync(f.plannerFile);
  rejected(await f.request('POST', '/prompt', undefined, { chunks: [payload, Buffer.from(' ')] }), 413);
  assert.deepEqual(readFileSync(f.plannerFile), bytesBefore);
});

test('panel HTTP rejects traversal job IDs and malformed output pagination before runner access', async (t) => {
  const f = fixture(t);
  rejected(await f.request('GET', '/output'), 400);
  for (const id of ['', '..', '../job', 'a/../job', 'a/b', '..\\job', '/absolute', 'C:\\job',
    '%2e%2e%2fjob', 'job?x=1', 'job\0', ' job', '任务', '-job', '_job']) {
    rejected(await f.request('GET', '/output?job_id=' + encodeURIComponent(id)), 400);
    rejected(await f.request('POST', '/cancel', { job_id: id, confirm: true }), 400);
  }
  for (const key of ['offset', 'limit']) {
    for (const value of ['', '-1', '1.5', 'NaN', 'Infinity', '1e3', '+1', ' 1', '01', '0x10', '9007199254740992']) {
      rejected(await f.request('GET', `/output?job_id=J&${key}=${encodeURIComponent(value)}`), 400);
    }
  }
  for (const limit of ['0', '20001']) rejected(await f.request('GET', '/output?job_id=J&limit=' + limit), 400);
  assert.deepEqual(f.calls(), [0, 0, 0, 0]);
  assert.equal((await f.request('GET', '/output?job_id=J&offset=0&limit=1')).status, 200);
  assert.equal((await f.request('GET', '/output?job_id=J&offset=9007199254740991')).status, 200);
});

test('panel HTTP settings accept all supported enums, model characters and positive finite numbers', async (t) => {
  const f = fixture(t);
  const patches = [
    ...['', 'low', 'medium', 'high', 'xhigh', 'max'].map((effort) => ({ effort })),
    ...['', 'low', 'medium', 'high', 'xhigh', 'max'].map((readOnlyEffort) => ({ readOnlyEffort })),
    ...['', 'default', 'fast', 'ultrafast'].map((serviceTier) => ({ serviceTier })),
    ...['low', 'medium', 'high'].map((effort) => ({ gemini: { effort } })),
    { model: '' }, { model: 'A0._/:-' }, { model: 'm'.repeat(80) }, { gemini: { model: 'google/gemini-4:latest' } },
    { plannerAnswers: false }, { plannerAnswers: true }, { lockTimeoutSeconds: 0.5, maxStorageMb: 1.25 },
    // null clears a limit and restores the default.
    ...['lockTimeoutSeconds', 'maxStorageMb', 'timeoutSeconds', 'idleTimeoutSeconds', 'retries', 'maxRunningJobs'].map((key) => ({ [key]: null })),
    { timeoutSeconds: 900, idleTimeoutSeconds: 0.5 }, { retries: 0 }, { retries: 3 }, { maxRunningJobs: 1 },
    { autoResume: { enabled: false } }, { autoResume: { enabled: true } },
  ];
  for (const patch of patches) {
    assert.equal((await f.request('POST', '/settings', patch)).status, 200, JSON.stringify(patch));
    assert.deepEqual(f.runtime.execute.mock.calls.at(-1).arguments, [{ action: 'reload', when: 'idle' }, { panel: true }, patch]);
  }
});

test('panel HTTP settings reject invalid enums/models/numbers, unknown fields and newly created Gemini', async (t) => {
  const f = fixture(t);
  const patches = [null, [], {}, true, 'settings', { unknown: 1 }, { model: 'valid', runner: 'evil' },
    { effort: 'ultra' }, { effort: 1 }, { readOnlyEffort: 'ultra' },
    { readOnlyEffort: null }, { serviceTier: 'priority' }, { serviceTier: false }, { plannerAnswers: 'true' },
    { plannerAnswers: 1 }, { gemini: null }, { gemini: [] }, { gemini: {} },
    { gemini: { effort: 'max' } }, { gemini: { effort: 'xhigh' } }, { gemini: { command: 'evil' } },
    { gemini: { model: 'ok', unknown: true } }];
  for (const model of ['', 'a b', ' a', 'a\nfield: injected', 'a\t', '模型', 'a\\b', 'a#b', 'a"b', 'a'.repeat(81), null, 42]) {
    // An empty Codex model clears the override; Gemini still needs a model name.
    patches.push(...(model === '' ? [] : [{ model }]), { gemini: { model } });
  }
  for (const key of ['lockTimeoutSeconds', 'maxStorageMb']) {
    for (const value of [0, -1, '1', true]) patches.push({ [key]: value });
    for (const value of [NaN, Infinity, -Infinity]) await assert.rejects(f.api('POST', PANEL_PATH + '/settings', {}, { [key]: value }), /无效/);
  }
  patches.push({ timeoutSeconds: 0 }, { idleTimeoutSeconds: '60' }, { retries: -1 }, { retries: 1.5 }, { maxRunningJobs: 0 },
    { maxRunningJobs: 2.5 }, { autoResume: {} }, { autoResume: true }, { autoResume: { enabled: 'no' } },
    { autoResume: { enabled: true, message: 'x' } });
  for (const patch of patches) rejected(await f.request('POST', '/settings', patch), 400, /无效|设置/);
  const absent = fixture(t, { api: { cfg: { model: 'existing' } } });
  rejected(await absent.request('POST', '/settings', { gemini: { model: 'new', effort: 'low' } }), 400, /Gemini/);
  assert.deepEqual(f.calls(), [0, 0, 0, 0]);
  assert.deepEqual(absent.calls(), [0, 0, 0, 0]);
});

test('panel HTTP cancel requires literal confirmation and mutation bodies reject extra fields', async (t) => {
  const f = fixture(t);
  for (const confirm of [undefined, false, 'true', 1, null]) {
    rejected(await f.request('POST', '/cancel', { job_id: 'job-1', confirm }), 400, /确认/);
  }
  for (const body of [{ confirm: true }, { job_id: 123, confirm: true }, { job_id: 'J', confirm: true, force: true }]) {
    rejected(await f.request('POST', '/cancel', body), 400);
  }
  for (const route of ['/cancel', '/prompt', '/reload', '/settings/apply', '/settings/cancel']) {
    for (const body of [null, [], 'text', { unknown: true }]) rejected(await f.request('POST', route, body), 400);
  }
  for (const body of [{}, { text: null }, { text: 123 }, { text: 'safe', file: '../elsewhere' }]) {
    rejected(await f.request('POST', '/prompt', body), 400);
  }
  assert.deepEqual(f.calls(), [0, 0, 0, 0]);
  assert.equal(readFileSync(f.plannerFile, 'utf8'), '原有规划要求🙂\n');
  for (const status of ['cancelled', 'completed', 'failed']) {
    f.conductor.cancel.mock.mockImplementation(async () => ({ status }));
    assert.deepEqual(await f.request('POST', '/cancel', { job_id: 'J', confirm: true }), { status: 200, body: { status } });
  }
});

test('panel HTTP reports runner failures, unconfirmed cancellation and unavailable prompts without writes', async (t) => {
  const f = fixture(t);
  for (const failure of [{ error: 'runner unavailable' }, { error_kind: 'missing' }, { status: 'failed' }]) {
    f.conductor.list.mock.mockImplementation(async () => failure);
    f.conductor.output.mock.mockImplementation(async () => failure);
    for (const route of ['/attention', '/jobs', '/output?job_id=J']) rejected(await f.request('GET', route), 502);
    assert.equal((await f.request('GET', '/status')).status, 200);
  }
  for (const result of [undefined, {}, { status: 'running' }, { status: 'cancelled', error_kind: 'unconfirmed' }]) {
    f.conductor.cancel.mock.mockImplementation(async () => result);
    rejected(await f.request('POST', '/cancel', { job_id: 'J', confirm: true }), 502, /取消尚未确认/);
  }
  const missing = fixture(t, { api: { plannerFile: undefined } });
  rejected(await missing.request('GET', '/prompt'), 409);
  rejected(await missing.request('POST', '/prompt', { text: 'new' }), 409);
  const unreadable = fixture(t, { api: { plannerFile: path.join(f.root, 'missing.md') } });
  rejected(await unreadable.request('GET', '/prompt'), 500, /本地文件.*请/);
  rejected(await unreadable.request('POST', '/prompt', { text: 'new' }), 500, /本地文件.*请/);
  assert.equal(readFileSync(f.plannerFile, 'utf8'), '原有规划要求🙂\n');
});

test('panel HTTP serializes settings/reload, retains saved failure state and releases its lock', { timeout: 5000 }, async (t) => {
  const f = fixture(t);
  let finish;
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  f.runtime.execute.mock.mockImplementation(() => new Promise((resolve) => { finish = resolve; started(); }));
  const first = f.request('POST', '/settings', { effort: 'max' });
  await entered;
  rejected(await f.request('POST', '/settings', { effort: 'low' }), 409);
  rejected(await f.request('POST', '/reload', {}), 409);
  assert.equal(f.runtime.execute.mock.callCount(), 1);
  finish({ status: 'reloaded', saved: true });
  assert.equal((await first).body.saved, true);
  f.runtime.execute.mock.mockImplementation(async () => ({ status: 'failed', saved: true, error: 'reload failed' }));
  const failed = await f.request('POST', '/settings', { effort: 'high' });
  rejected(failed, 500, /操作没有完成.*请/);
  assert.equal(failed.body.saved, true);
  for (const status of [409, 502]) {
    f.runtime.execute.mock.mockImplementation(async () => ({ status: 'failed', error_status: status, saved: true, error: '服务暂时不可用，请重试。' }));
    for (const [route, body] of [['/settings', { effort: 'high' }], ['/settings/apply', { changes: { effort: 'high' }, confirm: true }], ['/reload', {}]]) {
      const response = await f.request('POST', route, body);
      rejected(response, status);
      assert.equal(response.body.saved, true);
    }
  }
  f.runtime.execute.mock.mockImplementation(async () => { throw new Error('runtime unavailable'); });
  rejected(await f.request('POST', '/reload', {}), 500, /操作没有完成.*请/);
  f.runtime.execute.mock.mockImplementation(async () => ({ status: 'already_current' }));
  assert.deepEqual(await f.request('POST', '/reload', {}), { status: 200, body: { status: 'already_current' } });
});

test('panel client follows late slots and settings declarations through removal and return', (t) => {
  let module;
  vm.runInNewContext(readFileSync(new URL('./client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: (value) => { module = value; } } },
  }, { filename: 'client.js' });
  assert.equal(module.id, 'dsh-codex-conductor');
  const exports = module.factory((name) => {
    if (name === 'react') return {};
    assert.equal(name, '@deepseek-ai/dsh-client-ui-primitives');
    return {};
  });
  const declarations = serviceContext(t);
  const unregister = t.mock.fn();
  const slots = {
    inject: t.mock.fn((name, callback) => {
      const fiber = declarations.inject([name], callback);
      return () => fiber.dispose();
    }),
    register: t.mock.fn(() => unregister),
  };
  const ctx = serviceContext(t);
  assert.equal(exports.apply(ctx), undefined);
  assert.deepEqual(Array.from(ctx.inject.mock.calls[0].arguments[0]), ['slots']);
  assert.equal(slots.inject.mock.callCount(), 0);
  ctx.set('slots', slots);
  assert.equal(slots.inject.mock.calls[0].arguments[0], 'settings.section');
  assert.equal(slots.register.mock.callCount(), 0);
  declarations.set('settings.section', {});
  const [options, component] = slots.register.mock.calls[0].arguments;
  assert.equal(options.name, 'settings.section');
  assert.equal(options.id, 'dsh-codex-conductor');
  assert.equal(options.label(), 'Codex 指挥');
  assert.equal(component, exports.Panel);
  declarations.set('settings.section', undefined);
  assert.equal(unregister.mock.callCount(), 1);
  declarations.set('settings.section', {});
  assert.equal(slots.register.mock.callCount(), 2);
  ctx.set('slots', undefined);
  assert.equal(unregister.mock.callCount(), 2);
  ctx.set('slots', slots);
  assert.equal(slots.register.mock.callCount(), 3);
  const fiber = ctx.inject.mock.calls[0].result;
  fiber.dispose();
  assert.equal(unregister.mock.callCount(), 3);
  ctx.set('slots', slots);
  assert.equal(slots.register.mock.callCount(), 3);
});

test('panel client applies fast status before history and always reads the separate recent attention count', async () => {
  const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8');
  for (const filter of ['all', 'attention']) {
    const effects = [], applied = [], routes = [];
    const state = { runtime: { state: 'synchronized', active_tasks: 0 }, settings: {} };
    const history = { total: 7, jobs: [] };
    let finish;
    const deferred = new Promise((resolve) => { finish = resolve; });
    let module;
    vm.runInNewContext(source, {
      window: { __ModuleLoader__: { load: (value) => { module = value; } } },
      AbortController, setTimeout, clearTimeout,
      async fetch(url) {
        const route = url.slice(PANEL_PATH.length);
        routes.push(route);
        const value = route.startsWith('/jobs') ? await deferred : route === '/attention' ? { total: 2 } :
          route === '/status' ? state : route === '/prompt' ? { text: 'prompt' } : {};
        return { ok: true, json: async () => value };
      },
    });
    const react = {
      createElement: () => null, useRef: (current) => ({ current }),
      useEffect: (effect) => effects.push(effect),
      useState: (value) => [value === 'all' ? filter : value, (next) => applied.push(next)],
    };
    module.factory((name) => name === 'react' ? react : {}).Panel();
    const cleanups = effects.map((effect) => effect());
    try {
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(applied.includes(state), 'running status should render while history is pending');
      assert.ok(routes.includes(`/jobs?filter=${filter}&offset=0`));
      assert.ok(!applied.includes(history));
      assert.equal(routes.includes('/attention'), true);
      finish(history);
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(applied.includes(history));
      assert.ok(applied.includes(2));
      assert.ok(!applied.includes(history.total));
    } finally {
      for (const cleanup of cleanups) cleanup?.();
      finish(history);
    }
  }
});

test('panel prompts share one implementation for planner and executor, with injected state, backups and pruning', async (t) => {
  const executorFile = path.join(mkdtempSync(path.join(tmpdir(), 'conductor-panel-executor-')), 'executor-prompt.md');
  t.after(() => rmSync(path.dirname(executorFile), { recursive: true, force: true }));
  writeFileSync(executorFile, '原固定要求\n');
  const f = fixture(t, { api: { plannerInjected: true, executorFile } });
  assert.deepEqual(await f.request('GET', '/prompt'), { status: 200, body: { text: '原有规划要求🙂\n', injected: true } });
  assert.deepEqual(await f.request('GET', '/prompt?kind=planner'), { status: 200, body: { text: '原有规划要求🙂\n', injected: true } });
  assert.deepEqual(await f.request('GET', '/prompt?kind=executor'), { status: 200, body: { text: '原固定要求\n' } });
  assert.deepEqual(await f.request('GET', '/prompt/backups?kind=executor'), { status: 200, body: { backups: [] } });
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 10, 14, 1, 2, 3, 4) });
  for (let n = 0; n < 12; n++) {
    t.mock.timers.tick(1000);
    assert.deepEqual(await f.request('POST', '/prompt', { text: `固定要求 ${n}`, kind: 'executor' }), { status: 200, body: { saved: true } });
  }
  assert.equal(readFileSync(executorFile, 'utf8'), '固定要求 11');
  assert.equal(readFileSync(f.plannerFile, 'utf8'), '原有规划要求🙂\n', 'the planner prompt is untouched');
  assert.deepEqual(readdirSync(f.root), ['planner.md'], 'executor backups stay beside the executor file');
  const { body: { backups } } = await f.request('GET', '/prompt/backups?kind=executor');
  assert.equal(backups.length, 10);
  assert.equal(backups[0].savedAt, '2026-11-14T01:02:15.004Z', 'newest first, time read from the backup name');
  assert.equal(backups.at(-1).savedAt, '2026-11-14T01:02:06.004Z');
  assert.equal(backups[0].size, Buffer.byteLength('固定要求 10'));
  assert.deepEqual(backups.map(({ name }) => name).sort().reverse(), backups.map(({ name }) => name));
  assert.deepEqual(await f.request('GET', `/prompt/backup?kind=executor&name=${encodeURIComponent(backups[0].name)}`),
    { status: 200, body: { text: '固定要求 10' } });
  assert.deepEqual((await f.request('GET', '/prompt/backups')).body, { backups: [] }, 'planner and executor backups are listed separately');
  rejected(await f.request('GET', `/prompt/backup?name=${encodeURIComponent(backups[0].name)}`), 404);
  for (const name of ['', 'executor-prompt.md', '../planner.md', '..\\planner.md', f.plannerFile, backups[0].name + '/../executor-prompt.md',
    'executor-prompt.md.2026-11-14T01-02-15-004Z.00000000-0000-4000-8000-000000000000.bak']) {
    rejected(await f.request('GET', `/prompt/backup?kind=executor&name=${encodeURIComponent(name)}`), 404);
  }
  rejected(await f.request('GET', '/prompt/backup?kind=executor'), 404);
  for (const route of ['/prompt?kind=other', '/prompt/backups?kind=other', '/prompt/backup?kind=..&name=x']) rejected(await f.request('GET', route), 400);
  rejected(await f.request('POST', '/prompt', { text: 'x', kind: 'other' }), 400);
  rejected(await f.request('POST', '/prompt?kind=executor', { text: 'x' }), 400);
  assert.equal(readFileSync(executorFile, 'utf8'), '固定要求 11');

  const unavailable = fixture(t, { api: { executorFile: '' } });
  for (const response of [await unavailable.request('GET', '/prompt?kind=executor'), await unavailable.request('GET', '/prompt/backups?kind=executor'),
    await unavailable.request('POST', '/prompt', { text: 'x', kind: 'executor' })]) rejected(response, 409, /当前环境不可用/);
  assert.equal((await unavailable.request('GET', '/prompt')).status, 200);
});

test('panel status settings report guard workspaces, host access, unknown keys and the editable limits', async (t) => {
  const f = fixture(t);
  Object.assign(f.cfg, { roots: ['d:/work', '*'], allowHostAccess: true, defaultHostAccess: false, unknownConfig: ['timoutSeconds'],
    timeoutSeconds: 900, idleTimeoutSeconds: null, retries: 0, maxRunningJobs: 2, autoResume: { enabled: false, message: 'private-message' } });
  const { body: { settings } } = await f.request('GET', '/status');
  assert.deepEqual({ roots: settings.roots, allowHostAccess: settings.allowHostAccess, defaultHostAccess: settings.defaultHostAccess,
    unknownConfig: settings.unknownConfig, timeoutSeconds: settings.timeoutSeconds, idleTimeoutSeconds: settings.idleTimeoutSeconds,
    retries: settings.retries, maxRunningJobs: settings.maxRunningJobs, autoResume: settings.autoResume },
  { roots: ['d:/work', '*'], allowHostAccess: true, defaultHostAccess: false, unknownConfig: ['timoutSeconds'], timeoutSeconds: 900,
    idleTimeoutSeconds: null, retries: 0, maxRunningJobs: 2, autoResume: { enabled: false } });
  assert.ok(!JSON.stringify(settings).includes('private-'));
});

test('panel doctor runs only on request and maps runner checks; a dead bridge is a 502', async (t) => {
  const f = fixture(t);
  f.conductor.doctor.mock.mockImplementation(async () => ({ status: 'completed', ok: false, secret: 'private',
    checks: [{ name: 'python', ok: true, detail: '3.12', secret: 'private' }, { name: 'codex_auth', ok: false, detail: null }, { name: 'bash', ok: 'yes' }] }));
  assert.deepEqual(await f.request('GET', '/doctor'), { status: 200, body: { ok: false, checks: [
    { name: 'python', ok: true, detail: '3.12' }, { name: 'codex_auth', ok: false, detail: '' }, { name: 'bash', ok: false, detail: '' }] } });
  assert.equal(f.conductor.doctor.mock.callCount(), 1);
  f.conductor.doctor.mock.mockImplementation(async () => ({ status: 'failed', error_kind: 'bridge_error', error: 'WSL offline' }));
  rejected(await f.request('GET', '/doctor'), 502, /请/);
  rejected(await f.request('POST', '/doctor', {}), 405);
});

test('panel jobs pass through only the fields the runner returned and search by job id or session id', async (t) => {
  const f = fixture(t);
  const full = { job_id: '20261114-010203-abcdef', started_at: 1, status: 'completed', execution_status: 'completed',
    context: { owner: 'session-a', task: 'task' }, cwd: '/mnt/d/work', duration_s: 148.4, error_kind: null,
    criteria_counts: { met: 2, not_met: 1, blocked: 0, secret: 'private' }, verification_status: 'verified', review_status: 'needs_verification',
    phase: null, attempt: 1, updated_at: 9, scope: ['private-scope'], blocking: { secret: 'private' } };
  const running = { job_id: 'J2', started_at: 2, status: 'running', execution_status: 'running', context: null,
    phase: 'lock_wait', attempt: 2, updated_at: 12, error_kind: 'timeout' };
  f.conductor.list.mock.mockImplementation(async () => ({ total: 2, next_offset: null, jobs: [full, running] }));
  assert.deepEqual((await f.request('GET', '/jobs')).body.jobs, [
    { job_id: full.job_id, started_at: 1, status: 'completed', execution_status: 'completed', title: 'task', needs_attention: false,
      owner: 'session-a', cwd: '/mnt/d/work', duration_s: 148.4, verification_status: 'verified', attempt: 1, updated_at: 9,
      criteria_counts: { met: 2, not_met: 1, blocked: 0 } },
    { job_id: 'J2', started_at: 2, status: 'running', execution_status: 'running', title: '', needs_attention: false,
      error_kind: 'timeout', phase: 'lock_wait', attempt: 2, updated_at: 12 }]);
  for (const [q, expected] of [['20261114-010203-abcdef', { job_ids: ['20261114-010203-abcdef'] }], ['session-a', { owner: 'session-a' }],
    ['20261114-010203-ABCDEF', { owner: '20261114-010203-ABCDEF' }], ['a'.repeat(100), { owner: 'a'.repeat(100) }]]) {
    assert.equal((await f.request('GET', `/jobs?filter=running&offset=20&q=${q}`)).status, 200);
    assert.deepEqual(f.conductor.list.mock.calls.at(-1).arguments[0], { limit: 20, offset: 20, status: 'running', ...expected });
  }
  const calls = f.conductor.list.mock.callCount();
  for (const q of ['', ' ', 'a b', '../x', 'a'.repeat(101), '会话', 'a,b', '--job-id', '-a']) {
    rejected(await f.request('GET', `/jobs?q=${encodeURIComponent(q)}`), 400, /任务编号或会话编号/);
  }
  assert.equal(f.conductor.list.mock.callCount(), calls, 'rejected searches never reach the runner');
});

test('panel output serves the other artifacts as raw pages and rejects unknown ones', async (t) => {
  const f = fixture(t);
  for (const artifact of ['context', 'review', 'stderr', 'result', 'diff']) {
    assert.deepEqual(await f.request('GET', `/output?job_id=job-1&artifact=${artifact}&offset=3&limit=10`),
      { status: 200, body: { text: '报告🙂', next_offset: 4, eof: true } });
    assert.deepEqual(f.conductor.output.mock.calls.at(-1).arguments.slice(0, 2), ['job-1', { artifact, offset: 3, limit: 10 }]);
  }
  f.conductor.output.mock.resetCalls();
  assert.equal((await f.request('GET', '/output?job_id=job-1&artifact=context')).body.acceptance, undefined);
  assert.equal(f.conductor.output.mock.callCount(), 1, 'only the report view reads the acceptance context');
  assert.equal((await f.request('GET', '/output?job_id=job-1&artifact=report')).status, 200);
  assert.equal(f.conductor.output.mock.callCount(), 3);
  for (const artifact of ['events', '', 'Report', '../result', 'report,stderr']) {
    rejected(await f.request('GET', `/output?job_id=job-1&artifact=${encodeURIComponent(artifact)}`), 400);
  }
  assert.equal(f.conductor.output.mock.callCount(), 3);
});

test('panel gemini history returns the newest twenty records and tolerates a missing file or bad lines', async (t) => {
  const missing = fixture(t, { api: { geminiHistoryFile: '' } });
  assert.deepEqual(await missing.request('GET', '/gemini'), { status: 200, body: { entries: [] } });
  const f = fixture(t, { api: { geminiHistoryFile: path.join(tmpdir(), `conductor-gemini-history-${process.pid}-${Date.now()}.jsonl`) } });
  const file = path.join(f.root, 'gemini-history.jsonl');
  const g = fixture(t, { api: { geminiHistoryFile: file } });
  assert.deepEqual(await f.request('GET', '/gemini'), { status: 200, body: { entries: [] } }, 'a file that does not exist yet');
  const record = (n) => ({ at: `2026-11-14T00:00:${String(n).padStart(2, '0')}Z`, session: 'session-a', output: `D:\\docs\\${n}.md`,
    status: n % 2 ? 'failed' : 'completed', chars: n, attempts: 1, error: n % 2 ? '超限' : null, draft_path: n % 2 ? `D:\\drafts\\${n}.md` : null,
    duration_s: 1.5, secret: 'private' });
  writeFileSync(file, [...Array.from({ length: 25 }, (_, n) => JSON.stringify(record(n))), '{bad json', '[]', 'null', '"text"', ''].join('\n'));
  const { status, body } = await g.request('GET', '/gemini');
  assert.equal(status, 200);
  assert.equal(body.entries.length, 20);
  const { secret, ...newest } = record(24);
  assert.deepEqual(body.entries[0], newest);
  assert.deepEqual(body.entries.map(({ chars }) => chars), Array.from({ length: 20 }, (_, n) => 24 - n));
  writeFileSync(file, JSON.stringify({ at: 'x' }) + '\n');
  assert.deepEqual((await g.request('GET', '/gemini')).body.entries, [{ at: 'x', session: null, output: null, status: null, chars: null,
    attempts: null, error: null, draft_path: null, duration_s: null }]);
});

test('panel session operations publish the existing local request files atomically and never overwrite a pending one', async (t) => {
  const f = fixture(t);
  const request = (kind) => JSON.parse(readFileSync(path.join(f.root, `${kind}-request.json`), 'utf8'));
  assert.deepEqual(await f.request('GET', '/session/results'), { status: 200, body: { send: null, resume: null, goal: null, autoresume: null } });
  assert.deepEqual(await f.request('POST', '/session/send', { sessionId: 'session-a', message: ' 继续做\n' }), { status: 200, body: { submitted: true } });
  assert.deepEqual(request('send'), { sessionId: 'session-a', message: ' 继续做\n' });
  rejected(await f.request('POST', '/session/send', { sessionId: 'session-b', message: 'second' }), 409, /还没有处理完/);
  assert.deepEqual(request('send'), { sessionId: 'session-a', message: ' 继续做\n' }, 'the pending request is not replaced');
  rmSync(path.join(f.root, 'send-request.json'));
  assert.equal((await f.request('POST', '/session/send', { sessionId: 'session-a', message: 'm', queue: true })).status, 200);
  assert.deepEqual(request('send'), { sessionId: 'session-a', message: 'm', whenRunning: 'queue' });
  rmSync(path.join(f.root, 'send-request.json'));
  assert.equal((await f.request('POST', '/session/send', { sessionId: 'session-a', message: 'm', queue: false })).status, 200);
  assert.deepEqual(request('send'), { sessionId: 'session-a', message: 'm' });
  assert.equal((await f.request('POST', '/session/resume', { sessions: ['session-a', 'session-b', 'session-a'] })).status, 200);
  assert.deepEqual(request('resume'), { sessions: ['session-a', 'session-b'], message: '继续' });
  rmSync(path.join(f.root, 'resume-request.json'));
  assert.equal((await f.request('POST', '/session/resume', { sessions: ['session-a'], message: '接着做' })).status, 200);
  assert.deepEqual(request('resume'), { sessions: ['session-a'], message: '接着做' });
  assert.equal((await f.request('POST', '/session/goal', { sessionId: 'session-a', objective: '新目标', maxGoalRounds: 20 })).status, 200);
  assert.deepEqual(request('goal'), { sessionId: 'session-a', objective: '新目标', maxGoalRounds: 20 });
  assert.deepEqual(readdirSync(f.root).sort(), ['goal-request.json', 'planner.md', 'resume-request.json', 'send-request.json'], 'no temporary files remain');

  const g = fixture(t);
  const invalid = [
    ['/session/send', [{}, { sessionId: 'a' }, { message: 'm' }, { sessionId: '../a', message: 'm' }, { sessionId: 'a', message: '  ' },
      { sessionId: 'a', message: 'm'.repeat(4001) }, { sessionId: 'a', message: 'm', queue: 'queue' }, { sessionId: 'a', message: 'm', whenRunning: 'queue' },
      { sessionId: 'a', message: 'm', sessions: [] }, { sessionId: ['a'], message: 'm' }]],
    ['/session/resume', [{}, { sessions: [] }, { sessions: 'a' }, { sessions: ['a b'] }, { sessions: ['a\n'] }, { sessions: Array(21).fill('a') },
      { sessions: ['a'], message: 1 }, { sessions: ['a'], message: 'm'.repeat(2001) }, { sessions: ['a'], path: 'x' }]],
    ['/session/goal', [{}, { sessionId: 'a' }, { sessionId: 'a', objective: ' ' }, { sessionId: 'a', maxGoalRounds: 0 }, { sessionId: 'a', maxGoalRounds: 1.5 },
      { sessionId: 'a', maxGoalRounds: '3' }, { sessionId: 'a/b', objective: 'x' }, { sessionId: 'a', objective: 'x', phase: 'complete' }]],
  ];
  for (const [route, bodies] of invalid) for (const body of bodies) rejected(await g.request('POST', route, body), 400);
  for (const route of ['/session/send', '/session/resume', '/session/goal']) rejected(await g.request('GET', route), 405);
  assert.deepEqual(readdirSync(g.root), ['planner.md'], 'rejected requests write nothing');

  for (const [name, value] of [['send', { status: 'sent', reason: 'message_submitted' }], ['resume', { status: 'processed', sessions: [] }],
    ['goal', { status: 'edited' }], ['autoresume', { status: 'processed' }]]) writeFileSync(path.join(g.root, `${name}-result.json`), JSON.stringify(value));
  writeFileSync(path.join(g.root, 'goal-result.json'), '{half');
  assert.deepEqual((await g.request('GET', '/session/results')).body, { send: { status: 'sent', reason: 'message_submitted' },
    resume: { status: 'processed', sessions: [] }, goal: null, autoresume: { status: 'processed' } });

  const none = fixture(t, { api: { selftestDirectory: null } });
  rejected(await none.request('POST', '/session/send', { sessionId: 'a', message: 'm' }), 409);
  assert.deepEqual((await none.request('GET', '/session/results')).body, { send: null, resume: null, goal: null, autoresume: null });
  assert.equal(existsSync(path.join(none.root, 'send-request.json')), false);
});

test('panel jobs pass through diff, rollback and activity fields only when the runner returned them', async (t) => {
  const f = fixture(t);
  const base = { started_at: 1, status: 'completed', execution_status: 'completed', context: null };
  f.conductor.list.mock.mockImplementation(async () => ({ total: 3, next_offset: null, jobs: [
    { ...base, job_id: 'J1', diff_status: 'captured', diff_files: 4, rolled_back_at: 1800000000, diff_path: 'private-path' },
    { ...base, job_id: 'J2', status: 'running', execution_status: 'running', last_activity: '正在运行测试', diff_status: null },
    { ...base, job_id: 'J3' }] }));
  const row = { started_at: 1, status: 'completed', execution_status: 'completed', title: '', needs_attention: false };
  assert.deepEqual((await f.request('GET', '/jobs')).body.jobs, [
    { ...row, job_id: 'J1', diff_status: 'captured', diff_files: 4, rolled_back_at: 1800000000 },
    { ...row, job_id: 'J2', status: 'running', execution_status: 'running', last_activity: '正在运行测试' },
    { ...row, job_id: 'J3' }]);
});

test('panel rollback needs a literal confirmation, passes the check flag and maps runner refusals to readable 409/502', async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.request('POST', '/rollback', { job_id: 'job-1', confirm: true, check: true }),
    { status: 200, body: { job_id: 'job-1', rolled_back: false, checked: true, files: 3 } });
  assert.deepEqual(f.conductor.rollback.mock.calls.at(-1).arguments, ['job-1', { check: true }]);
  for (const body of [{ job_id: 'job-1', confirm: true }, { job_id: 'job-1', confirm: true, check: false }]) {
    assert.deepEqual(await f.request('POST', '/rollback', body), { status: 200, body: { job_id: 'job-1', rolled_back: true, checked: true, files: 3 } });
    assert.deepEqual(f.conductor.rollback.mock.calls.at(-1).arguments, ['job-1', { check: false }]);
  }
  const calls = f.conductor.rollback.mock.callCount();
  for (const confirm of [undefined, false, 'true', 1, null]) rejected(await f.request('POST', '/rollback', { job_id: 'job-1', confirm }), 400, /确认/);
  for (const body of [{ confirm: true }, { job_id: '../job', confirm: true }, { job_id: 'job-1', confirm: true, check: 'true' },
    { job_id: 'job-1', confirm: true, check: 1 }, { job_id: 'job-1', confirm: true, force: true }, null, []]) {
    rejected(await f.request('POST', '/rollback', body), 400);
  }
  rejected(await f.request('GET', '/rollback'), 405);
  assert.equal(f.conductor.rollback.mock.callCount(), calls, 'rejected requests never reach the runner');
  for (const [error_kind, status, message] of [['rollback_conflict', 409, /在任务之后又被改过，不能自动回滚，没有改动任何文件/],
    ['lock_busy', 409, /其他任务在写/], ['still_running', 409, /还在运行/], ['no_diff', 409, /没有记录可回滚的改动/],
    ['already_rolled_back', 409, /已经回滚过/], ['bridge_error', 502, /暂时无法确认回滚结果/], ['unexpected_kind', 502, /暂时无法确认回滚结果/]]) {
    f.conductor.rollback.mock.mockImplementation(async () => ({ status: 'failed', error_kind, error: 'private runner text C:\\secret' }));
    const response = await f.request('POST', '/rollback', { job_id: 'job-1', confirm: true });
    rejected(response, status, message);
    assert.doesNotMatch(response.body.error, /[A-Za-z]/, 'the client shows these messages verbatim only without Latin letters');
  }
  for (const result of [undefined, {}, { status: 'running' }, { status: 'completed', error_kind: 'bridge_error' }]) {
    f.conductor.rollback.mock.mockImplementation(async () => result);
    rejected(await f.request('POST', '/rollback', { job_id: 'job-1', confirm: true }), 502);
  }
  f.conductor.rollback.mock.resetCalls();
});

test('panel gemini history keeps the record id and background flag when a record has them', async (t) => {
  const f = fixture(t);
  const file = path.join(f.root, 'gemini-history.jsonl');
  const g = fixture(t, { api: { geminiHistoryFile: file } });
  writeFileSync(file, [{ at: 'a', output: 'old.md' }, { at: 'b', output: 'new.md', id: 'G2', background: true },
    { at: 'c', output: 'front.md', id: 'G3', background: false, secret: 'private' }].map((entry) => JSON.stringify(entry)).join('\n'));
  const entries = (await g.request('GET', '/gemini')).body.entries;
  assert.deepEqual(entries.map(({ output, id, background }) => ({ output, id, background })), [
    { output: 'front.md', id: 'G3', background: false }, { output: 'new.md', id: 'G2', background: true },
    { output: 'old.md', id: undefined, background: undefined }]);
  assert.equal(Object.hasOwn(entries[2], 'background'), false);
  assert.equal(Object.hasOwn(entries[0], 'secret'), false);
});

test('panel hand-over posts a request file with origin panel, refuses while one is pending and forwards answers to the auto hand-over', async (t) => {
  const answers = [];
  const f = fixture(t, { api: { handover: () => ({ mode: 'confirm' }), answerHandover: (id, accept) => { answers.push([id, accept]); return { declined: true }; } } });
  const file = path.join(f.root, 'handover-request.json');
  assert.deepEqual((await f.request('GET', '/status')).body.handover, { mode: 'confirm' });
  assert.deepEqual(await f.request('POST', '/handover/request', { sessionId: 'session-a', note: '先收尾' }), { status: 200, body: { submitted: true } });
  const first = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual({ ...first, requestedAt: typeof first.requestedAt }, { sessionId: 'session-a', note: '先收尾', origin: 'panel', requestedAt: 'string' });
  rejected(await f.request('POST', '/handover/request', { sessionId: 'session-b' }), 409, /上一份交接请求还没有处理完/);
  rmSync(file);
  // 面板只在撤回时带 force；交接请求里的 force 被丢掉。
  assert.equal((await f.request('POST', '/handover/request', { sessionId: 'session-a', force: true })).status, 200);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).force, undefined);
  rmSync(file);
  assert.equal((await f.request('POST', '/handover/request', { revert: { from: 'session-a', to: 'session-b' }, force: true })).status, 200);
  const revert = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual([revert.revert, revert.force, revert.origin], [{ from: 'session-a', to: 'session-b' }, true, 'panel']);
  rmSync(file);
  for (const body of [{}, { sessionId: '../a' }, { sessionId: 'a', revert: { from: 'a', to: 'b' } }, { revert: { from: 'a', to: 'a' } }, { sessionId: 'a', note: 1 },
    { sessionId: 'a', origin: 'auto' }]) rejected(await f.request('POST', '/handover/request', body), 400);
  assert.equal(existsSync(file), false, 'rejected requests write nothing');
  assert.deepEqual(await f.request('POST', '/handover/answer', { sessionId: 'session-a', accept: false }), { status: 200, body: { declined: true } });
  assert.deepEqual(answers, [['session-a', false]]);
  for (const body of [{ sessionId: 'session-a' }, { sessionId: 'session-a', accept: 'yes' }, { sessionId: '-a', accept: true }]) {
    rejected(await f.request('POST', '/handover/answer', body), 400);
  }
  const g = fixture(t, { api: { answerHandover: () => { throw Object.assign(new Error('x'), { code: 'none' }); } } });
  rejected(await g.request('POST', '/handover/answer', { sessionId: 'session-a', accept: true }), 409, /已经处理过或已过期/);
  const none = fixture(t, { api: { selftestDirectory: null } });
  rejected(await none.request('POST', '/handover/request', { sessionId: 'session-a' }), 409);
});
