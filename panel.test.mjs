import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  };
  const connection = { requestRejection: t.mock.fn(() => undefined) };
  const web = { register: t.mock.fn((route) => { handler = route.handler; return unregister; }) };
  const unregister = t.mock.fn(() => { handler = undefined; });
  const settings = {};
  let handler;
  const services = { webServer: web, settings, connection, ...options.services };
  const ctx = serviceContext(t, services);
  const apiOptions = { cfg, conductor, runtime, plannerFile, ...options.api };
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
  const calls = () => [runtime.execute, conductor.list, conductor.output, conductor.cancel]
    .map((fn) => fn.mock.callCount());
  return { root, plannerFile, cfg, state, jobs, runtime, conductor, connection, web, ctx, services,
    unregister, registration, request, calls, api: createPanelApi(apiOptions) };
}

function rejected(response, status, message) {
  if (status === undefined) assert.ok(response.status >= 400, JSON.stringify(response));
  else assert.equal(response.status, status, JSON.stringify(response));
  assert.equal(typeof response.body.error, 'string');
  if (message) assert.match(response.body.error, message);
}

test('panel settings expose only editable fields and redact nested Gemini configuration', () => {
  const cfg = { model: 'model', effort: 'high', readOnlyEffort: '', serviceTier: '', plannerAnswers: true,
    lockTimeoutSeconds: 1.5, maxStorageMb: 256, token: 'secret', runner: 'secret',
    gemini: { model: 'gemini', effort: 'low', command: 'secret' } };
  const expected = { model: 'model', effort: 'high', readOnlyEffort: '', serviceTier: '', plannerAnswers: true,
    lockTimeoutSeconds: 1.5, maxStorageMb: 256, gemini: { model: 'gemini', effort: 'low' } };
  assert.deepEqual(panelSettings(cfg), expected);
  assert.deepEqual(cfg.gemini, { ...expected.gemini, command: 'secret' });
  assert.equal(panelSettings({ ...cfg, gemini: undefined }).gemini, null);
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

test('panel HTTP implements every valid route using only stub runtime/conductor', async (t) => {
  const f = fixture(t);
  const status = await f.request('GET', '/status');
  assert.deepEqual(status, { status: 200, body: { runtime: f.state, settings: panelSettings(f.cfg) } });
  assert.deepEqual(f.runtime.execute.mock.calls[0].arguments, [{ action: 'status' }]);
  assert.equal(f.conductor.list.mock.callCount(), 0);
  t.mock.method(Date, 'now', () => 1800000000000);
  assert.deepEqual(await f.request('GET', '/attention'), { status: 200, body: { total: 1 } });
  assert.deepEqual(f.conductor.list.mock.calls[0].arguments,
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
      status: 'running', execution_status: 'running', title: '🙂'.repeat(60), needs_attention: true }] } });
    assert.deepEqual(f.conductor.list.mock.calls.at(-1).arguments, [{ limit: 20, offset: 0, ...expected }]);
  }
  assert.deepEqual(await f.request('GET', '/output?job_id=job-1'),
    { status: 200, body: { text: '报告🙂', next_offset: 4, eof: true } });
  assert.deepEqual(f.conductor.output.mock.calls[0].arguments, ['job-1', { artifact: 'report', offset: 0, limit: 8000 }]);
  assert.deepEqual(f.conductor.output.mock.calls[1].arguments, ['job-1', { artifact: 'context', offset: 0, limit: 8000 }]);
  assert.equal((await f.request('GET', '/output?job_id=J_2&offset=12&limit=20000')).status, 200);
  assert.deepEqual(f.conductor.output.mock.calls.at(-1).arguments, ['J_2', { artifact: 'report', offset: 12, limit: 20000 }]);
  assert.deepEqual(await f.request('POST', '/cancel', { job_id: 'job-1', confirm: true }),
    { status: 200, body: { job_id: 'job-1', status: 'cancelled' } });
  assert.deepEqual(f.conductor.cancel.mock.calls[0].arguments, ['job-1']);
  assert.deepEqual(await f.request('GET', '/prompt'), { status: 200, body: { text: '原有规划要求🙂\n' } });
  assert.deepEqual(await f.request('POST', '/prompt', { text: '新规划🙂\n' }), { status: 200, body: { saved: true } });
  assert.equal(readFileSync(f.plannerFile, 'utf8'), '新规划🙂\n');
  const backups = readdirSync(f.root).filter((name) => name.endsWith('.bak'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(path.join(f.root, backups[0]), 'utf8'), '原有规划要求🙂\n');
  assert.equal((await f.request('POST', '/prompt', { text: '' })).status, 200);
  assert.equal(readFileSync(f.plannerFile, 'utf8'), '');
  assert.deepEqual(await f.request('POST', '/reload', {}), { status: 200, body: { status: 'reloaded', saved: true } });
  assert.deepEqual(f.runtime.execute.mock.calls.at(-1).arguments, [{ action: 'reload', when: 'idle' }, { panel: true }, undefined]);
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
  rejected(await f.request('GET', '/output?job_id=job-1&artifact=context'), 400);
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
  assert.deepEqual(f.conductor.list.mock.calls.map(({ arguments: args }) => args),
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
  assert.deepEqual(f.conductor.list.mock.calls[0].arguments, [{ limit: 20, offset: 20, needs_attention: true }]);
  rejected(await f.request('GET', '/jobs?offset=-1'), 400, /页码/);
  assert.equal(f.conductor.list.mock.callCount(), 1);
});

