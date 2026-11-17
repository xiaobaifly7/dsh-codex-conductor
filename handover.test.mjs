import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAliases } from './handover.mjs';

const dir = (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'conductor-handover-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

test('aliases chain predecessors, persist across instances and never touch unrelated sessions', (t) => {
  const root = dir(t);
  const a = createAliases(root);
  assert.deepEqual(a.owners('session-A'), ['session-A']);
  a.link('session-A', 'session-B');
  a.link('session-B', 'session-C');
  // 新实例（模拟热重载或重启）读同一份文件。
  const b = createAliases(root);
  assert.deepEqual(b.owners('session-C'), ['session-C', 'session-B', 'session-A']);
  assert.deepEqual(b.owners('session-B'), ['session-B', 'session-A']);
  assert.deepEqual(b.owners('session-A'), ['session-A']);
  assert.deepEqual(b.owners('session-X'), ['session-X']);
  assert.equal(b.successor('session-A'), 'session-B');
  assert.equal(b.successor('session-C'), undefined);
  assert.equal(JSON.parse(readFileSync(path.join(root, 'handover.json'), 'utf8')).links['session-C'].from, 'session-B');
  // 一个前任只能交给一个后继；不能成环；不能自交。
  assert.throws(() => b.link('session-A', 'session-D'), /already handed over/);
  assert.throws(() => b.link('session-C', 'session-A'), /predecessor/);
  assert.throws(() => b.link('session-D', 'session-D'), /invalid/);
  assert.throws(() => b.link('session-D', 'session-B'), /already took over/);
  b.unlink('session-B', 'session-C');
  assert.deepEqual(b.owners('session-C'), ['session-C']);
  assert.throws(() => b.unlink('session-B', 'session-C'), /did not take over/);
  // 坏文件或没有目录时只按本会话处理。
  assert.deepEqual(createAliases(undefined).owners('session-A'), ['session-A']);
  assert.deepEqual(createAliases(path.join(root, 'missing')).owners('session-C'), ['session-C']);
});

test('hand-over request creates the successor, links it, pauses the old goal, delivers the brief and reports every step', async (t) => {
  const { processHandoverRequest } = await import('./handover.mjs');
  const root = dir(t);
  const aliases = createAliases(root);
  const goalsByAgent = new Map();
  const agents = new Map();
  const prompts = [];
  const created = [];
  const agent = (id, status = 'idle', header = { cwd: '/work/project', agentPreset: 'planner' }) => {
    const value = { id, status, session: { header } };
    agents.set(id, value);
    return value;
  };
  const a = agent('session-A');
  goalsByAgent.set(a, { id: 'G1', revision: 3, phase: 'active', objective: '完成迁移', roundsStarted: 4, maxGoalRounds: 10 });
  const goals = {
    get: (x) => goalsByAgent.get(x),
    pause: (x, ref) => { assert.equal(ref.revision, goalsByAgent.get(x).revision); goalsByAgent.set(x, { ...goalsByAgent.get(x), phase: 'paused' }); },
    resume: (x) => goalsByAgent.set(x, { ...goalsByAgent.get(x), phase: 'active' }),
    create: (x, request) => goalsByAgent.set(x, { id: 'G2', revision: 1, phase: 'active', ...request }),
  };
  const ctx = { get: (name) => ({ goals, sessionController: {
    resolveAgent: async (id) => (agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found', message: 'no' } }),
    create: async (request) => { created.push(request); agent('session-B'); return { sessionId: 'session-B' }; },
    prompt: async (request) => { prompts.push(request); },
  } })[name] };
  let jobs = [
    { job_id: 'J1', execution_status: 'completed', verification_status: 'unreviewed', review_status: 'needs_attention', thread_id: 'T1', cwd: '/work/project', context: { task: '第一单\n细节' } },
    { job_id: 'J2', execution_status: 'running', verification_status: 'unreviewed', review_status: 'pending', thread_id: 'T2', cwd: '/work/project' },
  ];
  const deps = { aliases, since: 1000, deliverWaitMs: 50, sessionJobs: async () => jobs,
    pendingOf: (list) => ({ unreviewed: list.filter((j) => j.review_status === 'needs_attention').map((j) => j.job_id), needsChanges: [] }) };
  const request = async (body) => {
    writeFileSync(path.join(root, 'handover-request.json'), JSON.stringify(body));
    const result = await processHandoverRequest({ ctx, directory: root, ...deps });
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, 'handover-result.json'), 'utf8')), result);
    return result;
  };
  // 有任务在跑时拒绝；正在运行的回合同样拒绝。
  assert.deepEqual([(await request({ sessionId: 'session-A' })).reason, (await request({ sessionId: 'session-A' })).running], ['jobs_running', ['J2']]);
  a.status = 'running';
  jobs = jobs.slice(0, 1);
  assert.equal((await request({ sessionId: 'session-A' })).reason, 'turn_running');
  a.status = 'idle';
  assert.equal((await request({ sessionId: 'session-X' })).reason, 'session_not_found');
  assert.equal((await request({ sessionId: 'session-A', adopt: { from: 'session-A', to: 'session-B' } })).status, 'rejected');
  const result = await request({ sessionId: 'session-A', note: '先收尾 J1' });
  assert.equal(result.status, 'handed_over');
  assert.equal(result.to, 'session-B');
  assert.deepEqual(created, [{ cwd: '/work/project', agentPreset: 'planner' }]);
  assert.deepEqual(result.steps, { session: 'created', alias: 'linked', autoContinue: 'not_installed', predecessorGoal: 'paused', delivered: 'prompted', successorGoal: 'created' });
  assert.deepEqual(result.pending, { unreviewed: ['J1'], needsChanges: [] });
  assert.deepEqual(aliases.owners('session-B'), ['session-B', 'session-A']);
  assert.equal(goalsByAgent.get(a).phase, 'paused');
  const goalB = goalsByAgent.get(agents.get('session-B'));
  assert.deepEqual([goalB.objective, goalB.maxGoalRounds], ['完成迁移', 6]);
  const brief = readFileSync(result.briefPath, 'utf8');
  for (const part of ['session-A → session-B', '完成迁移', '已用 4 / 10 轮', '先收尾 J1', '尚未 codex_review：J1', '| J1 | completed | unreviewed | 有标记 | - | /work/project |', '任务号（job_id）用于 codex_status', '第一单'])
    assert.ok(brief.includes(part), part);
  assert.ok(!brief.includes('细节'));
  // 没有待返工任务时不列线程号。
  assert.ok(!brief.includes('的线程号：'));
  const rework = (await import('./handover.mjs')).buildBrief({ from: 'A', to: 'B', at: 'now', cwd: '/w', goal: null, since: 0, note: '',
    jobs: [{ job_id: 'J9', thread_id: 'TH9', verification_status: 'needs_changes' }], pending: { unreviewed: [], needsChanges: ['J9'] } });
  assert.match(rework, /只用于 codex_run 的 resume[\s\S]*任务 J9 的线程号：TH9/);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].sessionId, 'session-B');
  assert.match(prompts[0].content[0].text, /codex_summary[\s\S]*尚未 codex_review：J1/);
  // 已交接的会话不能再交接一次；adopt 到已有会话；revert 撤销。
  assert.deepEqual([(await request({ sessionId: 'session-A' })).reason, (await request({ sessionId: 'session-A' })).successor], ['already_handed_over', 'session-B']);
  const c = agent('session-C');
  goalsByAgent.set(c, { id: 'G3', revision: 1, phase: 'active', objective: '自己的目标' });
  const adopted = await request({ adopt: { from: 'session-B', to: 'session-C' } });
  assert.deepEqual([adopted.status, adopted.steps.session, adopted.steps.successorGoal], ['handed_over', 'adopted', 'exists']);
  assert.deepEqual(aliases.owners('session-C'), ['session-C', 'session-B', 'session-A']);
  const reverted = await request({ revert: { from: 'session-B', to: 'session-C' } });
  assert.deepEqual([reverted.status, reverted.steps], ['reverted', { alias: 'removed', successorGoal: 'paused', predecessorGoal: 'resumed' }]);
  assert.deepEqual(aliases.owners('session-C'), ['session-C']);
  assert.equal(aliases.successor('session-B'), undefined);
  // 任务记录读不到时不交接。
  deps.sessionJobs = async () => { throw new Error('wsl down'); };
  assert.deepEqual([(await request({ sessionId: 'session-C' })).reason, aliases.successor('session-C')], ['jobs_unreadable', undefined]);
});

