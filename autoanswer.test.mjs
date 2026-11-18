import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AUTO_ANSWER_DEFAULTS, registerAutoAnswer } from './autoanswer.mjs';
import { apply } from './index.mjs';
import { createPanelApi, PANEL_PATH } from './panel.mjs';

const MINUTE = 60_000;
const epoch = Date.UTC(2026, 0, 1);
const fixtureDirectory = (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'conductor-auto-answer-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};
const choice = (label, description) => ({ label, description });
const question = (options = [choice('方案 A'), choice('方案 B')], fields = {}) => ({
  id: 'choice', question: '本次采用哪个方案？', options, ...fields,
});
const humanAnswer = { answers: [{ id: 'choice', selected: ['方案 B'] }] };
const flush = () => new Promise(setImmediate);

function host(t, options = {}) {
  const { directory = fixtureDirectory(t), settings = {}, serviceAvailable = true, allowSubagents = false } = options;
  const listeners = new Map();
  const agents = new Map();
  const projections = new Map();
  const service = {
    ask() {},
    assertLiveRoot(agent) {
      if (agents.get(agent.id) !== agent) throw Object.assign(new Error('not live'), { code: 'CALLER_NOT_LIVE' });
      if (!allowSubagents && agent.session.header.origin === 'subagent') {
        throw Object.assign(new Error('subagent origin'), { code: 'DELEGATED_CALLER' });
      }
    },
    continued: (agent) => (projections.get(agent.session) ?? []).filter(({ state }) => state === 'continued'),
    answer: t.mock.fn((agent, callId, { answers }) => {
      service.assertLiveRoot(agent);
      const call = service.continued(agent).find((item) => item.callId === callId);
      if (!call) return false;
      assert.deepEqual(answers.map(({ id }) => id).sort(), call.questions.map(({ id }) => id).sort());
      return true;
    }),
  };
  const registry = { get: (id) => agents.get(id), list: () => [...agents.values()] };
  const services = { agents: registry, userQuestions: service };
  let dispose;
  const scope = {
    root: {}, get: (name) => services[name],
    on: (event, fn, options) => listeners.set(event, { fn, options }),
    effect: (fn) => { dispose = fn(); },
  };
  const ctx = { inject: t.mock.fn((names, fn) => {
    assert.deepEqual(names, ['userQuestions']);
    if (serviceAvailable) fn(scope);
  }) };
  function unload() { dispose?.(); dispose = undefined; listeners.clear(); }
  t.after(unload);
  const load = (module = registerAutoAnswer) => module({ ctx, settings: { ...AUTO_ANSWER_DEFAULTS, afterMinutes: 1, ...settings }, directory });
  function emit(event, ...args) { return listeners.get(event)?.fn(...args); }
  function session(id = 'session-a', origin = 'new') {
    const session = { id, header: { origin }, log: [] };
    const agent = { id, session, inbox: { nextStep: [], nextTurn: [] } };
    agents.set(id, agent);
    return agent;
  }
  const agent = session();
  function open(questions = [question()], { owner = agent, wait } = {}) {
    if (serviceAvailable) service.assertLiveRoot(owner);
    const controller = new AbortController();
    const provider = Promise.withResolvers();
    const request = { agent: owner, questions, signal: controller.signal, wait };
    let providerSignal;
    const next = t.mock.fn(() => {
      providerSignal = request.signal;
      providerSignal.addEventListener('abort', () => provider.reject(providerSignal.reason), { once: true });
      return provider.promise;
    });
    const listener = listeners.get('user-questions/request');
    if (listener) assert.deepEqual(listener.options, { global: true, prepend: true });
    const result = listener ? listener.fn(request, next) : next();
    assert.equal(next.mock.callCount(), 1);
    return { result, submit: provider.resolve, cancel: () => controller.abort(new Error('cancelled by user')),
      providerSignal, signal: controller.signal };
  }
  function publish(owner, type, data, time = Date.now()) {
    const event = { type, data, time, seq: owner.session.log.length };
    owner.session.log.push(event);
    emit('session/event', owner.session, event);
  }
  function continued(callId, at, { owner = agent, questions = [question()], turn = 1 } = {}) {
    publish(owner, 'tool/call', { name: 'ask_user_question', callId, turn }, at);
    const active = projections.get(owner.session) ?? [];
    projections.set(owner.session, [...active, { callId, questions, state: 'continued' }]);
    publish(owner, 'tool/result', { turn, message: { toolCallId: callId } });
  }
  return { service, ctx, listeners, load, unload, open, emit, publish, continued, session, agent, agents,
    directory, file: path.join(directory, 'auto-answer-history.jsonl') };
}

function clock(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: epoch });
  return (ms = MINUTE) => t.mock.timers.tick(ms);
}