test('panel HTTP rejects unauthenticated requests and absent authentication on every route before side effects', async (t) => {
  for (const mode of ['logged-out', 'missing-service', 'missing-method']) {
    const f = fixture(t);
    if (mode === 'logged-out') f.connection.requestRejection.mock.mockImplementation(() => 401);
    else f.services.connection = mode === 'missing-service' ? undefined : {};
    const before = readFileSync(f.plannerFile);
    for (const [method, route, body] of routes) {
      rejected(await f.request(method, route, body), mode === 'logged-out' ? 401 : 503);
    }
    assert.deepEqual(f.calls(), [0, 0, 0, 0]);
    assert.equal(f.runtime.cancelPending.mock.callCount(), 0);
    assert.deepEqual(readFileSync(f.plannerFile), before);
    assert.deepEqual(readdirSync(f.root), ['planner.md']);
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
  assert.deepEqual(f.runtime.execute.mock.calls.map(({ arguments: args }) => args), [[{ action: 'status' }]]);
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
    ...['low', 'medium', 'high', 'xhigh', 'max'].map((effort) => ({ effort })),
    ...['', 'low', 'medium', 'high', 'xhigh', 'max'].map((readOnlyEffort) => ({ readOnlyEffort })),
    ...['', 'fast', 'ultrafast'].map((serviceTier) => ({ serviceTier })),
    ...['low', 'medium', 'high'].map((effort) => ({ gemini: { effort } })),
    { model: 'A0._/:-' }, { model: 'm'.repeat(80) }, { gemini: { model: 'google/gemini-4:latest' } },
    { plannerAnswers: false }, { plannerAnswers: true }, { lockTimeoutSeconds: 0.5, maxStorageMb: 1.25 },
  ];
  for (const patch of patches) {
    assert.equal((await f.request('POST', '/settings', patch)).status, 200, JSON.stringify(patch));
    assert.deepEqual(f.runtime.execute.mock.calls.at(-1).arguments, [{ action: 'reload', when: 'idle' }, { panel: true }, patch]);
  }
});

test('panel HTTP settings reject invalid enums/models/numbers, unknown fields and newly created Gemini', async (t) => {
  const f = fixture(t);
  const patches = [null, [], {}, true, 'settings', { unknown: 1 }, { model: 'valid', runner: 'evil' },
    { effort: '' }, { effort: 'ultra' }, { effort: 1 }, { readOnlyEffort: 'ultra' },
    { readOnlyEffort: null }, { serviceTier: 'priority' }, { serviceTier: false }, { plannerAnswers: 'true' },
    { plannerAnswers: 1 }, { gemini: null }, { gemini: [] }, { gemini: {} },
    { gemini: { effort: 'max' } }, { gemini: { effort: 'xhigh' } }, { gemini: { command: 'evil' } },
    { gemini: { model: 'ok', unknown: true } }];
  for (const model of ['', 'a b', ' a', 'a\nfield: injected', 'a\t', '模型', 'a\\b', 'a#b', 'a"b', 'a'.repeat(81), null, 42]) {
    patches.push({ model }, { gemini: { model } });
  }
  for (const key of ['lockTimeoutSeconds', 'maxStorageMb']) {
    for (const value of [0, -1, null, '1', true]) patches.push({ [key]: value });
    for (const value of [NaN, Infinity, -Infinity]) await assert.rejects(f.api('POST', PANEL_PATH + '/settings', {}, { [key]: value }), /无效/);
  }
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
      for (const cleanup of cleanups) cleanup();
      finish(history);
    }
  }
});
