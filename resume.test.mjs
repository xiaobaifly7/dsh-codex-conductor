import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { processResumeRequest, processSendRequest, registerResumeRequests, registerAutoWake } from './resume.mjs';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const interrupted = () => ({ type: 'turn/end', data: { reason: { kind: 'interrupted' } } });
const blocked = () => ({ type: 'turn/end', data: { reason: { kind: 'blocked' } } });
const start = () => ({ type: 'turn/start', data: {} });
const end = () => ({ type: 'turn/end', data: { reason: { kind: 'completed' } } });
const goal = (extra = {}) => ({ id: 'goal-1', revision: 7, phase: 'paused', activation: 'disarmed',
  roundsStarted: 1, maxGoalRounds: 3, ...extra });
const row = (sessionId, reason, method = null) => ({ sessionId,
  status: method ? 'resumed' : 'skipped', reason, method });

function fixture(t, kind = 'resume') {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'conductor-resume-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = (name) => path.join(directory, name);
  const agents = new Map(), events = new Map(), goalViews = new Map();
  const calls = [], messages = [], resumes = [], wakes = [], warnings = [], cleanups = [];
  const claimPattern = new RegExp(`^${kind}-request\\.${uuid}\\.processing\\.json$`);
  const claims = () => fs.readdirSync(directory).filter(name => claimPattern.test(name));
  const assertClaimed = () => {
    assert.equal(fs.existsSync(file(`${kind}-request.json`)), false);
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
    const agent = { status: 'idle', inbox: { hasPending: false },
      wakeDriver() { assertClaimed(); wakes.push(id); this.status = 'running'; },
      followup(message) { assertClaimed(); messages.push({ id, message }); } };
    agents.set(id, agent);
    events.set(id, history);
    return agent;
  };
  const write = (request) => fs.writeFileSync(file(`${kind}-request.json`), JSON.stringify(request));
  const saved = () => JSON.parse(fs.readFileSync(file(`${kind}-result.json`), 'utf8'));
  const verify = (result) => {
    for (const key of ['requestedAt', 'completedAt']) {
      assert.equal(typeof result[key], 'string');
      assert.equal(new Date(result[key]).toISOString(), result[key]);
    }
    assert.ok(Date.parse(result.completedAt) >= Date.parse(result.requestedAt));
    assert.deepEqual(saved(), result);
    assert.equal(claims().length, 0);
    assert.equal(fs.existsSync(file(`${kind}-request.json`)), false);
    return result;
  };
  const process = kind === 'send' ? processSendRequest : processResumeRequest;
  const run = async (request) => { write(request); return verify(await process({ ctx, directory })); };
  return { ctx, directory, file, agents, events, goalViews, services, calls, messages, resumes, wakes, warnings,
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
  for (const phase of ['paused', 'blocked', 'active']) {
    const agent = f.add(phase);
    agent.inbox.hasPending = true;
    f.goalViews.set(agent, goal({ phase }));
  }
  const result = await f.run({ sessions: ['paused', 'blocked', 'active'], message: '继续目标' });
  assert.equal(result.status, 'processed');
  assert.deepEqual(result.sessions, ['paused', 'blocked', 'active'].map(id => row(id, 'goal_resumed', 'goal')));
  assert.deepEqual(f.resumes, ['paused', 'blocked', 'active'].map(id => ({ agent: f.agents.get(id),
    value: { id: 'goal-1', revision: 7 } })));
  assert.deepEqual(f.messages, []);
  assert.deepEqual(f.wakes, []);
});

test('resume: a turn rejected as blocked after a restart resumes a disarmed goal but never sends a prompt', async (t) => {
  const f = fixture(t);
  const agent = f.add('goal', [start(), interrupted(), start(), blocked()]);
  agent.inbox.hasPending = true;
  f.goalViews.set(agent, goal({ phase: 'active' }));
  f.add('plain', [start(), interrupted(), start(), blocked()]);
  const result = await f.run({ sessions: ['goal', 'plain'] });
  assert.deepEqual(result.sessions, [row('goal', 'goal_resumed', 'goal'), row('plain', 'not_interrupted')]);
  assert.equal(f.resumes.length, 1);
  assert.deepEqual(f.messages, []);
  assert.deepEqual(f.wakes, []);
});