test('a human answer before the deadline settles the wait without recording an auto-answer', async (t) => {
  const tick = clock(t), h = host(t), panel = h.load();
  const pending = h.open();
  tick(MINUTE - 1);
  pending.submit(humanAnswer);
  assert.equal(await pending.result, humanAnswer);
  tick(MINUTE);
  assert.equal(panel.snapshot().pending.length, 0);
  assert.equal(existsSync(h.file), false);
});

test('single choice picks the first marked label or description and marks the answer as automatic', async (t) => {
  const tick = clock(t), h = host(t), panel = h.load();
  const pending = h.open([question([choice('首项'), choice('方案 A', 'RECOMMENDED'), choice('方案 B（推荐）')])]);
  tick();
  const { answers } = await pending.result;
  assert.deepEqual(answers, [{ id: 'choice', selected: ['方案 A'],
    custom: '（用户超过 1 分钟未回答，已自动选择推荐项；用户回来后可能会修正。）' }]);
  assert.equal(pending.providerSignal.aborted, true);
  assert.equal(pending.signal.aborted, false);
  await flush();
  assert.equal(panel.snapshot().recent[0].reason, 'marked_recommended');
  assert.equal(panel.snapshot().recent[0].waitedMinutes, 1);
});

test('a batch answers every item using marked multi-select choices, first-option fallback and configured free text', async (t) => {
  const tick = clock(t), h = host(t, { settings: { freeText: '按最小改动继续。' } }), panel = h.load();
  const pending = h.open([
    question(),
    question([choice('原始'), choice('蓝色(推荐)'), choice('灰色', '推荐')], { id: 'multi', multiSelect: true }),
    question([choice('单项'), choice('其余')], { id: 'multi-fallback', multiSelect: true }),
    { id: 'text', question: '有什么偏好？' },
  ]);
  tick();
  const { answers } = await pending.result;
  assert.deepEqual(answers.map(({ id, selected }) => [id, selected]), [
    ['choice', ['方案 A']], ['multi', ['蓝色(推荐)', '灰色']], ['multi-fallback', ['单项']], ['text', []],
  ]);
  assert.equal(answers[3].custom, '按最小改动继续。');
  assert.equal(answers.filter(({ custom }) => custom?.includes('未回答')).length, 1);
  await flush();
  assert.deepEqual(panel.snapshot().recent.map(({ reason }) => reason), ['free_text', 'first_option', 'marked_recommended', 'first_option']);
});

test('a risky option blocks the whole batch and only records a skip if the deadline passes', async (t) => {
  const tick = clock(t), h = host(t), panel = h.load();
  const pending = h.open([question(), question([choice('保留'), choice('替换', '会 FORCE_PUSH')], { id: 'risky' })]);
  assert.equal(panel.snapshot().pending[0].reason, 'risky');
  assert.equal(existsSync(h.file), false);
  tick();
  await flush();
  assert.equal(pending.providerSignal.aborted, false);
  assert.deepEqual(panel.snapshot().recent.map(({ reason, selected }) => [reason, selected]), [
    ['skipped_risky', []], ['skipped_risky', []],
  ]);
  assert.equal(await panel.act(panel.snapshot().pending[0].id, 'answer'), false);
  pending.submit(humanAnswer);
  await pending.result;
});