test('history tracker counts messages incrementally, flags sessions over the threshold and writes a small status file', async (t) => {
  const { createHistoryTracker } = await import('./handover.mjs');
  const root = dir(t);
  let clock = 1_000_000;
  let threshold = 3;
  const tracker = createHistoryTracker({ directory: root, threshold: () => threshold, now: () => clock, writeEveryMs: 1000 });
  const log = [{ type: 'user/message' }, { type: 'turn/start' }, { type: 'assistant/message' }, { type: 'tool/call' }, { type: 'tool/result' }];
  const agent = { id: 'session-A', session: { log } };
  assert.deepEqual(tracker.observe(agent), { messages: 3, threshold: 3, suggest: false });
  log.push({ type: 'assistant/message' });
  assert.deepEqual(tracker.observe(agent), { messages: 4, threshold: 3, suggest: true });
  // 状态文件只含会话 ID、消息数、是否建议、阈值和时间；写入有节流，flush 立即写。
  tracker.flush();
  const file = JSON.parse(readFileSync(path.join(root, 'history-status.json'), 'utf8'));
  assert.deepEqual(Object.keys(file), ['updatedAt', 'threshold', 'sessions']);
  assert.deepEqual(file.sessions['session-A'], { messages: 4, suggest: true, at: new Date(clock).toISOString() });
  threshold = 0;
  assert.equal(tracker.observe(agent).suggest, false);
  assert.equal(tracker.observe({ id: 'session-B', session: {} }), undefined);
  // 新实例（重载）接着用已有的状态文件。
  clock += 2000;
  const reloaded = createHistoryTracker({ directory: root, threshold: () => 5, now: () => clock });
  assert.deepEqual(reloaded.snapshot().sessions.map((s) => s.sessionId), ['session-A']);
});