test('resume: blocked pending inbox wakes once without adding messages or changing the inbox', async (t) => {
  const f = fixture(t), agent = f.add('A', [start(), blocked()]);
  const inbox = agent.inbox = Object.freeze({ hasPending: true });
  const result = await f.run({ sessions: ['A', 'A'], message: 'Do not send this prompt' });
  assert.deepEqual(result.sessions, [row('A', 'pending_inbox_woken', 'inbox')]);
  assert.deepEqual(f.wakes, ['A']);
  assert.equal(agent.inbox, inbox);
  assert.equal(agent.inbox.hasPending, true);
  assert.deepEqual(f.messages, []);
  assert.deepEqual(f.resumes, []);
  assert.equal(await processResumeRequest(f), undefined);
  assert.deepEqual(f.wakes, ['A']);
});

test('resume: blocked without pending input keeps the original skip reason', async (t) => {
  const f = fixture(t), agent = f.add('A', [start(), blocked()]);
  delete agent.wakeDriver;
  assert.deepEqual((await f.run({ sessions: ['A'] })).sessions, [row('A', 'not_interrupted')]);
  assert.deepEqual(f.wakes, []);
  assert.deepEqual(f.messages, []);
  assert.deepEqual(f.resumes, []);
});

test('resume: running blocked sessions with pending input never wake, including during a history read', async (t) => {
  for (const duringRead of [false, true]) await t.test(duringRead ? 'during read' : 'already running', async (t) => {
    const f = fixture(t), agent = f.add('A', [start(), blocked()]);
    agent.inbox.hasPending = true;
    if (duringRead) {
      const read = f.services.sessionQuery.readSession;
      f.services.sessionQuery.readSession = async (id) => {
        const result = await read(id);
        agent.status = 'running';
        return result;
      };
    } else agent.status = 'running';
    assert.deepEqual((await f.run({ sessions: ['A'] })).sessions, [row('A', 'running')]);
    assert.deepEqual(f.wakes, []);
    assert.deepEqual(f.messages, []);
    assert.deepEqual(f.resumes, []);
  });
});

test('resume: unavailable agents or inbox interfaces and failed wakes skip without stopping the batch', async (t) => {
  const errors = { agent: /status/, inbox: /hasPending/, pending: /hasPending/,
    wake: /wakeDriver/, failure: /wake failed/ };
  for (const stage of Object.keys(errors)) await t.test(stage, async (t) => {
    const f = fixture(t), agent = f.add('A', [start(), blocked()]);
    agent.inbox.hasPending = true;
    f.add('B', [start(), blocked()]).inbox.hasPending = true;
    if (stage === 'agent') {
      const resolve = f.services.sessionController.resolveAgent;
      f.services.sessionController.resolveAgent = async (id) => id === 'A' ? {} : resolve(id);
    }
    if (stage === 'inbox') delete agent.inbox;
    if (stage === 'pending') delete agent.inbox.hasPending;
    if (stage === 'wake') delete agent.wakeDriver;
    if (stage === 'failure') agent.wakeDriver = () => { throw new Error('wake failed'); };
    const result = await f.run({ sessions: ['A', 'B'] });
    assert.match(result.sessions[0].error, errors[stage]);
    assert.deepEqual(result.sessions, [{ sessionId: 'A', status: 'skipped', reason: 'error',
      method: ['wake', 'failure'].includes(stage) ? 'inbox' : null, error: result.sessions[0].error },
    row('B', 'pending_inbox_woken', 'inbox')]);
    assert.deepEqual(f.wakes, ['B']);
    assert.deepEqual(f.messages, []);
    assert.deepEqual(f.resumes, []);
  });
});