test('a custom risk pattern applies to question text and an empty pattern disables risk matching', async (t) => {
  const tick = clock(t);
  const guarded = host(t, { settings: { riskyPattern: '风险示例' } }), guardedPanel = guarded.load();
  const pending = guarded.open([question(undefined, { question: '风险示例？' })]);
  const permissive = host(t, { settings: { riskyPattern: '' } }), permissivePanel = permissive.load();
  const proceed = permissive.open([question([choice('覆盖现有示例')])]);
  tick();
  assert.deepEqual((await proceed.result).answers[0].selected, ['覆盖现有示例']);
  await flush();
  assert.equal(guardedPanel.snapshot().recent[0].reason, 'skipped_risky');
  assert.equal(permissivePanel.snapshot().recent[0].reason, 'first_option');
  pending.submit(humanAnswer);
  await pending.result;
});

test('owner-only marker skips auto-answer without an intent', async (t) => {
  const tick = clock(t), h = host(t, { settings: { riskyPattern: '' } }), panel = h.load();
  const pending = h.open([question(undefined, { question: '[owner_only] 请选择。' })]);
  tick();
  await flush();
  assert.equal(panel.snapshot().recent[0]?.reason, 'skipped_owner_only');
  assert.equal(pending.providerSignal.aborted, false);
  pending.submit(humanAnswer);
  assert.deepEqual(await pending.result, humanAnswer);
});

test('excluded sessions and host review or approval intents stay manual even with no risk pattern', async (t) => {
  const tick = clock(t), h = host(t, { allowSubagents: true,
    settings: { riskyPattern: '', excludeSessions: ['session-a'], subagents: false } }), panel = h.load();
  const pending = [
    h.open(), h.open([question()], { owner: h.session('session-child', 'subagent') }),
    h.open([question(undefined, { detail: '计划详情', intent: { kind: 'plan-review', approve: '方案 A' } })], { owner: h.session('session-review') }),
    h.open([question([choice('允许'), choice('拒绝')], {
      detail: '范围说明', intent: { kind: 'approval', approve: '允许', reject: '拒绝' },
    })], { owner: h.session('session-approval') }),
  ];
  assert.deepEqual(panel.snapshot().pending.map(({ reason }) => reason), Array(4).fill('excluded'));
  tick();
  await flush();
  assert.deepEqual(panel.snapshot().recent.map(({ reason }) => reason), Array(4).fill('skipped_excluded'));
  for (const request of pending) { request.submit(humanAnswer); await request.result; }
});

test('the 0.2.2-rc.3 origin restriction applies to restored subagents and permits ordinary forks', (t) => {
  const tick = clock(t), h = host(t), child = h.session('session-child', 'subagent'), fork = h.session('session-fork', 'fork');
  fork.session.header.parentSession = h.agent.id;
  assert.throws(() => h.open([question()], { owner: child }), { code: 'DELEGATED_CALLER' });
  h.continued('call-child', epoch, { owner: child });
  h.continued('call-fork', epoch, { owner: fork });
  const panel = h.load();
  assert.deepEqual(panel.snapshot().pending.map(({ sessionId }) => sessionId), ['session-fork']);
  tick();
  assert.equal(h.service.answer.mock.callCount(), 1);
  assert.deepEqual(h.service.answer.mock.calls[0].arguments.slice(0, 2), [fork, 'call-fork']);
});

test('the disabled setting never injects and an absent service never registers an observer', async (t) => {
  const tick = clock(t);
  for (const opts of [{ settings: { enabled: false } }, { serviceAvailable: false }]) {
    const h = host(t, opts), panel = h.load(), pending = h.open();
    assert.equal(h.ctx.inject.mock.callCount(), opts.serviceAvailable === false ? 1 : 0);
    assert.equal(h.listeners.size, 0);
    tick();
    assert.deepEqual(panel.snapshot(), { enabled: opts.serviceAvailable === false, available: false, afterMinutes: 1, pending: [], recent: [] });
    assert.equal(existsSync(h.file), false);
    pending.submit(humanAnswer);
    await pending.result;
  }
});

