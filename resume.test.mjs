import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { processResumeRequest, registerResumeRequests } from './resume.mjs';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const claimPattern = new RegExp(`^resume-request\\.${uuid}\\.processing\\.json$`);
const interrupted = () => ({ type: 'turn/end', data: { reason: { kind: 'interrupted' } } });
const start = () => ({ type: 'turn/start', data: {} });
const end = () => ({ type: 'turn/end', data: { reason: { kind: 'completed' } } });
const goal = (extra = {}) => ({ id: 'goal-1', revision: 7, phase: 'paused', activation: 'disarmed',
  roundsStarted: 1, maxGoalRounds: 3, ...extra });
const row = (sessionId, reason, method = null) => ({ sessionId,
  status: method ? 'resumed' : 'skipped', reason, method });

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'conductor-resume-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = (name) => path.join(directory, name);
  const agents = new Map(), events = new Map(), goalViews = new Map();
  const calls = [], messages = [], resumes = [], warnings = [], cleanups = [];
  const claims = () => fs.readdirSync(directory).filter(name => claimPattern.test(name));
  const assertClaimed = () => {
    assert.equal(fs.existsSync(file('resume-request.json')), false);
    assert.equal(claims().length, 1, 'claim exists before any service call');
  };
  const services = {
    sessionController: { async resolveAgent(id) {
      assertClaimed();
      calls.push(['resolve', id]);
      return agents.has(id) ? { agent: agents.get(id) }
        : { error: { code: 'session/not-found', message: 'missing fixture session' } };
    } },
    sessionQuery: { async readSession(id) {
      assertClaimed();
      calls.push(['read', id]);
      return { events: events.get(id), inheritedEventCount: 0 };
    } },
    agents,
    goals: { get: agent => goalViews.get(agent), resume(agent, value) {
      assertClaimed();
      resumes.push({ agent, value });
    } },
  };
  const ctx = { get(name) { assertClaimed(); return services[name]; },
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
    effect(setup) { cleanups.push(setup()); } };
  t.after(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
  const add = (id, history = [start(), interrupted()]) => {
    const agent = { status: 'idle', followup(message) { assertClaimed(); messages.push({ id, message }); } };
    agents.set(id, agent);
    events.set(id, history);
    return agent;
  };
  const write = (request) => fs.writeFileSync(file('resume-request.json'), JSON.stringify(request));
  const saved = () => JSON.parse(fs.readFileSync(file('resume-result.json'), 'utf8'));
  const verify = (result) => {
    for (const key of ['requestedAt', 'completedAt']) {
      assert.equal(typeof result[key], 'string');
      assert.equal(new Date(result[key]).toISOString(), result[key]);
    }
    assert.ok(Date.parse(result.completedAt) >= Date.parse(result.requestedAt));
    assert.deepEqual(saved(), result);
    assert.equal(claims().length, 0);
    assert.equal(fs.existsSync(file('resume-request.json')), false);
    return result;
  };
  const run = async (request) => { write(request); return verify(await processResumeRequest({ ctx, directory })); };
  return { ctx, directory, file, agents, events, goalViews, services, calls, messages, resumes, warnings,
    cleanups, claims, add, write, saved, verify, run };
}

test('resume: absent request is a no-op, including orphaned claims', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.file('resume-request.12345678-1234-4234-8234-123456789abc.processing.json'), '{"sessions":["old"]}');
  assert.equal(await processResumeRequest(f), undefined);
  assert.equal(f.calls.length, 0);
  assert.equal(f.claims().length, 1);
  assert.equal(fs.existsSync(f.file('resume-result.json')), false);
});

test('resume: paused, blocked and disarmed active goals resume with their ID/revision', async (t) => {
  const f = fixture(t);
  for (const phase of ['paused', 'blocked', 'active']) f.goalViews.set(f.add(phase), goal({ phase }));
  const result = await f.run({ sessions: ['paused', 'blocked', 'active'], message: '继续目标' });
  assert.equal(result.status, 'processed');
  assert.deepEqual(result.sessions, ['paused', 'blocked', 'active'].map(id => row(id, 'goal_resumed', 'goal')));
  assert.deepEqual(f.resumes, ['paused', 'blocked', 'active'].map(id => ({ agent: f.agents.get(id),
    value: { id: 'goal-1', revision: 7 } })));
  assert.deepEqual(f.messages, []);
});