test('resume: missing, armed, completed and exhausted goals submit default/custom messages', async (t) => {
  for (const [label, view, message] of [
    ['missing', undefined, undefined], ['armed', goal({ phase: 'active', activation: 'armed' }), '接着做😀'],
    ['completed', goal({ phase: 'complete' }), ''], ['exhausted', goal({ roundsStarted: 3 }), '继续'],
    ['over-budget', goal({ roundsStarted: 4 }), '继续'],
  ]) await t.test(label, async (t) => {
    const f = fixture(t), agent = f.add('A');
    agent.inbox.hasPending = true;
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
    assert.deepEqual(f.wakes, []);
  });
});

test('resume: missing, running and non-interrupted sessions skip without sending', async (t) => {
  const f = fixture(t);
  f.add('running').status = 'running';
  f.add('complete', [start(), end()]);
  f.add('new-complete', [start(), interrupted(), start(), end(), { type: 'message', data: {} }]);
  f.add('open', [start(), interrupted(), start()]);
  f.add('empty', []);
  for (const agent of f.agents.values()) agent.inbox.hasPending = true;
  const result = await f.run({ sessions: ['missing', 'running', 'complete', 'new-complete', 'open', 'empty'] });
  assert.deepEqual(result.sessions, [row('missing', 'not_found'), row('running', 'running'),
    ...['complete', 'new-complete', 'open', 'empty'].map(id => row(id, 'not_interrupted'))]);
  assert.equal(f.calls.some(([kind, id]) => kind === 'read' && ['missing', 'running'].includes(id)), false);
  assert.deepEqual(f.messages, []);
  assert.deepEqual(f.resumes, []);
  assert.deepEqual(f.wakes, []);
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

test('send: completed idle sessions receive exact user text and source without exposing the message', async (t) => {
  for (const [name, message] of [['custom text', '  新任务😀\n保留空白  '], ['4000 Unicode code points', '😀'.repeat(4000)]]) {
    await t.test(name, async (t) => {
      const f = fixture(t, 'send'), agent = f.add('A', [start(), end()]);
      f.goalViews.set(agent, goal());
      const result = await f.run({ sessionId: 'A', message });
      assert.deepEqual(result, { requestedAt: result.requestedAt, sessionId: 'A', status: 'sent',
        reason: 'message_submitted', completedAt: result.completedAt });
      assert.equal(f.messages.length, 1);
      const sent = f.messages[0].message;
      assert.match(sent.id, new RegExp(`^${uuid}$`));
      assert.deepEqual(sent, { id: sent.id, role: 'user', content: [{ type: 'text', text: message }],
        source: { kind: 'user' } });
      assert.deepEqual(f.calls, [['resolve', 'A'], ['read', 'A']]);
      assert.deepEqual(f.resumes, []);
      assert.deepEqual(f.wakes, []);
      assert.equal(fs.readFileSync(f.file('send-result.json'), 'utf8').includes(message), false);
      assert.equal(JSON.stringify(f.warnings).includes(message), false);
      assert.equal(await processSendRequest(f), undefined);
      assert.equal(f.messages.length, 1);
      assert.equal(fs.existsSync(f.file('resume-result.json')), false);
    });
  }
});

test('send: running sessions skip before reading history or submitting', async (t) => {
  const f = fixture(t, 'send');
  f.add('A', [start(), end()]).status = 'running';
  const result = await f.run({ sessionId: 'A', message: 'Next task' });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'running');
  assert.deepEqual(f.calls, [['resolve', 'A']]);
  assert.deepEqual(f.messages, []);
});

test('send: whenRunning queue submits once to a running session, including one that starts running mid-read', async (t) => {
  for (const when of ['before', 'after']) await t.test(when, async (t) => {
    const f = fixture(t, 'send'), agent = f.add('A', [start(), end()]);
    if (when === 'before') agent.status = 'running';
    else f.services.sessionQuery.readSession = async () => { await Promise.resolve(); agent.status = 'running'; return { events: [end()] }; };
    const result = await f.run({ sessionId: 'A', message: 'Wrap up', whenRunning: 'queue' });
    assert.equal(result.status, 'sent');
    assert.equal(result.reason, 'message_queued');
    assert.equal(f.messages.length, 1);
    assert.deepEqual(f.messages[0].message.content, [{ type: 'text', text: 'Wrap up' }]);
    assert.deepEqual(f.messages[0].message.source, { kind: 'user' });
  });
  const f = fixture(t, 'send'), agent = f.add('A', [start(), end()]);
  agent.status = 'running';
  f.services.sessionQuery.readSession = async () => { f.agents.set('A', { ...agent }); return { events: [end()] }; };
  const replaced = await f.run({ sessionId: 'A', message: 'Wrap up', whenRunning: 'queue' });
  assert.equal(replaced.reason, 'session_changed');
  assert.deepEqual(f.messages, []);
});

test('send: rejects missing fields, batches, empty messages, invalid IDs and overlong Unicode before service calls', async (t) => {
  const f = fixture(t, 'send');
  f.add('A');
  const invalid = [null, [], {}, 'request', { sessionId: 'A' }, { message: 'Next task' },
    { sessions: ['A'], message: 'Next task' }, { sessionId: 'A', sessions: [], message: 'Next task' },
    ...['steer', true, null, ''].map(whenRunning => ({ sessionId: 'A', message: 'Next task', whenRunning })),
    ...['', 'A\n', '../A', 'a'.repeat(101), ['A'], null, 1].map(sessionId => ({ sessionId, message: 'Next task' })),
    ...['', ' \t\n', null, 1, [], {}, 'a'.repeat(4001), '😀'.repeat(4001)]
      .map(message => ({ sessionId: 'A', message }))];
  for (const request of invalid) {
    const result = await f.run(request);
    assert.equal(result.status, 'skipped', JSON.stringify(request));
    assert.equal(result.reason, 'invalid_request');
    assert.ok(result.error);
  }
  const privateText = 'private malformed message';
  fs.writeFileSync(f.file('send-request.json'), `{"sessionId":"A","message":"${privateText}" invalid`);
  const malformed = f.verify(await processSendRequest(f));
  assert.equal(malformed.status, 'skipped');
  assert.equal(malformed.reason, 'invalid_request');
  assert.equal(fs.readFileSync(f.file('send-result.json'), 'utf8').includes(privateText), false);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.messages, []);
});