test('aborting a wait or disposing the owning agent cancels the timer', async (t) => {
  const tick = clock(t), h = host(t), panel = h.load();
  const aborted = h.open(), disposed = h.open([question()], { owner: h.session('session-disposed') });
  aborted.cancel();
  await assert.rejects(aborted.result, /cancelled by user/);
  const owner = h.agents.get('session-disposed');
  h.agents.delete(owner.id);
  h.emit('agent/disposed', { agent: owner });
  tick();
  assert.equal(panel.snapshot().pending.length, 0);
  assert.equal(existsSync(h.file), false);
  disposed.cancel();
  await assert.rejects(disposed.result, /cancelled by user/);
});

test('hot reload keeps the original foreground wait and original deadline', async (t) => {
  const tick = clock(t), h = host(t);
  const panel = h.load(), pending = h.open(), { id } = panel.snapshot().pending[0];
  tick(30_000);
  h.unload();
  const fresh = await import('./autoanswer.mjs?reload-test');
  const reloaded = h.load(fresh.registerAutoAnswer);
  assert.equal(reloaded.snapshot().pending[0].id, id);
  assert.equal(reloaded.snapshot().pending[0].remainingMinutes, 0.5);
  tick(29_999);
  assert.equal(pending.providerSignal.aborted, false);
  tick(1);
  assert.deepEqual((await pending.result).answers[0].selected, ['方案 A']);
});

test('restored continued questions use the tool call time and wait another 30 seconds if overdue', async (t) => {
  const tick = clock(t), h = host(t);
  h.continued('call-overdue', epoch - 2 * MINUTE);
  h.continued('call-in-time', epoch - 15_000, { turn: 2 });
  const panel = h.load();
  assert.deepEqual(panel.snapshot().pending.map(({ waitedMinutes, remainingMinutes }) => [waitedMinutes, remainingMinutes]), [[2, 0.5], [0.3, 0.8]]);
  tick(29_999);
  assert.equal(h.service.answer.mock.callCount(), 0);
  tick(1);
  assert.equal(h.service.answer.mock.callCount(), 1);
  assert.deepEqual(h.service.answer.mock.calls[0].arguments.slice(0, 2), [h.agent, 'call-overdue']);
  tick(15_000);
  assert.equal(h.service.answer.mock.calls[1].arguments[1], 'call-in-time');
});

test('a timed foreground question that becomes continued keeps its original deadline', async (t) => {
  const tick = clock(t), h = host(t), panel = h.load();
  h.publish(h.agent, 'tool/call', { name: 'ask_user_question', callId: 'call-a', turn: 1 });
  const pending = h.open([question()], { wait: { callId: 'call-a', timed: true } });
  tick(30_000);
  pending.cancel();
  await assert.rejects(pending.result, /cancelled by user/);
  h.continued('call-a', epoch);
  assert.equal(panel.snapshot().pending[0].remainingMinutes, 0.5);
  tick(30_000);
  assert.equal(h.service.answer.mock.calls[0].arguments[1], 'call-a');
});