test('resume: missing, armed, completed and exhausted goals submit default/custom messages', async (t) => {
  for (const [label, view, message] of [
    ['missing', undefined, undefined], ['armed', goal({ phase: 'active', activation: 'armed' }), '接着做😀'],
    ['completed', goal({ phase: 'complete' }), ''], ['exhausted', goal({ roundsStarted: 3 }), '继续'],
    ['over-budget', goal({ roundsStarted: 4 }), '继续'],
  ]) await t.test(label, async (t) => {
    const f = fixture(t), agent = f.add('A');
    if (view) f.goalViews.set(agent, view);
    else delete f.services.goals;
    const result = await f.run({ sessions: ['A'], ...(message === undefined ? {} : { message }) });
    assert.deepEqual(result.sessions, [row('A', 'message_submitted', 'message')]);
    assert.equal(f.messages.length, 1);
    const sent = f.messages[0].message;
    assert.match(sent.id, new RegExp(`^${uuid}$`));
    assert.deepEqual(sent, { id: sent.id, role: 'user', content: [{ type: 'text', text: message ?? '继续' }],
      source: { kind: 'user' } });
    assert.deepEqual(f.resumes, []);
  });
});

test('resume: missing, running and non-interrupted sessions skip without sending', async (t) => {
  const f = fixture(t);
  f.add('running').status = 'running';
  f.add('complete', [start(), end()]);
  f.add('new-complete', [start(), interrupted(), start(), end(), { type: 'message', data: {} }]);
  f.add('open', [start(), interrupted(), start()]);
  f.add('empty', []);
  const result = await f.run({ sessions: ['missing', 'running', 'complete', 'new-complete', 'open', 'empty'] });
  assert.deepEqual(result.sessions, [row('missing', 'not_found'), row('running', 'running'),
    ...['complete', 'new-complete', 'open', 'empty'].map(id => row(id, 'not_interrupted'))]);
  assert.equal(f.calls.some(([kind, id]) => kind === 'read' && ['missing', 'running'].includes(id)), false);
  assert.deepEqual(f.messages, []);
  assert.deepEqual(f.resumes, []);
});

test('resume: cold loader closes an interrupted turn before history is queried', async (t) => {
  const f = fixture(t);
  const agent = { status: 'idle', followup: message => f.messages.push(message) };
  f.events.set('cold', [start()]);
  f.services.sessionController.resolveAgent = async (id) => {
    assert.equal(id, 'cold');
    assert.equal(f.claims().length, 1);
    f.agents.set(id, agent);
    f.events.get(id).push(interrupted());
    return { agent };
  };
  assert.deepEqual((await f.run({ sessions: ['cold'] })).sessions, [row('cold', 'message_submitted', 'message')]);
  assert.deepEqual(f.calls, [['read', 'cold']]);
  assert.equal(f.messages.length, 1);
});

test('resume: rechecks running status and agent identity after asynchronous history reads', async (t) => {
  for (const change of ['running', 'replace', 'remove']) await t.test(change, async (t) => {
    const f = fixture(t), agent = f.add('A');
    f.goalViews.set(agent, goal());
    f.services.sessionQuery.readSession = async () => {
      await Promise.resolve();
      if (change === 'running') agent.status = 'running';
      else if (change === 'replace') f.agents.set('A', { ...agent });
      else f.agents.delete('A');
      return { events: [interrupted()], inheritedEventCount: 0 };
    };
    assert.deepEqual((await f.run({ sessions: ['A'] })).sessions,
      [row('A', change === 'running' ? 'running' : 'session_changed')]);
    assert.deepEqual(f.messages, []);
    assert.deepEqual(f.resumes, []);
  });
});

test('resume: validates the entire batch before service calls, including newline IDs and Unicode limits', async (t) => {
  const invalid = [null, [], {}, { sessions: 'A' }, { sessions: null }, { sessions: Array(21).fill('A') },
    ...['', 'A\n', 'A\r\n', 'A B', '../A', '中文', 'a'.repeat(101), 1, null, {}]
      .map(id => ({ sessions: ['A', id] })),
    ...[null, 1, {}, [], '😀'.repeat(2001)].map(message => ({ sessions: ['A'], message }))];
  const f = fixture(t);
  f.add('A');
  for (const request of invalid) {
    const result = await f.run(request);
    assert.equal(result.status, 'rejected', JSON.stringify(request));
    assert.deepEqual(result.sessions, []);
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length > 0);
  }
  fs.writeFileSync(f.file('resume-request.json'), '{bad json');
  const malformed = f.verify(await processResumeRequest(f));
  assert.equal(malformed.status, 'rejected');
  assert.deepEqual(malformed.sessions, []);
  assert.ok(malformed.error);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.messages, []);
  assert.deepEqual(f.resumes, []);
});