// 交接用的最小宿主：会话、目标、sessionController；log 里放 turn/start 模拟回合。
function host(t) {
  const root = dir(t);
  const agents = new Map();
  const goalsByAgent = new Map();
  const prompts = [];
  let next = 0;
  const agent = (id, status = 'idle') => {
    const value = { id, status, session: { header: { cwd: '/work/p' }, log: [] } };
    agents.set(id, value);
    return value;
  };
  const goals = {
    get: (x) => goalsByAgent.get(x),
    pause: (x) => goalsByAgent.set(x, { ...goalsByAgent.get(x), phase: 'paused' }),
    resume: (x) => goalsByAgent.set(x, { ...goalsByAgent.get(x), phase: 'active' }),
    create: (x, request) => goalsByAgent.set(x, { id: 'G', revision: 1, phase: 'active', ...request }),
  };
  const ctx = { get: (name) => ({ goals, sessionController: {
    resolveAgent: async (id) => (agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found', message: 'no' } }),
    create: async () => { const id = `session-N${++next}`; agent(id); return { sessionId: id }; },
    prompt: async (request) => { prompts.push(request); },
  } })[name] };
  const aliases = createAliases(root);
  const deps = { aliases, since: 0, deliverWaitMs: 50, sessionJobs: async () => [], pendingOf: () => ({ unreviewed: [], needsChanges: [] }) };
  const request = async (body, extra = {}) => {
    const { processHandoverRequest } = await import('./handover.mjs');
    writeFileSync(path.join(root, 'handover-request.json'), JSON.stringify(body));
    return processHandoverRequest({ ctx, directory: root, ...deps, ...extra });
  };
  return { root, agent, agents, goalsByAgent, aliases, request, prompts };
}

test('every hand-over, adoption and revert records its origin and request time in the result, the link, the brief and the history', async (t) => {
  const { appendHandoverHistory, readHandoverHistory } = await import('./handover.mjs');
  const h = host(t);
  h.agent('session-A');
  h.agent('session-C');
  const handed = await h.request({ sessionId: 'session-A', origin: 'panel', requestedAt: '2026-11-17T01:02:03.000Z' });
  assert.deepEqual([handed.status, handed.origin, handed.requestedAt], ['handed_over', 'panel', '2026-11-17T01:02:03.000Z']);
  const link = h.aliases.links()[handed.to];
  assert.deepEqual([link.from, link.origin, link.requestedAt, link.toMessages, link.toTurns, link.delivered], ['session-A', 'panel', '2026-11-17T01:02:03.000Z', 0, 0, true]);
  assert.match(readFileSync(handed.briefPath, 'utf8'), /发起来源：panel（请求时间 2026-11-17T01:02:03.000Z）/);
  // 没带来源的请求（外部直接写文件）记为 file，请求时间取认领时刻。
  const adopted = await h.request({ adopt: { from: handed.to, to: 'session-C' } });
  assert.deepEqual([adopted.status, adopted.origin, h.aliases.links()['session-C'].origin], ['handed_over', 'file', 'file']);
  assert.ok(Date.parse(adopted.requestedAt) <= Date.parse(adopted.completedAt));
  const reverted = await h.request({ revert: { from: handed.to, to: 'session-C' }, origin: 'confirm' });
  assert.deepEqual([reverted.status, reverted.origin], ['reverted', 'confirm']);
  assert.equal((await h.request({ sessionId: 'session-A', origin: 'nobody' })).reason, 'invalid_request');
  const history = readHandoverHistory(h.root);
  assert.deepEqual(history.map((e) => [e.action, e.from, e.to, e.origin, e.status, e.reason]), [
    ['handover', 'session-A', handed.to, 'panel', 'handed_over', undefined],
    ['adopt', handed.to, 'session-C', 'file', 'handed_over', undefined],
    ['revert', handed.to, 'session-C', 'confirm', 'reverted', undefined],
    ['invalid', null, null, 'file', 'rejected', 'invalid_request']]);
  // 历史不含交接单正文，只保留最近 200 行。
  assert.ok(!readFileSync(path.join(h.root, 'handover-history.jsonl'), 'utf8').includes('交接单'));
  for (let i = 0; i < 205; i++) appendHandoverHistory(h.root, { at: String(i) });
  const lines = readFileSync(path.join(h.root, 'handover-history.jsonl'), 'utf8').trim().split('\n');
  assert.deepEqual([lines.length, JSON.parse(lines[0]).at, JSON.parse(lines.at(-1)).at], [200, '5', '204']);
});

test('a revert is refused once the successor has new turns beyond the brief, and force reverts with a parallel-session warning', async (t) => {
  const h = host(t);
  h.agent('session-A');
  const handed = await h.request({ sessionId: 'session-A' });
  const successor = h.agents.get(handed.to);
  // 交接单那一回合不算开工。
  successor.session.log.push({ type: 'turn/start' }, { type: 'user/message' }, { type: 'assistant/message' });
  const quiet = await h.request({ revert: { from: 'session-A', to: handed.to } });
  assert.equal(quiet.status, 'reverted');
  assert.equal(quiet.warning, undefined);
  assert.deepEqual(quiet.sessions.map((s) => [s.sessionId, s.state, s.newTurns]), [['session-A', 'restored', undefined], [handed.to, 'detached', 0]]);
  // 再交接一次，继任会话又跑了两个回合。
  h.agent('session-B');
  const again = await h.request({ sessionId: 'session-B' });
  h.agents.get(again.to).session.log.push({ type: 'turn/start' }, { type: 'turn/start' }, { type: 'turn/start' });
  const refused = await h.request({ revert: { from: 'session-B', to: again.to } });
  assert.deepEqual([refused.status, refused.reason, refused.newTurns], ['rejected', 'successor_active', 2]);
  assert.match(refused.message, /继任会话已有 2 个新回合，撤回会造成两个会话并行/);
  assert.equal(h.aliases.successor('session-B'), again.to, 'the link stays');
  // 继任会话正在运行时同样拒绝。
  h.agents.get(again.to).status = 'running';
  assert.equal((await h.request({ revert: { from: 'session-B', to: again.to } })).successorRunning, true);
  const forced = await h.request({ revert: { from: 'session-B', to: again.to }, force: true });
  assert.deepEqual([forced.status, forced.warning, h.aliases.successor('session-B')], ['reverted', 'parallel_sessions', undefined]);
  assert.match(forced.sessions[1].note, /请决定保留哪一个会话/);
});

test('the auto-continue of the old session is turned off through an interface when one exists, otherwise reported as manual, and restored on revert', async (t) => {
  const { setAutoContinue } = await import('./handover.mjs');
  // 插件不在：什么都不做。
  assert.deepEqual(await setAutoContinue(undefined, 'session-A', 'off'), { autoContinue: 'not_installed' });
  assert.deepEqual(await setAutoContinue(() => undefined, 'session-A', 'off'), { autoContinue: 'not_installed' });
  assert.deepEqual(await setAutoContinue(() => { throw new Error('boom'); }, 'session-A', 'off'), { autoContinue: 'failed:boom' });
  const h = host(t);
  h.agent('session-A');
  // 有接口：关掉并记下原模式，撤回时恢复。
  const modes = { 'session-A': 'loop' };
  const api = (id) => ({ mode: modes[id] ?? 'default', setMode: async (mode) => { modes[id] = mode; } });
  const handed = await h.request({ sessionId: 'session-A' }, { autoContinue: api });
  assert.deepEqual([handed.steps.autoContinue, modes['session-A']], ['disabled', 'off']);
  assert.deepEqual([h.aliases.links()[handed.to].autoContinue, h.aliases.links()[handed.to].autoContinuePrevious], ['disabled', 'loop']);
  const reverted = await h.request({ revert: { from: 'session-A', to: handed.to } }, { autoContinue: api });
  assert.deepEqual([reverted.steps.autoContinue, modes['session-A']], ['restored', 'loop']);
  // 接口失败不影响交接。
  const failing = await h.request({ sessionId: 'session-A' }, { autoContinue: () => ({ mode: 'recover', setMode: async () => { throw new Error('busy'); } }) });
  assert.deepEqual([failing.status, failing.steps.autoContinue], ['handed_over', 'failed:busy']);
  // 只读得到模式、没有接口：要求手动关，交接单写明。
  h.agent('session-M');
  const manual = await h.request({ sessionId: 'session-M' }, { autoContinue: () => ({ mode: 'default' }) });
  assert.deepEqual([manual.status, manual.steps.autoContinue], ['handed_over', 'manual_required']);
  assert.match(readFileSync(manual.briefPath, 'utf8'), /把原会话 session-M 的“自动继续”开关关掉/);
  // 关闭这一步可以按配置跳过。
  h.agent('session-S');
  const skipped = await h.request({ sessionId: 'session-S' }, { autoContinue: api, disableAutoContinue: false });
  assert.equal(skipped.steps.autoContinue, undefined);
});

test('auto hand-over decisions honour mode, idleness, links, cooldown, the startup delay and one automatic hand-over a day', async () => {
  const { autoHandoverStep, AUTO_HANDOVER_DEFAULTS } = await import('./handover.mjs');
  const now = Date.parse('2026-11-17T12:00:00Z');
  const hours = (n) => new Date(now - n * 3_600_000).toISOString();
  const base = { record: {}, messages: 6000, threshold: 5000, suggest: true, idle: true, retired: false, link: undefined, now, uptimeMs: 3_600_000 };
  const step = (over = {}, settings = {}) => autoHandoverStep({ ...base, ...over, settings: { ...AUTO_HANDOVER_DEFAULTS, ...settings } });
  assert.equal(AUTO_HANDOVER_DEFAULTS.mode, 'confirm');
  assert.deepEqual(step(), { remind: true, act: 'ask' });
  assert.deepEqual(step({}, { mode: 'off' }), { remind: false, act: null });
  assert.deepEqual(step({}, { mode: 'notify' }), { remind: true, act: null });
  assert.deepEqual(step({}, { mode: 'auto' }), { remind: true, act: 'auto' });
  // 任一条件不满足就不问也不交接。
  assert.deepEqual(step({ suggest: false }), { remind: false, act: null });
  assert.deepEqual(step({ retired: true }), { remind: false, act: null });
  assert.deepEqual(step({ idle: false }), { remind: true, act: null });
  // 继任会话：从交接时起涨满一个阈值才触发。
  assert.deepEqual(step({ link: { toMessages: 2000 } }), { remind: false, act: null });
  assert.deepEqual(step({ link: { toMessages: 900 } }), { remind: true, act: 'ask' });
  // 提醒只在首次和每涨 remindStepMessages 条时再来一次。
  assert.equal(step({ record: { remindedMessages: 5500 } }).remind, false);
  assert.equal(step({ record: { remindedMessages: 4000 } }).remind, true);
  // 冷却：拒绝或询问后 cooldownHours 内不再问；过了冷却可以再问。
  assert.equal(step({ record: { declinedAt: hours(11) } }).act, null);
  assert.equal(step({ record: { askedAt: hours(11) } }).act, null);
  assert.equal(step({ record: { declinedAt: hours(13) } }).act, 'ask');
  assert.equal(step({ record: { declinedAt: hours(1) } }, { cooldownHours: 0.5 }).act, 'ask');
  // auto：宿主启动后前 N 分钟不触发；同一会话 24 小时最多一次。
  assert.equal(step({ uptimeMs: 9 * 60_000 }, { mode: 'auto' }).act, null);
  assert.equal(step({ uptimeMs: 9 * 60_000 }, { mode: 'auto', startupDelayMinutes: 5 }).act, 'auto');
  assert.equal(step({ uptimeMs: 9 * 60_000 }).act, 'ask', 'the startup delay only holds back automatic hand-overs');
  assert.equal(step({ record: { autoAt: [hours(23)] } }, { mode: 'auto' }).act, null);
  assert.equal(step({ record: { autoAt: [hours(25)] } }, { mode: 'auto' }).act, 'auto');
});

test('auto hand-over asks in the panel or submits a request only when the session is idle with no running Codex job', async (t) => {
  const { createAutoHandover, AUTO_HANDOVER_DEFAULTS } = await import('./handover.mjs');
  const root = dir(t);
  const aliases = createAliases(root);
  let clock = Date.parse('2026-11-17T12:00:00Z');
  let settings = { ...AUTO_HANDOVER_DEFAULTS };
  let running = 1;
  const submitted = [];
  const auto = createAutoHandover({ directory: root, settings: () => settings, aliases, now: () => clock, uptime: () => 3_600_000,
    runningJobs: async () => running, submit: (request) => submitted.push(request) });
  const agent = { id: 'session-A', status: 'idle' };
  const big = { messages: 6000, threshold: 5000, suggest: true };
  // 有 Codex 任务在跑：只提醒，不问。
  await auto.observe(agent, big);
  assert.deepEqual(auto.snapshot().prompts.map((p) => [p.sessionId, p.kind, p.messages]), [['session-A', 'remind', 6000]]);
  running = 0;
  agent.status = 'running';
  await auto.observe(agent, big);
  assert.equal(auto.snapshot().prompts[0].kind, 'remind');
  agent.status = 'idle';
  await auto.observe(agent, big);
  assert.deepEqual(auto.snapshot().prompts.map((p) => p.kind), ['ask']);
  // 同意：写交接请求，来源 confirm；提醒随之关闭。
  assert.deepEqual(auto.answer('session-A', true), { submitted: true });
  assert.deepEqual(submitted, [{ sessionId: 'session-A', origin: 'confirm', requestedAt: new Date(clock).toISOString() }]);
  assert.deepEqual(auto.snapshot().prompts, []);
  assert.throws(() => auto.answer('session-A', true), (error) => error.code === 'none');
  // 拒绝：冷却期内不再问；没人理的询问过了冷却期也算过期，可以再问。
  const b = { id: 'session-B', status: 'idle' };
  await auto.observe(b, big);
  auto.answer('session-B', false);
  clock += 11 * 3_600_000;
  await auto.observe(b, { ...big, messages: 6100 });
  assert.deepEqual(auto.snapshot().prompts, []);
  clock += 2 * 3_600_000;
  await auto.observe(b, { ...big, messages: 6200 });
  assert.deepEqual(auto.snapshot().prompts.map((p) => [p.sessionId, p.kind]), [['session-B', 'ask']]);
  clock += 13 * 3_600_000;
  assert.deepEqual(auto.snapshot().prompts, [], 'an unanswered question expires after the cooldown');
  // auto：直接提交来源为 auto 的请求；查任务失败时跳过。
  settings = { ...settings, mode: 'auto' };
  const c = { id: 'session-C', status: 'idle' };
  await auto.observe(c, big);
  assert.deepEqual(submitted.at(-1), { sessionId: 'session-C', origin: 'auto', requestedAt: new Date(clock).toISOString() });
  const count = submitted.length;
  await auto.observe(c, big);
  assert.equal(submitted.length, count, 'at most one automatic hand-over a day');
  const failing = createAutoHandover({ directory: root, settings: () => settings, aliases, now: () => clock, uptime: () => 3_600_000,
    runningJobs: async () => { throw new Error('wsl down'); }, submit: (request) => submitted.push(request) });
  await failing.observe({ id: 'session-D', status: 'idle' }, big);
  assert.equal(submitted.length, count);
  // 已交接出去的会话不再提醒，也不出现在建议列表里。
  aliases.link('session-A', 'session-Z');
  assert.deepEqual(auto.snapshot([{ sessionId: 'session-A', suggest: true }, { sessionId: 'session-E', suggest: true, messages: 7000 }]).suggestions.map((s) => s.sessionId), ['session-E']);
});

test('panel and automatic hand-over requests share the pending-request rule', async (t) => {
  const { submitHandoverRequest } = await import('./handover.mjs');
  const root = dir(t);
  submitHandoverRequest(root, { sessionId: 'session-A', origin: 'auto' });
  assert.throws(() => submitHandoverRequest(root, { sessionId: 'session-B' }), (error) => error.code === 'pending');
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, 'handover-request.json'), 'utf8')), { sessionId: 'session-A', origin: 'auto' });
});