test('a queued human reply or a stopped turn cancels continued-question automation', async (t) => {
  const tick = clock(t), h = host(t), panel = h.load();
  h.continued('call-replied', epoch, { turn: 1 });
  h.continued('call-stopped', epoch, { turn: 2 });
  const message = { source: { kind: 'user-question-reply', callId: 'call-replied' } };
  h.agent.inbox.nextStep.push(message);
  h.emit('agent/inbox/inserted', { agent: h.agent, message });
  h.publish(h.agent, 'turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } });
  h.publish(h.agent, 'tool/result', { turn: 3, message: { toolCallId: 'unrelated' } });
  assert.equal(panel.snapshot().pending.length, 0);
  tick();
  assert.equal(h.service.answer.mock.callCount(), 0);
  assert.equal(existsSync(h.file), false);
});

test('panel POST actions submit immediately or leave a question for the human', async (t) => {
  const tick = clock(t), h = host(t), autoAnswer = h.load();
  const api = createPanelApi({ cfg: {}, runtime: { execute: async () => ({}) }, autoAnswer });
  const post = (id, action) => api('POST', PANEL_PATH + '/auto-answer/action', {}, { id, action });
  const immediate = h.open(), manual = h.open();
  const { autoAnswer: { pending: [a, b] } } = await api('GET', PANEL_PATH + '/status');
  assert.equal((await post(a.id, 'answer')).autoAnswer.pending.length, 1);
  assert.match((await immediate.result).answers[0].custom, /按用户在面板的请求/);
  assert.equal((await post(b.id, 'manual')).autoAnswer.pending[0].reason, 'manual');
  tick();
  assert.equal(manual.providerSignal.aborted, false);
  await assert.rejects(post(a.id, 'answer'), { status: 409 });
  await assert.rejects(post(b.id, 'answer'), { status: 409 });
  manual.submit(humanAnswer);
  await manual.result;
  assert.equal(autoAnswer.snapshot().recent.length, 1);
});

test('a manually claimed continued question stays manual after a host restart', async (t) => {
  const tick = clock(t), h = host(t), panel = h.load();
  h.continued('call-claimed', epoch);
  assert.equal(panel.act(panel.snapshot().pending[0].id, 'manual'), true);
  h.unload();
  const restarted = host(t, { directory: h.directory });
  restarted.continued('call-claimed', epoch);
  const restored = restarted.load();
  tick(MINUTE * 2);
  assert.equal(restored.snapshot().pending[0].reason, 'manual');
  assert.equal(restarted.service.answer.mock.callCount(), 0);
});

test('history keeps 300 entries and clips previews to the requested character counts', async (t) => {
  const tick = clock(t), h = host(t), panel = h.load();
  const old = Array.from({ length: 300 }, (_, index) => JSON.stringify({ index }));
  writeFileSync(h.file, old.join('\n') + '\n');
  const pending = h.open([
    question([choice('🙂'.repeat(110))], { question: '测'.repeat(160) }),
    question([choice('方案')], { id: 'other', question: '本句之后不应记录：passw' + 'ord=fixture-value' }),
  ]);
  assert.equal(panel.snapshot().pending[0].questions[0].length, 60);
  assert.equal(panel.snapshot().pending[0].questions[1], '[敏感内容已隐藏]');
  tick();
  await pending.result;
  await flush();
  const rows = readFileSync(h.file, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows.length, 300);
  assert.equal(rows[0].index, 2);
  assert.equal(rows.at(-2).question, '测'.repeat(120));
  assert.equal(rows.at(-2).selected[0], '🙂'.repeat(80));
  assert.equal(rows.at(-1).question, '[敏感内容已隐藏]');
  assert.equal(panel.snapshot().recent.length, 10);
});

test('apply warns for invalid or unknown autoAnswer configuration and writes normalized settings to loaded.json', (t) => {
  const directory = fixtureDirectory(t);
  const saved = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = directory;
  t.after(() => { if (saved === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = saved; });
  const warnings = [];
  const ctx = { tools: { register() {} }, on() {}, logger: { warn: (message) => warnings.push(message) } };
  const inspect = (autoAnswer) => {
    apply(ctx, { autoAnswer, autoVerify: 'off' });
    return JSON.parse(readFileSync(path.join(directory, 'dsh-codex-conductor', 'loaded.json'), 'utf8'));
  };
  const loaded = inspect({ enabled: 'false', afterMinutes: 0, freeText: ' ', riskyPattern: '(', subagents: null,
    excludeSessions: ['bad id'], afterMinute: 2 });
  assert.deepEqual(loaded.autoAnswer, { enabled: true, afterMinutes: 10, subagents: true, excludeCount: 0,
    riskyPatternEnabled: true, customFreeText: false });
  assert.deepEqual(loaded.unknownConfig, ['autoAnswer.afterMinute']);
  for (const key of Object.keys(AUTO_ANSWER_DEFAULTS)) assert.ok(warnings.some((w) => w.includes('autoAnswer.' + key)));
  assert.deepEqual(inspect([]).autoAnswer, loaded.autoAnswer);
  assert.ok(warnings.some((w) => w.includes('无效的配置 autoAnswer，')));
  assert.deepEqual(inspect({ enabled: false, afterMinutes: 2.5, riskyPattern: '', excludeSessions: ['session-a'], freeText: '继续。' }).autoAnswer,
    { enabled: false, afterMinutes: 2.5, subagents: true, excludeCount: 1, riskyPatternEnabled: false, customFreeText: true });
});