test('send: unavailable agents and interfaces skip without throwing or exposing host error text', async (t) => {
  for (const stage of ['not-found', 'agent', 'controller', 'resolve', 'query', 'read', 'agents', 'followup', 'failure']) {
    await t.test(stage, async (t) => {
      const f = fixture(t, 'send'), agent = f.add('A', [start(), end()]);
      const message = 'private host error message';
      if (stage === 'not-found') f.agents.delete('A');
      if (stage === 'agent') f.services.sessionController.resolveAgent = async () => ({});
      if (stage === 'controller') delete f.services.sessionController;
      if (stage === 'resolve') delete f.services.sessionController.resolveAgent;
      if (stage === 'query') delete f.services.sessionQuery;
      if (stage === 'read') delete f.services.sessionQuery.readSession;
      if (stage === 'agents') delete f.services.agents;
      if (stage === 'followup') delete agent.followup;
      if (stage === 'failure') agent.followup = () => { throw new Error(message); };
      const result = await f.run({ sessionId: 'A', message });
      assert.equal(result.sessionId, 'A');
      assert.equal(result.status, 'skipped');
      assert.equal(result.reason, 'error');
      assert.ok(result.error);
      assert.equal(fs.readFileSync(f.file('send-result.json'), 'utf8').includes(message), false);
      assert.equal(JSON.stringify(f.warnings).includes(message), false);
      assert.deepEqual(f.messages, []);
    });
  }
});

test('send: rechecks running status and agent identity after asynchronous history reads', async (t) => {
  for (const change of ['running', 'replace', 'remove']) await t.test(change, async (t) => {
    const f = fixture(t, 'send'), agent = f.add('A', [start(), end()]);
    f.services.sessionQuery.readSession = async () => {
      await Promise.resolve();
      if (change === 'running') agent.status = 'running';
      else if (change === 'replace') f.agents.set('A', { ...agent });
      else f.agents.delete('A');
      return { events: [end()] };
    };
    const result = await f.run({ sessionId: 'A', message: 'Next task' });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, change === 'running' ? 'running' : 'session_changed');
    assert.deepEqual(f.messages, []);
  });
});