test('resume: accepts empty batch, twenty IDs, 100-character IDs and 2000 Unicode code points', async (t) => {
  const f = fixture(t);
  const empty = await f.run({ sessions: [] });
  assert.equal(empty.status, 'processed');
  assert.deepEqual(empty.sessions, []);
  assert.deepEqual(f.calls, []);
  const ids = ['Az09_-'.repeat(16) + 'abcd', ...Array.from({ length: 19 }, (_, i) => `S_${i}`)];
  for (const id of ids) f.add(id);
  const message = '😀'.repeat(1999) + '中';
  const result = await f.run({ sessions: ids, message });
  assert.equal(result.status, 'processed');
  assert.deepEqual(result.sessions, ids.map(id => row(id, 'message_submitted', 'message')));
  assert.equal(f.messages.length, 20);
  assert.ok(f.messages.every(({ message: sent }) => sent.content[0].text === message));
  assert.equal(new Set(f.messages.map(({ message: sent }) => sent.id)).size, 20);
});

test('resume: parallel claimers deduplicate IDs, atomically publish once and never replay', async (t) => {
  const f = fixture(t);
  f.add('A'); f.add('B');
  const previous = { old: true };
  fs.writeFileSync(f.file('resume-result.json'), JSON.stringify(previous));
  const rename = fs.renameSync;
  let publications = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === f.file('resume-result.json')) {
      assert.notEqual(from, to);
      assert.equal(path.dirname(from), f.directory);
      assert.deepEqual(f.saved(), previous);
      assert.equal(f.claims().length, 1);
      assert.equal(JSON.parse(fs.readFileSync(from, 'utf8')).status, 'processed');
      publications++;
    }
    return rename(from, to);
  });
  f.write({ sessions: ['A', 'A', 'B', 'B'] });
  const results = await Promise.all([processResumeRequest(f), processResumeRequest(f)]);
  assert.equal(results.filter(value => value === undefined).length, 1);
  const result = f.verify(results.find(Boolean));
  assert.deepEqual(result.sessions, ['A', 'B'].map(id => row(id, 'message_submitted', 'message')));
  assert.equal(publications, 1);
  assert.deepEqual(f.calls, [['resolve', 'A'], ['read', 'A'], ['resolve', 'B'], ['read', 'B']]);
  assert.equal(await processResumeRequest(f), undefined);
  assert.equal(f.messages.length, 2);
  assert.deepEqual(f.saved(), result);
});

test('resume: service failures skip with attempted method and never fall back after a failed send', async (t) => {
  for (const stage of ['lookup', 'resolve', 'resolve-error', 'read', 'identity', 'goal-get', 'goal', 'message']) {
    await t.test(stage, async (t) => {
      const f = fixture(t), agent = f.add('A');
      const fail = () => { throw new Error(`failed ${stage}`); };
      if (stage === 'lookup') f.ctx.get = fail;
      if (stage === 'resolve') f.services.sessionController.resolveAgent = fail;
      if (stage === 'resolve-error') f.services.sessionController.resolveAgent = async () =>
        ({ error: { code: 'session/unavailable', message: `failed ${stage}` } });
      if (stage === 'read') f.services.sessionQuery.readSession = fail;
      if (stage === 'identity') f.agents.get = fail;
      if (stage === 'goal-get') f.services.goals.get = fail;
      if (stage === 'goal') {
        f.goalViews.set(agent, goal());
        f.services.goals.resume = (...args) => { f.resumes.push(args); fail(); };
      }
      if (stage === 'message') agent.followup = (...args) => { f.messages.push(args); fail(); };
      const result = await f.run({ sessions: ['A'] });
      assert.equal(result.status, 'processed');
      assert.deepEqual(result.sessions, [{ sessionId: 'A', status: 'skipped', reason: 'error',
        method: ['goal', 'message'].includes(stage) ? stage : null, error: `failed ${stage}` }]);
      assert.equal(f.messages.length, stage === 'message' ? 1 : 0);
      assert.equal(f.resumes.length, stage === 'goal' ? 1 : 0);
    });
  }
});

test('resume: one service failure does not prevent later sessions from being processed', async (t) => {
  const f = fixture(t), agent = f.add('A');
  f.add('B');
  agent.followup = () => { throw new Error('A failed'); };
  const result = await f.run({ sessions: ['A', 'B'] });
  assert.equal(result.sessions[0].reason, 'error');
  assert.deepEqual(result.sessions[1], row('B', 'message_submitted', 'message'));
  assert.deepEqual(f.messages.map(value => value.id), ['B']);
});