test('send: parallel claimers submit once and never replay a claimed request', async (t) => {
  const f = fixture(t, 'send');
  f.add('A', [start(), end()]);
  f.write({ sessionId: 'A', message: 'Next task' });
  const results = await Promise.all([processSendRequest(f), processSendRequest(f)]);
  assert.equal(results.filter(value => value === undefined).length, 1);
  assert.equal(f.verify(results.find(Boolean)).status, 'sent');
  assert.equal(await processSendRequest(f), undefined);
  assert.equal(f.messages.length, 1);
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

test('resume watcher: another gate rejection with pending input does not retry the wake', async (t) => {
  const f = fixture(t), agent = f.add('A', [start(), blocked()]);
  agent.inbox.hasPending = true;
  const wake = agent.wakeDriver;
  agent.wakeDriver = function () {
    wake.call(this);
    f.events.get('A').push(start(), blocked());
    this.status = 'idle';
  };
  f.write({ sessions: ['A'] });
  const w = watchFixture(t, f);
  await w.check();
  assert.deepEqual(f.saved().sessions, [row('A', 'pending_inbox_woken', 'inbox')]);
  await w.notify('change', 'resume-result.json');
  await w.notify('rename', null);
  await w.check();
  assert.deepEqual(f.wakes, ['A']);
  assert.deepEqual(f.messages, []);
  assert.deepEqual(f.resumes, []);
});

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

test('send watcher: startup and filename notifications share one watcher that closes on unload', async (t) => {
  const f = fixture(t, 'send');
  for (const id of ['A', 'B', 'C']) f.add(id, [start(), end()]);
  f.write({ sessionId: 'A', message: 'First task' });
  const w = watchFixture(t, f);
  await w.check();
  assert.equal(f.saved().status, 'sent');
  assert.deepEqual(f.messages.map(value => value.id), ['A']);
  f.write({ sessionId: 'B', message: 'Second task' });
  await w.notify('change', 'send-result.json');
  assert.equal(f.messages.length, 1);
  await w.notify('rename', Buffer.from('send-request.json'));
  f.verify(f.saved());
  assert.deepEqual(f.messages.map(value => value.id), ['A', 'B']);
  f.write({ sessionId: 'C', message: 'After unload' });
  const queued = w.notify('change', 'send-request.json');
  w.dispose();
  await queued;
  await w.notify('rename', null);
  assert.equal(w.watcher.close.mock.callCount(), 1);
  assert.equal(fs.existsSync(f.file('send-request.json')), true);
  assert.equal(f.messages.length, 2);
});

function autoWakeFixture(t, enabled = true) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const bus = new EventEmitter();
  const cleanups = [], wakes = [], warnings = [], infos = [], messages = [];
  const jobs = new Map();
  const session = { id: 'S1', log: [] };
  const inbox = { nextStep: [], nextTurn: [], get hasPending() { return this.nextStep.length + this.nextTurn.length > 0; } };
  const agent = { id: session.id, session, status: 'running', inbox,
    followup(message) { messages.push(message); }, steer(message) { messages.push(message); },
    wakeDriver() {
      wakes.push([...inbox.nextStep, ...inbox.nextTurn]);
      agent.status = 'running';
      turnStart();
    } };
  const agents = new Map([[agent.id, agent]]);
  const services = { agents, jobs: { list: () => [...jobs.values()] } };
  const ctx = { get: name => services[name], on: (event, fn) => bus.on(event, fn),
    effect(setup) { cleanups.push(setup()); },
    logger: { warn: text => warnings.push(text), info: text => infos.push(text) } };
  const event = value => { session.log.push(value); bus.emit('session/event', session, value); };
  const turnStart = () => event({ type: 'turn/start', data: {} });
  const idle = () => { agent.status = 'idle'; bus.emit('agent/status', { agent, status: 'idle' }); };
  const endTurn = (kind = 'blocked', becomeIdle = true) => {
    event({ type: 'turn/end', data: { reason: { kind } } });
    if (becomeIdle) idle();
  };
  let n = 0;
  const notice = ({ job = {}, source = {}, target = 'nextStep', id } = {}) => {
    const native = { id: `B${++n}`, owner: agent.id, kind: 'codex', label: `Codex J${n} · test`, status: 'completed', ...job };
    jobs.set(native.id, native);
    const message = { id: id ?? `notice-${n}`, role: 'user', content: [{ type: 'text', text: `background job ${native.id} (codex: ${native.label}) finished` }],
      source: { kind: 'tool-jobs', form: 'notice', ...source } };
    inbox[target].push(message);
    bus.emit('agent/inbox/inserted', { agent, message });
    return message;
  };
  const dispose = () => { for (const cleanup of cleanups.splice(0)) cleanup(); };
  t.after(dispose);
  registerAutoWake({ ctx, enabled });
  return { agent, inbox, agents, services, bus, session, wakes, warnings, infos, messages, notice, event, idle, endTurn, dispose,
    tick: ms => t.mock.timers.tick(ms) };
}

test('auto wake: a delivered conductor notice followed by blocked waits for idle and preserves the inbox', t => {
  const f = autoWakeFixture(t);
  const notice = f.notice();
  f.endTurn('blocked', false);
  f.tick(10_000);
  assert.deepEqual(f.wakes, [], 'turn/end still owns the running driver');
  f.idle();
  f.tick(999);
  assert.equal(f.wakes.length, 0);
  f.tick(1);
  assert.deepEqual(f.wakes, [[notice]]);
  assert.deepEqual(f.inbox.nextStep, [notice]);
  assert.deepEqual(f.messages, []);
  assert.match(f.infos[0], /自动唤醒 1\/2/);
});

test('auto wake: repeated blocked turns and restored notices exhaust two increasing retries without resetting the batch', t => {
  const f = autoWakeFixture(t);
  const notice = f.notice();
  f.endTurn();
  f.tick(1000);
  f.bus.emit('agent/inbox/inserted', { agent: f.agent, message: notice });
  f.notice();
  f.endTurn();
  f.tick(4999);
  assert.equal(f.wakes.length, 1);
  f.tick(1);
  assert.equal(f.wakes.length, 2);
  f.endTurn();
  assert.equal(f.warnings.filter(text => text.includes('自动唤醒已用尽')).length, 1);
  for (let i = 0; i < 5; i++) {
    f.idle();
    f.endTurn();
    f.tick(60_000);
  }
  assert.equal(f.wakes.length, 2);
  assert.equal(f.warnings.filter(text => text.includes('自动唤醒已用尽')).length, 1);
  assert.deepEqual(f.messages, []);
});

test('auto wake: a consumed batch ends retries and a later distinct notice gets its own budget', t => {
  const f = autoWakeFixture(t);
  f.notice();
  f.endTurn();
  f.tick(1000);
  f.inbox.nextStep.length = 0;
  f.endTurn();
  f.tick(60_000);
  assert.equal(f.wakes.length, 1);
  f.agent.status = 'running';
  const second = f.notice({ target: 'nextTurn' });
  f.endTurn();
  f.tick(1000);
  assert.deepEqual(f.wakes[1], [second]);
});

test('auto wake: a notice arriving while running renews exhausted retries only after the old batch is consumed', async t => {
  for (const consumed of [true, false]) await t.test(consumed ? 'consumed' : 'still pending', t => {
    const f = autoWakeFixture(t);
    const first = f.notice();
    f.endTurn();
    f.tick(1000);
    f.endTurn();
    f.tick(5000);
    f.endTurn();
    assert.equal(f.wakes.length, 2);
    f.agent.status = 'running';
    f.event({ type: 'turn/start', data: {} });
    if (consumed) f.inbox.nextStep.length = 0;
    const second = f.notice({ target: 'nextTurn' });
    f.endTurn('blocked', false);
    f.tick(60_000);
    assert.equal(f.wakes.length, 2, 'a running driver must not be woken');
    f.idle();
    f.tick(999);
    assert.equal(f.wakes.length, 2);
    f.tick(1);
    if (consumed) {
      assert.deepEqual(f.wakes[2], [second]);
      assert.match(f.infos[2], /自动唤醒 1\/2/);
      f.endTurn();
      f.tick(5000);
      assert.equal(f.wakes.length, 4, 'the new batch has both retries');
    } else {
      f.tick(60_000);
      assert.equal(f.wakes.length, 2, 'pending old notices keep the exhausted budget');
      assert.deepEqual([...f.inbox.nextStep, ...f.inbox.nextTurn], [first, second]);
    }
  });
});

test('auto wake: unrelated, unowned, unnotified and nonterminal jobs and nonblocked endings never wake', async t => {
  for (const scenario of ['foreign-kind', 'foreign-label', 'foreign-owner', 'running-job', 'other-source', 'no-notice', 'completed', 'interrupted', 'old-blocked']) {
    await t.test(scenario, t => {
      const f = autoWakeFixture(t);
      if (scenario === 'old-blocked') f.endTurn();
      if (scenario !== 'no-notice') f.notice({
        job: scenario === 'foreign-kind' ? { kind: 'shell' } : scenario === 'foreign-label' ? { label: 'other plugin' }
          : scenario === 'foreign-owner' ? { owner: 'S2' } : scenario === 'running-job' ? { status: 'running' } : {},
        source: scenario === 'other-source' ? { kind: 'user' } : {},
      });
      if (scenario !== 'old-blocked') f.endTurn(['completed', 'interrupted'].includes(scenario) ? scenario : 'blocked');
      f.tick(60_000);
      assert.equal(f.wakes.length, 0);
      assert.deepEqual(f.messages, []);
    });
  }
});

test('auto wake: consumed notices, running or replaced agents, missing services and disposal suppress scheduled wakes', async t => {
  for (const scenario of ['consumed', 'running', 'removed', 'replaced', 'missing-agents', 'missing-jobs', 'disposed-agent', 'unload']) {
    await t.test(scenario, t => {
      const f = autoWakeFixture(t);
      if (scenario === 'missing-jobs') delete f.services.jobs;
      f.notice();
      f.endTurn();
      if (scenario === 'consumed') f.inbox.nextStep.length = 0;
      if (scenario === 'running') f.agent.status = 'running';
      if (scenario === 'removed') f.agents.delete(f.agent.id);
      if (scenario === 'replaced') f.agents.set(f.agent.id, { ...f.agent });
      if (scenario === 'missing-agents') delete f.services.agents;
      if (scenario === 'disposed-agent') f.bus.emit('agent/disposed', { agent: f.agent });
      if (scenario === 'unload') f.dispose();
      assert.doesNotThrow(() => f.tick(60_000));
      assert.equal(f.wakes.length, 0);
      assert.deepEqual(f.messages, []);
      if (scenario === 'unload') {
        f.notice(); f.endTurn(); f.tick(60_000);
        assert.equal(f.wakes.length, 0, 'retired listeners cannot schedule new attempts');
      }
    });
  }
});

test('auto wake: failed wake calls are contained and still consume the finite budget', t => {
  const f = autoWakeFixture(t);
  let attempts = 0;
  f.agent.wakeDriver = () => { attempts++; throw new Error('wake unavailable'); };
  f.notice(); f.endTurn();
  assert.doesNotThrow(() => f.tick(1000));
  assert.doesNotThrow(() => f.tick(5000));
  f.tick(60_000);
  assert.equal(attempts, 2);
  assert.equal(f.warnings.filter(text => text.includes('自动唤醒失败')).length, 2);
  assert.equal(f.warnings.filter(text => text.includes('自动唤醒已用尽')).length, 1);
});

test('auto wake: configuration disables all automatic attempts', t => {
  const f = autoWakeFixture(t, false);
  f.notice(); f.endTurn(); f.tick(60_000);
  assert.deepEqual(f.wakes, []);
  assert.equal(f.bus.eventNames().length, 0);
});