test('resume: failed result write/rename preserves claim and previous result without replay', async (t) => {
  for (const operation of ['writeFileSync', 'renameSync']) await t.test(operation, async (t) => {
    const f = fixture(t);
    f.add('A');
    const previous = { old: true };
    fs.writeFileSync(f.file('resume-result.json'), JSON.stringify(previous));
    f.write({ sessions: ['A'] });
    const original = fs[operation];
    const mock = t.mock.method(fs, operation, (...args) => {
      const target = operation === 'renameSync' ? args[1] : args[0];
      if (path.basename(target).startsWith('resume-result.')) throw new Error('result disk failure');
      return original(...args);
    });
    await assert.rejects(processResumeRequest(f), /result disk failure/);
    mock.mock.restore();
    assert.equal(f.claims().length, 1);
    assert.equal(JSON.parse(fs.readFileSync(f.file(f.claims()[0]), 'utf8')).sessions[0], 'A');
    assert.deepEqual(f.saved(), previous);
    assert.equal(await processResumeRequest(f), undefined);
    assert.equal(f.messages.length, 1);
    assert.equal(f.claims().length, 1);
  });
});

function watchFixture(t, f, failure = false) {
  const watcher = new EventEmitter();
  watcher.close = t.mock.fn();
  let notify;
  const watch = t.mock.method(fs, 'watch', (directory, options, callback) => {
    assert.equal(directory, f.directory);
    assert.equal(options.persistent, false);
    if (failure) throw new Error('watch unavailable');
    notify = callback;
    return watcher;
  });
  const check = registerResumeRequests(f);
  assert.equal(typeof check, 'function');
  assert.equal(watch.mock.callCount(), 1);
  return { watcher, check, notify: (...args) => notify(...args),
    dispose: () => f.cleanups.splice(0).forEach(cleanup => cleanup()) };
}

test('resume watcher: startup checks once and filename/null notifications process requests serially', async (t) => {
  const f = fixture(t);
  f.add('A'); f.add('B');
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const reading = new Promise(resolve => { entered = resolve; });
  const read = f.services.sessionQuery.readSession;
  f.services.sessionQuery.readSession = async (id) => {
    if (id === 'A') { entered(); await gate; }
    return read(id);
  };
  f.write({ sessions: ['A'] });
  const w = watchFixture(t, f);
  await reading; // Initial check starts without manually invoking check().
  const queued = w.notify('change', 'resume-request.json');
  const nameless = w.notify('rename', null);
  assert.equal(f.calls.length, 1);
  release();
  await Promise.all([queued, nameless, w.check()]);
  f.verify(f.saved());
  assert.equal(f.messages.length, 1);
  f.write({ sessions: ['B'] });
  await w.notify('change', 'resume-result.json');
  assert.equal(f.messages.length, 1);
  assert.equal(fs.existsSync(f.file('resume-request.json')), true);
  await w.notify('rename', Buffer.from('resume-request.json'));
  await w.check();
  assert.deepEqual(f.saved().sessions, [row('B', 'message_submitted', 'message')]);
  assert.equal(f.messages.length, 2);
  w.dispose();
  assert.equal(w.watcher.close.mock.callCount(), 1);
});

test('resume watcher: disposal suppresses queued initial checks and later notifications', async (t) => {
  const f = fixture(t);
  f.add('A');
  f.write({ sessions: ['A'] });
  const w = watchFixture(t, f);
  const pending = w.notify('change', 'resume-request.json');
  w.dispose();
  await pending;
  await w.notify('rename', null);
  await w.check();
  assert.deepEqual(f.calls, []);
  assert.equal(fs.existsSync(f.file('resume-request.json')), true);
  assert.equal(w.watcher.close.mock.callCount(), 1);
});

test('resume watcher: creation/error failures warn while initial and explicit checks remain usable', async (t) => {
  for (const failure of ['creation', 'event']) await t.test(failure, async (t) => {
    const f = fixture(t);
    f.add('A'); f.add('B');
    f.write({ sessions: ['A'] });
    const w = watchFixture(t, f, failure === 'creation');
    if (failure === 'event') w.watcher.emit('error', new Error('watch unavailable'));
    await w.check();
    assert.deepEqual(f.saved().sessions, [row('A', 'message_submitted', 'message')]);
    assert.ok(f.warnings.some(message => message.includes('watch unavailable')));
    if (failure === 'event') assert.equal(w.watcher.close.mock.callCount(), 1);
    f.write({ sessions: ['B'] });
    await w.check();
    assert.deepEqual(f.saved().sessions, [row('B', 'message_submitted', 'message')]);
  });
});
