import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAliases, instructionArchivePath } from './handover.mjs';

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
    const value = { id, status, session: { header, log: [] } };
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
  assert.deepEqual(result.steps, { session: 'created', alias: 'linked', workspace: 'unavailable', title: 'unavailable', autoContinue: 'not_installed', instructions: 'written', predecessorGoal: 'paused', delivered: 'prompted', successorGoal: 'created' });
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
function host(t, hooks = {}, root = dir(t)) {
  const renames = [];
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
    create: (x, request) => { hooks.goalCreate?.(x, request); goalsByAgent.set(x, { id: 'G', revision: 1, phase: 'active', ...request, ...hooks.goalPatch }); },
  };
  const ctx = { get: (name) => ({ goals, sessionController: {
    resolveAgent: async (id) => (agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found', message: 'no' } }),
    create: async () => { const id = `session-N${++next}`; agent(id); return { sessionId: id }; },
    prompt: async (request) => { prompts.push(request); await hooks.prompt?.(request, agents.get(request.sessionId)); },
    rename: async (request) => { renames.push(request); if (hooks.renameError) throw new Error(hooks.renameError); },
  } })[name] };
  const aliases = createAliases(root);
  const deps = { aliases, since: 0, deliverWaitMs: 50, sessionJobs: async () => [], pendingOf: () => ({ unreviewed: [], needsChanges: [] }) };
  const request = async (body, extra = {}) => {
    const { processHandoverRequest } = await import('./handover.mjs');
    writeFileSync(path.join(root, 'handover-request.json'), JSON.stringify(body));
    return processHandoverRequest({ ctx, directory: root, ...deps, ...extra });
  };
  return { root, agent, agents, goalsByAgent, aliases, request, prompts, renames };
}

const userEvent = (text, time, kind = 'user') => ({
  type: 'user/message', time, data: { content: [{ type: 'text', text }], ...(kind ? { source: { kind } } : {}) },
});
const entriesAt = (file) => JSON.parse(readFileSync(file, 'utf8'));

test('the first archive preserves all original human instructions and the brief points to it', async (t) => {
  const h = host(t);
  const source = h.agent('session-12345678-1234-4321-8765-123456789abc');
  const original = ['  第一条长期指令\n' + '长'.repeat(800) + '\n ', ...Array.from({ length: 13 }, (_, i) => `要求 ${i}`),
    '继续，禁止删除旧文件', 'continue keeping all backups', '继续。', '重启后的固定提示'];
  const autoResume = userEvent('重启后的固定提示', 21);
  autoResume.data.source.via = 'codex-conductor';
  source.session.log.push(...original.map((text, i) => userEvent(text, i + 1)),
    userEvent(' \n ', 20), autoResume, userEvent('[codex-conductor 交接] 自动交接单', 22, 'plugin:codex-conductor'),
    userEvent('插件消息', 23, 'plugin:example'), userEvent('系统消息', 24, 'system'), userEvent('工具通知', 25, 'tool-jobs'),
    userEvent('来源不明', 26, null), { ...userEvent('工具结果', 27), type: 'tool/result' });
  const result = await h.request({ sessionId: source.id }, { autoMessage: '重启后的固定提示' });
  const file = path.join(h.root, 'handovers', `instructions-${source.id}.json`);
  assert.equal(result.instructions.file, file);
  assert.deepEqual(entriesAt(file), original.map((text, i) => ({ text, at: new Date(i + 1).toISOString() })));
  assert.equal(result.checks.instructions, 'ok');
  const brief = readFileSync(result.briefPath, 'utf8');
  assert.ok(brief.includes(file));
  assert.match(brief, /共 18 条，时间范围 1970-01-01T00:00:00.001Z 至 1970-01-01T00:00:00.018Z。早于最近 12 条的指令仍然有效/);
  assert.match(brief, /最近的用户指令[\s\S]*要求 12/);
  assert.doesNotMatch(brief, /第一条长期指令|禁止删除旧文件|continue keeping all backups/);
});

test('case-variant chain roots get separate archives and successor read permissions', async (t) => {
  const appData = dir(t);
  const root = path.join(appData, 'dsh-codex-conductor');
  mkdirSync(root);
  const h = host(t, {}, root);
  const { apply } = await import('./index.mjs');
  const previous = process.env.LOCALAPPDATA;
  let execute;
  try {
    process.env.LOCALAPPDATA = appData;
    apply({ tools: { register() {}, guard() {} }, on(name, handler) { if (name === 'tools/execute') execute = handler; } },
      { workspaces: ['*'], plannerReads: 'products', autoVerify: 'off' },
      async (_cfg, argv) => ({ status: 'completed', owner: argv[2], paths: [] }));
  } finally {
    if (previous === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previous;
  }
  const archive = async (id, text) => {
    h.agent(id).session.log.push(userEvent(text, 1));
    const result = await h.request({ sessionId: id });
    assert.equal(result.checks.instructions, 'ok');
    return result;
  };
  const a = await archive('ChainA', '大写链指令');
  const b = await archive('chaina', '小写链指令');
  const read = (owner, file) => execute({ name: 'read', arguments: { path: file }, agent: h.agents.get(owner) },
    async () => ({ value: 'read' }));
  assert.equal((await read(a.to, a.instructions.file)).value, 'read');
  assert.equal((await read(b.to, b.instructions.file)).value, 'read');
  assert.equal((await read(a.to, b.instructions.file)).isError, true);
  assert.equal((await read(b.to, a.instructions.file)).isError, true);
  assert.notEqual(a.instructions.file.toLowerCase(), b.instructions.file.toLowerCase());
  assert.deepEqual(entriesAt(a.instructions.file).map(({ text }) => text), ['大写链指令']);
  assert.deepEqual(entriesAt(b.instructions.file).map(({ text }) => text), ['小写链指令']);
});

test('a successor appends its instructions to the same archive without duplicating its predecessors, including after a revert', async (t) => {
  const h = host(t);
  const a = h.agent('session-A');
  a.session.log.push(userEvent('重复输入的真实指令', 1));
  const first = await h.request({ sessionId: a.id });
  const b = h.agents.get(first.to);
  b.session.log.push(userEvent('重复输入的真实指令', 1), userEvent('更新', 2));
  const second = await h.request({ sessionId: b.id });
  assert.equal(second.instructions.file, first.instructions.file);
  assert.deepEqual(entriesAt(second.instructions.file).map(({ text }) => text), ['重复输入的真实指令', '重复输入的真实指令', '更新']);
  assert.equal((await h.request({ revert: { from: b.id, to: second.to } })).status, 'reverted');
  const retry = await h.request({ sessionId: b.id });
  assert.equal(retry.instructions.count, 3);
  assert.deepEqual(entriesAt(retry.instructions.file).map(({ text }) => text), ['重复输入的真实指令', '重复输入的真实指令', '更新']);
});

test('an existing chain without an archive backfills its linked predecessors in timestamp order', async (t) => {
  const h = host(t);
  h.agent('session-A').session.log.push(userEvent('原会话较晚的指令', 2));
  const b = h.agent('session-B');
  b.session.log.push(userEvent('被接管会话里较早的指令', 1));
  h.aliases.link('session-A', b.id, { instructions: { root: 'session-A', count: 0 } });
  const result = await h.request({ sessionId: b.id });
  assert.equal(result.instructions.root, 'session-A');
  assert.deepEqual(entriesAt(result.instructions.file).map(({ text }) => text), ['被接管会话里较早的指令', '原会话较晚的指令']);
});

test('an archive write failure is reported by the hand-over and self-check without preventing delivery', async (t) => {
  const h = host(t);
  const a = h.agent('session-A');
  a.session.log.push(userEvent('需要在下一次补齐的指令', 1));
  const file = instructionArchivePath(h.root, a.id);
  mkdirSync(file, { recursive: true });
  const result = await h.request({ sessionId: a.id });
  assert.equal(result.status, 'handed_over_with_issues');
  assert.match(result.steps.instructions, /^failed:.+/);
  assert.equal(result.checks.instructions, result.steps.instructions);
  assert.equal(h.aliases.successor(a.id), result.to);
  assert.match(h.prompts[0].content[0].text, /完整用户指令档案未能保存/);
  rmSync(file, { recursive: true });
  const retry = await h.request({ sessionId: result.to });
  assert.equal(retry.checks.instructions, 'ok');
  assert.deepEqual(entriesAt(retry.instructions.file).map(({ text }) => text), ['需要在下一次补齐的指令']);
});

test('the self-check detects an archive shortened after the brief is built', async (t) => {
  const h = host(t, { prompt: () => writeFileSync(instructionArchivePath(h.root, 'session-A'), '[]') });
  h.agent('session-A').session.log.push(userEvent('保留', 1));
  const result = await h.request({ sessionId: 'session-A' });
  assert.equal(result.status, 'handed_over_with_issues');
  assert.equal(result.checks.instructions, 'failed:count_below_brief');
});

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

// 宿主设置服务的替身：describe 给出 auto-continue 的当前值，mutate 按 set / unset 改 sessionModes。
function settingsService(modes, { installed = true, writable = true, fail, busyFor = 0 } = {}) {
  const calls = [];
  return { calls, writable,
    describe: () => (installed ? [{ ns: 'other', value: {} }, { ns: 'auto-continue', value: { sessionModes: { ...modes } } }] : [{ ns: 'other', value: {} }]),
    async mutate(ns, ops) {
      calls.push([ns, ops]);
      if (fail) throw new Error(fail);
      if (calls.length <= busyFor) throw new Error('HMR transactions cannot be nested');
      for (const op of ops) {
        if (op.op === 'set') modes[op.path[1]] = op.value;
        else delete modes[op.path[1]];
      }
    } };
}

test('a hand-over turns the old session auto-continue off through the host settings and a revert restores the previous value', async (t) => {
  const { autoContinueFromSettings, disableAutoContinue, AUTO_CONTINUE_ENTRY } = await import('./handover.mjs');
  assert.equal(AUTO_CONTINUE_ENTRY, 'auto-continue', 'the profile entry id dsh-client-auto-continue registers and mutates');
  const h = host(t);
  // 原来没有这个键：设为 off，撤回时删掉键。
  const modes = { 'session-X': 'loop' };
  const settings = settingsService(modes);
  const probe = autoContinueFromSettings(settings);
  h.agent('session-A');
  const handed = await h.request({ sessionId: 'session-A' }, { autoContinue: probe });
  assert.deepEqual([handed.steps.autoContinue, modes], ['disabled', { 'session-X': 'loop', 'session-A': 'off' }]);
  assert.deepEqual(settings.calls[0], ['auto-continue', [{ op: 'set', path: ['sessionModes', 'session-A'], value: 'off' }]]);
  assert.deepEqual([h.aliases.links()[handed.to].autoContinue, h.aliases.links()[handed.to].autoContinuePrevious], ['disabled', null]);
  assert.equal(handed.checks.predecessorFrozen, 'ok');
  const reverted = await h.request({ revert: { from: 'session-A', to: handed.to } }, { autoContinue: probe });
  assert.deepEqual([reverted.steps.autoContinue, modes], ['restored', { 'session-X': 'loop' }]);
  assert.deepEqual(settings.calls.at(-1), ['auto-continue', [{ op: 'unset', path: ['sessionModes', 'session-A'] }]]);
  // 原来是 loop：撤回时写回 loop；其他会话的键不动。
  modes['session-A'] = 'loop';
  const again = await h.request({ sessionId: 'session-A' }, { autoContinue: probe });
  assert.equal(h.aliases.links()[again.to].autoContinuePrevious, 'loop');
  await h.request({ revert: { from: 'session-A', to: again.to } }, { autoContinue: probe });
  assert.deepEqual(modes, { 'session-X': 'loop', 'session-A': 'loop' });
  // 已经是 off、插件没装、设置服务不可写、写入失败。
  modes['session-A'] = 'off';
  assert.deepEqual(await disableAutoContinue(probe, 'session-A'), { autoContinue: 'already_off' });
  assert.deepEqual(await disableAutoContinue(autoContinueFromSettings(settingsService({}, { installed: false })), 'session-A'), { autoContinue: 'not_installed' });
  assert.deepEqual(await disableAutoContinue(autoContinueFromSettings(undefined), 'session-A'), { autoContinue: 'not_installed' });
  assert.deepEqual(await disableAutoContinue(autoContinueFromSettings(settingsService({}, { writable: false })), 'session-A'), { autoContinue: 'manual_required' });
  h.agent('session-F');
  const failing = await h.request({ sessionId: 'session-F' }, { autoContinue: autoContinueFromSettings(settingsService({}, { fail: 'busy' })) });
  assert.deepEqual([failing.steps.autoContinue, failing.status, failing.checks.predecessorFrozen],
    ['failed:busy', 'handed_over_with_issues', 'failed:autoContinue_failed:busy']);
  // 手动关闭时交接单写明。
  h.agent('session-M');
  const manual = await h.request({ sessionId: 'session-M' }, { autoContinue: autoContinueFromSettings(settingsService({}, { writable: false })) });
  assert.equal(manual.steps.autoContinue, 'manual_required');
  assert.match(readFileSync(manual.briefPath, 'utf8'), /把原会话 session-M 的“自动继续”开关关掉/);
  // disableAutoContinue: false 时完全不碰。
  h.agent('session-S');
  const before = settings.calls.length;
  const skipped = await h.request({ sessionId: 'session-S' }, { autoContinue: probe, disableAutoContinue: false });
  assert.deepEqual([skipped.steps.autoContinue, settings.calls.length], [undefined, before]);
});

test('the brief extracts human instructions and the last completed turn mechanically, filtering automated sources', async () => {
  const { sessionContext } = await import('./handover.mjs');
  const user = (text, source = { kind: 'user' }, time = 1_000) => ({ type: 'user/message', time, data: { content: [{ type: 'text', text }], ...(source ? { source } : {}) } });
  const log = [
    user('最早的要求：用中文写', null, 1),
    user('第一条要求：保留旧接口', { kind: 'user' }, 2),
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '早先的小结' }] } } },
    { type: 'turn/end', time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    user('目标续轮', { kind: 'goal', round: 3 }),
    user('插件通知', { kind: 'plugin:dsh-client-auto-continue' }),
    user('任务通知', { kind: 'tool-jobs', form: 'notice' }),
    user('继续'), user('继续。宿主在你上一轮运行期间重启了; 从中断处继续'), user('(上一步工具「x」已完成, 不要重复执行)'),
    user('[codex-conductor 交接] 本会话接手……'), user('Harness 已重启，接着上次中断的地方继续。'),
    user('继续做第三章，注意术语表', { kind: 'user' }, 5),
    user('长'.repeat(700), { kind: 'user' }, 6),
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'text', text: '阶段小结：' + '进'.repeat(2000) }] } } },
    { type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'thinking', text: '不可见' }] } } },
    { type: 'turn/end', time: Date.parse('2026-11-17T10:00:00Z'), data: { turn: 2, reason: { kind: 'completed' } } },
    { type: 'turn/start', data: { turn: 3 } },
    { type: 'assistant/message', data: { turn: 3, message: { content: [{ type: 'text', text: '出错前的半句' }] } } },
    { type: 'turn/end', time: Date.parse('2026-11-17T11:00:00Z'), data: { turn: 3, reason: { kind: 'error' } } },
  ];
  const context = sessionContext(log, { autoMessage: 'Harness 已重启，接着上次中断的地方继续。' });
  assert.deepEqual(context.instructions.map((m) => m.text.slice(0, 12)), ['长'.repeat(12), '继续做第三章，注意术语表', '第一条要求：保留旧接口']);
  assert.equal(context.instructions[0].text.length, 601, '600 characters plus an ellipsis');
  assert.deepEqual(context.lastTurn, { reason: 'error', at: '2026-11-17T11:00:00.000Z' });
  assert.ok(context.progress.text.startsWith('阶段小结：'));
  assert.equal(context.progress.text.length, 1501);
  // 最多 12 条，最近的在前。
  const many = Array.from({ length: 15 }, (_, i) => user(`要求 ${i}`, { kind: 'user' }, i));
  assert.deepEqual(sessionContext(many).instructions.map((m) => m.text), Array.from({ length: 12 }, (_, i) => `要求 ${14 - i}`));
  // 超过时限：放弃这两节。
  let clock = 0;
  assert.deepEqual(sessionContext(Array.from({ length: 2000 }, () => ({ type: 'tool/call' })), { now: () => (clock += 6_000) }), { timedOut: true });
  assert.deepEqual(sessionContext(undefined), { instructions: [], lastTurn: undefined, progress: undefined });
});

const briefJobs = (n) => Array.from({ length: n }, (_, i) => ({ job_id: `J${String(n - i).padStart(3, '0')}`, execution_status: i === 30 ? 'running' : 'completed',
  verification_status: 'verified', cwd: '/work/project', context: { task: `第 ${n - i} 单：${'整理'.repeat(40)}` } }));

test('the brief has every section in order, caps each section and drops whole sections by priority beyond the total limit', async () => {
  const { buildBrief, sessionContext, BRIEF_LIMIT } = await import('./handover.mjs');
  const log = [
    ...Array.from({ length: 10 }, (_, i) => ({ type: 'user/message', time: Date.parse('2026-11-17T08:00:00Z') + i, data: { source: { kind: 'user' }, content: [{ type: 'text', text: `第 ${i} 条用户要求：${'细节'.repeat(150)}` }] } })),
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: `阶段小结：${'完成'.repeat(900)}` }] } } },
    { type: 'turn/end', time: Date.parse('2026-11-17T09:00:00Z'), data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const base = { from: 'session-A', to: 'session-B', at: '2026-11-17T09:30:00.000Z', cwd: '/work/project', since: 0,
    goal: { phase: 'active', objective: `把迁移做完。${'约束'.repeat(300)}`, roundsStarted: 4, maxGoalRounds: 10 },
    jobs: briefJobs(80), pending: { unreviewed: ['J080', 'J079'], needsChanges: ['J078'] }, context: sessionContext(log), sessionRead: true };
  const brief = buildBrief({ ...base, note: '先把 J058 返工，再派第四章' });
  const titles = brief.match(/^## .*/gm);
  assert.deepEqual(titles.map((title) => title.replace(/（.*$/, '')), ['## 下一步', '## 目标', '## 最近的用户指令', '## 旧会话最后的进展', '## 待收尾', '## 任务', '## 如何回看旧会话', '## 接手须知']);
  assert.ok(brief.length <= BRIEF_LIMIT, String(brief.length));
  assert.match(brief, /## 下一步\n先把 J058 返工，再派第四章/);
  assert.match(brief, /目标已在本会话逐字重建，上限 6 轮（原会话状态 active，已用 4 \/ 10 轮）；以 get_goal 返回的为准/);
  assert.ok(!brief.includes('约束'.repeat(120)), 'only the first 200 characters of the goal');
  assert.equal((brief.match(/^- 2026-11-17T08:00:00\.00\dZ：第 \d 条用户要求/gm) ?? []).length, 10);
  assert.match(brief, /## 最近的用户指令[^\n]*\n以下是用户亲手输入的要求，仍然有效，除非与“下一步”或更新的指令冲突。/);
  assert.match(brief, /最后一个回合：结束原因 completed，2026-11-17T09:00:00\.000Z/);
  assert.match(brief, /session_read\(sessionId="session-A", mode="summary"\)/);
  assert.match(brief, /有“下一步”时直接按它推进，不要为确认方向而向用户提问/);
  // 任务表超过本节上限时只放最近的几单，并写明截断。
  assert.match(brief, /（已截断，共 80 条，显示最近 \d+ 条）/);
  // 没有下一步、没有回看工具、读取日志超时。
  const plain = buildBrief({ ...base, note: '', sessionRead: false, context: { timedOut: true }, jobs: briefJobs(3), pending: { unreviewed: [], needsChanges: [] } });
  assert.match(plain, /## 下一步\n未指定；按目标继续，先完成“待收尾”。/);
  assert.match(plain, /读取旧会话日志超时，省略了“最近的用户指令”和“旧会话最后的进展”/);
  assert.ok(!plain.includes('## 最近的用户指令') && !plain.includes('session_read'));
  assert.match(plain, /codex_summary（session_id="current"）看总览/);
  // 总长度紧张：任务表先缩成未结束、待处理和最近 10 单，再从优先级最低的节开始整节省略；下一步、待收尾从不省略。
  const tight = buildBrief({ ...base, note: '下一步', limit: 6000 });
  assert.ok(tight.length <= 6000 || tight.match(/^## /gm).length === 2, String(tight.length));
  assert.match(tight, /本单超过 6000 字符，省略了：接手须知、如何回看旧会话/);
  assert.ok(tight.includes('## 下一步'));
  const compact = buildBrief({ ...base, note: '', limit: 12_500 });
  const rows = compact.match(/^\| J\d+ /gm) ?? [];
  assert.ok(rows.length <= 13 && rows.some((r) => r.includes('J050')), rows.join(''));
  const smallest = buildBrief({ ...base, note: 'x', limit: 100 });
  assert.deepEqual(smallest.match(/^## .*/gm), ['## 下一步', '## 待收尾']);
  assert.match(smallest, /本单超过 100 字符，省略了：接手须知、如何回看旧会话、任务、旧会话最后的进展、最近的用户指令、目标。/);
});

test('in an extremely long brief the next step, pending close-out and archive reference still survive', async () => {
  const { buildBrief, sessionContext } = await import('./handover.mjs');
  const log = Array.from({ length: 50 }, (_, i) => ({ type: 'user/message', time: i, data: { source: { kind: 'user' }, content: [{ type: 'text', text: `要求 ${i}：${'很长'.repeat(5000)}` }] } }));
  const brief = buildBrief({ from: 'session-A', to: 'session-B', at: '2026-11-17T09:30:00.000Z', cwd: '/w', since: 0,
    goal: { phase: 'active', objective: '目标'.repeat(50_000), roundsStarted: 1, maxGoalRounds: 3 }, jobs: briefJobs(2000),
    pending: { unreviewed: ['J2000', 'J1999'], needsChanges: ['J1998'] }, context: sessionContext(log), note: `先返工 J1998。${'说明'.repeat(8000)}`,
    instructionArchive: { file: '/state/handovers/instructions-session-A.json', count: 50, first: new Date(0).toISOString(), last: new Date(49).toISOString() } });
  assert.deepEqual(brief.match(/^## .*/gm).map((title) => title.replace(/（.*$/, '')), ['## 下一步', '## 待收尾']);
  assert.match(brief, /## 下一步\n先返工 J1998/);
  assert.match(brief, /尚未 codex_review：J2000、J1999/);
  assert.match(brief, /needs_changes 尚未结案，最新轮次：J1998/);
  assert.ok(brief.includes('/state/handovers/instructions-session-A.json，共 50 条'));
});

test('after a hand-over the plugin checks goal, settings, jobs, delivery and the frozen predecessor, and reports issues without rolling back', async (t) => {
  const h = host(t);
  const a = h.agent('session-A');
  h.goalsByAgent.set(a, { id: 'G1', revision: 1, phase: 'active', objective: '完成迁移'.repeat(1000), roundsStarted: 4, maxGoalRounds: 10 });
  const jobsA = [{ job_id: 'J1', execution_status: 'completed', review_status: 'needs_attention' }, { job_id: 'J2', execution_status: 'completed' }];
  const deps = { sessionJobs: async (owner) => (owner === 'session-A' || h.aliases.predecessors(owner).includes('session-A') ? jobsA : []),
    pendingOf: () => ({ unreviewed: ['J1'], needsChanges: [] }) };
  const ok = await h.request({ sessionId: 'session-A' }, deps);
  assert.deepEqual([ok.status, ok.checks], ['handed_over', { goal: 'ok', settings: 'ok', jobs: 'ok', delivered: 'ok', instructions: 'ok', predecessorFrozen: 'ok', workspace: 'skipped:unavailable' }]);
  // 目标没有逐字接上、轮数不对、模型路由不同、新会话查不到待验收任务：如实报告，不回滚。
  const g = host(t, { goalPatch: { objective: '完成迁移', maxGoalRounds: 3 } });
  const b = g.agent('session-B');
  g.goalsByAgent.set(b, { id: 'G1', revision: 1, phase: 'active', objective: '完成迁移'.repeat(1000), roundsStarted: 4, maxGoalRounds: 10 });
  b.session.log.push({ type: 'model/selection', time: 1, data: { route: { provider: 'p', model: 'secret-model' } } });
  const issues = await g.request({ sessionId: 'session-B' }, { ...deps, sessionJobs: async (owner) => (owner === 'session-B' ? jobsA : []) });
  assert.equal(issues.status, 'handed_over_with_issues');
  assert.equal(issues.checks.goal, 'failed:objective_differs');
  assert.equal(issues.checks.settings, 'failed:differs:model');
  assert.ok(!JSON.stringify(issues.checks).includes('secret-model'), 'only the names of differing settings');
  assert.equal(issues.checks.jobs, 'failed:missing:J1');
  assert.equal(g.aliases.successor('session-B'), issues.to, 'issues alone never roll back');
  const r = host(t, { goalPatch: { maxGoalRounds: 3 } });
  const c = r.agent('session-C');
  r.goalsByAgent.set(c, { id: 'G1', revision: 1, phase: 'active', objective: '目标', roundsStarted: 4, maxGoalRounds: 10 });
  assert.equal((await r.request({ sessionId: 'session-C' })).checks.goal, 'failed:rounds_3_expected_6');
  // 原会话没有目标：goal 跳过；没有待处理任务：jobs 跳过。
  h.agent('session-D');
  const none = await h.request({ sessionId: 'session-D' });
  assert.deepEqual([none.checks.goal, none.checks.jobs], ['skipped:no_goal', 'skipped:no_open_jobs']);
});

test('a hand-over whose brief was not delivered or whose successor goal failed rolls back once; a failed rollback is reported', async (t) => {
  const undelivered = host(t, { prompt: async () => { throw new Error('offline'); } });
  const a = undelivered.agent('session-A');
  undelivered.goalsByAgent.set(a, { id: 'G1', revision: 1, phase: 'active', objective: '目标', roundsStarted: 1, maxGoalRounds: 5 });
  const rolled = await undelivered.request({ sessionId: 'session-A' });
  assert.deepEqual([rolled.status, rolled.rollback.reason, rolled.rollback.status], ['rolled_back', 'delivery_failed', 'reverted']);
  assert.equal(undelivered.aliases.successor('session-A'), undefined);
  assert.equal(undelivered.goalsByAgent.get(a).phase, 'active', 'the old goal is resumed');
  assert.deepEqual(readFileSync(path.join(undelivered.root, 'handover-history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).status), ['rolled_back']);
  // 目标建不起来：交接单那一回合还在跑也照样撤回。
  const goalless = host(t, { goalCreate: () => { throw new Error('goal service down'); }, prompt: async (_request, agent) => { agent.status = 'running'; } });
  const b = goalless.agent('session-B');
  goalless.goalsByAgent.set(b, { id: 'G1', revision: 1, phase: 'active', objective: '目标' });
  const back = await goalless.request({ sessionId: 'session-B' });
  assert.deepEqual([back.status, back.rollback.reason], ['rolled_back', 'successor_goal_failed']);
  // 回滚自身被拒（继任会话已经多跑了回合）：如实记录，不重试，保留交接。
  const stuck = host(t, { prompt: async (_request, agent) => { agent.session.log.push({ type: 'turn/start' }, { type: 'turn/start' }); throw new Error('lost'); } });
  stuck.agent('session-C');
  const failed = await stuck.request({ sessionId: 'session-C' });
  assert.deepEqual([failed.status, failed.rollback.status, failed.rollback.refused], ['handed_over_with_issues', 'rejected', 'successor_active']);
  assert.equal(failed.checks.delivered, 'failed:lost');
  assert.equal(stuck.aliases.successor('session-C'), failed.to);
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
  assert.deepEqual(step({}, { mode: 'auto' }), { remind: true, act: 'auto', origin: 'auto' });
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

test('the depth limit blocks automatic hand-over, appears in state and the panel, and leaves manual hand-over available', async (t) => {
  const { createAutoHandover, AUTO_HANDOVER_DEFAULTS } = await import('./handover.mjs');
  const h = host(t);
  const from = h.agent('session-A');
  const first = await h.request({ sessionId: from.id });
  const successor = h.agents.get(first.to);
  const settings = { ...AUTO_HANDOVER_DEFAULTS, mode: 'auto', maxChainDepth: 1 };
  const submitted = [];
  const auto = createAutoHandover({ directory: h.root, settings: () => settings, aliases: h.aliases, uptime: () => 3_600_000,
    submit: (request) => submitted.push(request) });
  const suggestion = { sessionId: successor.id, messages: 20, threshold: 10, suggest: true };
  const step = await auto.observe(successor, suggestion);
  assert.equal(step.act, null);
  assert.match(step.blocked, /已交接 1 次，达到自动交接上限 1 次/);
  assert.deepEqual(submitted, []);
  assert.equal(entriesAt(path.join(h.root, 'auto-handover.json')).sessions[successor.id].blocked, step.blocked);
  const { threshold, ...tracked } = suggestion;
  assert.equal(auto.snapshot([tracked], threshold).suggestions[0].blocked, step.blocked);
  assert.equal(auto.snapshot([tracked], tracked.messages).suggestions[0].blocked, undefined);
  settings.maxChainDepth = 0;
  assert.equal((await auto.observe(successor, suggestion)).act, 'auto');
  assert.equal(submitted.length, 1);
  settings.maxChainDepth = 1;
  assert.equal((await h.request({ sessionId: successor.id, origin: 'panel' })).status, 'handed_over');
});

test('automatic hand-over waits for readable links while panel hand-over remains available', async (t) => {
  const { createAutoHandover, AUTO_HANDOVER_DEFAULTS } = await import('./handover.mjs');
  for (const [label, broken] of [['missing', undefined], ['malformed JSON', '{'], ['invalid link map', '{"links":[]}']]) {
    await t.test(label, async (t) => {
      const h = host(t);
      const agent = h.agent('session-A');
      const suggestion = { sessionId: agent.id, messages: 20, threshold: 10, suggest: true };
      const settings = { ...AUTO_HANDOVER_DEFAULTS, mode: 'auto' };
      const submitted = [];
      const auto = createAutoHandover({ directory: h.root, settings: () => settings, aliases: h.aliases, uptime: () => 3_600_000,
        submit: (request) => submitted.push(request) });
      if (broken !== undefined) writeFileSync(h.aliases.file, broken);
      for (let i = 0; i < 2; i++) {
        const step = await auto.observe(agent, suggestion);
        assert.equal(step.act, null);
        assert.match(step.blocked, /交接链接状态不可读/);
        assert.equal(auto.snapshot([suggestion]).suggestions[0].blocked, step.blocked);
      }
      assert.deepEqual(submitted, []);
      assert.equal((await h.request({ sessionId: agent.id, origin: 'auto' })).reason, 'links_unreadable');
      assert.equal((await h.request({ sessionId: agent.id, origin: 'panel' })).status, 'handed_over');
      const fresh = h.agent('session-B');
      assert.deepEqual(h.aliases.predecessors(fresh.id), []);
      const step = await auto.observe(fresh, { ...suggestion, sessionId: fresh.id });
      assert.equal(step.origin, 'auto');
      assert.equal(step.blocked, undefined);
      assert.deepEqual(submitted.map(({ sessionId }) => sessionId), [fresh.id]);
    });
  }
});

test('the automatic interval follows a chain even through a manual hand-over and a new controller instance', async (t) => {
  const { createAutoHandover, AUTO_HANDOVER_DEFAULTS } = await import('./handover.mjs');
  const h = host(t);
  const a = h.agent('session-A');
  writeFileSync(h.aliases.file, '{"links":{}}');
  const settings = { ...AUTO_HANDOVER_DEFAULTS, mode: 'auto' };
  let now = Date.now() - 5 * 3_600_000; // 请求可能在宿主处理前已等待了数小时。
  const options = { directory: h.root, settings: () => settings, aliases: h.aliases, now: () => now, uptime: () => 3_600_000 };
  const auto = createAutoHandover(options);
  const suggestion = { messages: 20, threshold: 10, suggest: true };
  assert.equal((await auto.observe(a, suggestion)).origin, 'auto');
  const first = await h.request(entriesAt(path.join(h.root, 'handover-request.json')), { onResult: auto.settled });
  const manual = await h.request({ sessionId: first.to, origin: 'panel' });
  const c = h.agents.get(manual.to);
  const reloaded = createAutoHandover(options);
  now = Date.parse(h.aliases.links()[first.to].at) + 6 * 3_600_000 - 1;
  const step = await reloaded.observe(c, suggestion);
  assert.equal(step.act, null);
  assert.match(step.blocked, /同一会话链自动交接至少间隔 6 小时/);
  assert.equal(entriesAt(path.join(h.root, 'auto-handover.json')).sessions[c.id].blocked, step.blocked);
  const unlimited = createAutoHandover({ ...options, settings: () => ({ ...settings, minHoursBetween: 0 }), submit: () => {} });
  assert.equal(unlimited.snapshot([{ ...suggestion, sessionId: c.id }]).suggestions[0].blocked, undefined);
  now++;
  assert.equal((await reloaded.observe(c, suggestion)).origin, 'auto');
  assert.equal(entriesAt(path.join(h.root, 'auto-handover.json')).sessions[c.id].blocked, undefined);
});

test('auto hand-over asks in the panel or submits a request only when the session is idle with no running Codex job', async (t) => {
  const { createAutoHandover, AUTO_HANDOVER_DEFAULTS } = await import('./handover.mjs');
  const root = dir(t);
  const aliases = createAliases(root);
  let clock = Date.parse('2026-11-17T12:00:00Z');
  let settings = { ...AUTO_HANDOVER_DEFAULTS, withRunningJobs: false };
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
  // 同意：记下同意，下一个回合边界按自动交接的流程提交，来源 confirm；提醒随之关闭。
  assert.deepEqual(auto.answer('session-A', true), { scheduled: true });
  assert.deepEqual([submitted, auto.snapshot().prompts, auto.snapshot().scheduled], [[], [], ['session-A']]);
  await auto.observe(agent, big);
  assert.deepEqual(submitted, [{ sessionId: 'session-A', origin: 'confirm', requestedAt: new Date(clock).toISOString() }]);
  assert.deepEqual(auto.snapshot().scheduled, []);
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
  writeFileSync(aliases.file, '{"links":{}}');
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

// workspaceRegistry 的替身：方法名与宿主 dsh-workspace 一致（list / attachSession / insertSessionBefore / detachSession /
// pinnedSessionIds / pinSession / unpinSession）。
function workspaceRegistry(entries, pinned = [], { pin = true, attachError } = {}) {
  const list = entries.map(({ id, title, sessionIds }) => ({ id, title, sessionIds: [...sessionIds],
    async attachSession(sid) { if (attachError) throw new Error(attachError); if (!this.sessionIds.includes(sid)) this.sessionIds = [sid, ...this.sessionIds]; },
    async insertSessionBefore(sid, before) { const rest = this.sessionIds.filter((x) => x !== sid); rest.splice(rest.indexOf(before), 0, sid); this.sessionIds = rest; },
    async detachSession(sid) { this.sessionIds = this.sessionIds.filter((x) => x !== sid); } }));
  return { list: () => list, pinnedSessionIds: pinned,
    ...(pin ? { async pinSession(sid) { pinned.unshift(sid); }, async unpinSession(sid) { pinned.splice(pinned.indexOf(sid), 1); } } : {}) };
}
const titled = (agent, title) => agent.session.log.push({ type: 'session/title', data: { title } });

test('a successor joins the workspace of its predecessor right above it, follows its pin, and leaves on revert only from that workspace', async (t) => {
  const h = host(t);
  const registry = workspaceRegistry([{ id: 'W1', title: 'Seep-Reverse-Lab', sessionIds: ['session-X', 'session-A'] }, { id: 'W2', title: '别的', sessionIds: [] }], ['session-A']);
  const workspaces = () => registry;
  titled(h.agent('session-A'), '继续 AI 编程助手对话');
  const handed = await h.request({ sessionId: 'session-A' }, { workspaces });
  assert.deepEqual([handed.status, handed.steps.workspace, handed.steps.workspaceId, handed.steps.pin, handed.checks.workspace],
    ['handed_over', 'attached', 'W1', 'pinned', 'ok']);
  assert.deepEqual(registry.list()[0].sessionIds, ['session-X', handed.to, 'session-A']);
  assert.deepEqual(registry.pinnedSessionIds, [handed.to, 'session-A']);
  assert.deepEqual([h.aliases.links()[handed.to].workspaceId, h.aliases.links()[handed.to].pinned], ['W1', true]);
  assert.deepEqual(h.renames, [{ sessionId: handed.to, title: '[交接←A] 继续 AI 编程助手对话' }]);
  assert.equal(handed.steps.title, 'set');
  // 撤回：移出交接放进去的工作区，撤销交接加的置顶；原会话的置顶不动。
  const reverted = await h.request({ revert: { from: 'session-A', to: handed.to } }, { workspaces });
  assert.deepEqual([reverted.steps.workspace, reverted.steps.pin], ['detached', 'unpinned']);
  assert.deepEqual([registry.list()[0].sessionIds, registry.pinnedSessionIds], [['session-X', 'session-A'], ['session-A']]);
  // 用户后来把继任挪到别的工作区：撤回时不动它。
  const again = await h.request({ sessionId: 'session-A' }, { workspaces });
  await registry.list()[0].detachSession(again.to);
  await registry.list()[1].attachSession(again.to);
  const moved = await h.request({ revert: { from: 'session-A', to: again.to } }, { workspaces });
  assert.deepEqual([moved.steps.workspace, registry.list()[1].sessionIds], ['unchanged', [again.to]]);
  // 认领已有会话同样进原会话的分组，但不改它的标题。
  h.agent('session-C');
  const renamed = h.renames.length;
  const adopted = await h.request({ adopt: { from: 'session-A', to: 'session-C' } }, { workspaces });
  assert.deepEqual([adopted.steps.workspace, adopted.steps.title, h.renames.length], ['attached', undefined, renamed]);
  assert.deepEqual(registry.list()[0].sessionIds, ['session-X', 'session-C', 'session-A']);
});

test('workspace placement degrades to none, unavailable, failed or a skipped pin without failing the hand-over', async (t) => {
  const { placeInWorkspace } = await import('./handover.mjs');
  assert.deepEqual(await placeInWorkspace(undefined, 'session-A', 'session-B'), { workspace: 'unavailable' });
  assert.deepEqual(await placeInWorkspace(workspaceRegistry([{ id: 'W1', title: 'w', sessionIds: ['session-X'] }]), 'session-A', 'session-B'), { workspace: 'none' });
  assert.deepEqual(await placeInWorkspace(workspaceRegistry([{ id: 'W1', title: 'w', sessionIds: ['session-A'] }], ['session-A'], { pin: false }), 'session-A', 'session-B'),
    { workspace: 'attached', workspaceId: 'W1', pin: 'skipped' });
  const h = host(t);
  h.agent('session-A');
  const failing = workspaceRegistry([{ id: 'W1', title: 'w', sessionIds: ['session-A'] }], [], { attachError: 'cwd mismatch' });
  const result = await h.request({ sessionId: 'session-A' }, { workspaces: () => failing });
  assert.deepEqual([result.steps.workspace, result.checks.workspace, result.status], ['failed:cwd mismatch', 'failed:not_in_workspace', 'handed_over_with_issues']);
  assert.equal(h.aliases.successor('session-A'), result.to, 'a workspace problem never rolls back');
  h.agent('session-U');
  const ungrouped = await h.request({ sessionId: 'session-U' }, { workspaces: () => workspaceRegistry([]) });
  assert.deepEqual([ungrouped.steps.workspace, ungrouped.checks.workspace, ungrouped.status], ['none', 'skipped:ungrouped', 'handed_over']);
});

test('successor titles name the predecessor without nesting hand-over prefixes', async () => {
  const { successorTitle } = await import('./handover.mjs');
  assert.equal(successorTitle('session-0200eab4-1111-2222', '继续 AI 编程助手对话'), '[交接←0200eab4] 继续 AI 编程助手对话');
  assert.equal(successorTitle('session-0200eab4-1111-2222', undefined), '[交接←0200eab4]');
  assert.equal(successorTitle('session-897a5c8a-3333', '[交接←0200eab4] 继续 AI 编程助手对话'), '[交接←897a5c8a] 继续 AI 编程助手对话');
  assert.equal(successorTitle('session-897a5c8a-3333', '[codex-conductor 交接] 本会话接手会话'), '[交接←897a5c8a]');
  assert.equal(successorTitle('session-1234567890', '长'.repeat(60)), `[交接←12345678] ${'长'.repeat(40)}`);
});

test('startup repair puts an old ungrouped successor into the predecessor workspace and retitles it once', async (t) => {
  const { repairLinks, readHandoverHistory } = await import('./handover.mjs');
  const root = dir(t);
  const aliases = createAliases(root);
  aliases.link('session-0200eab4-aaaa', 'session-897a5c8a-bbbb');
  aliases.link('session-old-other', 'session-moved');
  const sessions = { 'session-0200eab4-aaaa': '继续 AI 编程助手对话', 'session-897a5c8a-bbbb': '[codex-conductor 交接]',
    'session-old-other': '另一件事', 'session-moved': '[codex-conductor 交接]' };
  const renames = [];
  const controller = { resolveAgent: async (id) => ({ agent: { id, session: { log: [{ type: 'session/title', data: { title: sessions[id] } }] } } }),
    rename: async (request) => { renames.push(request); sessions[request.sessionId] = request.title; } };
  const registry = workspaceRegistry([{ id: 'W1', title: 'Seep-Reverse-Lab', sessionIds: ['session-0200eab4-aaaa', 'session-old-other'] },
    { id: 'W2', title: '用户挪过去的', sessionIds: ['session-moved'] }]);
  await repairLinks({ registry, controller, aliases, directory: root });
  assert.deepEqual(registry.list()[0].sessionIds, ['session-897a5c8a-bbbb', 'session-0200eab4-aaaa', 'session-old-other']);
  assert.deepEqual(registry.list()[1].sessionIds, ['session-moved'], 'a successor already in another workspace stays there');
  assert.equal(aliases.links()['session-897a5c8a-bbbb'].workspaceId, 'W1');
  assert.deepEqual(renames.map((r) => [r.sessionId, r.title]), [['session-897a5c8a-bbbb', '[交接←0200eab4] 继续 AI 编程助手对话'],
    ['session-moved', '[交接←old-othe] 另一件事']]);
  assert.ok(Object.values(aliases.links()).every((link) => link.repaired));
  assert.deepEqual(readHandoverHistory(root).map((e) => [e.action, e.origin, e.to, e.status]),
    [['repair', 'startup', 'session-897a5c8a-bbbb', 'repaired'], ['repair', 'startup', 'session-moved', 'repaired']]);
  // 第二次加载什么都不做。
  await registry.list()[0].detachSession('session-897a5c8a-bbbb');
  await repairLinks({ registry, controller, aliases, directory: root });
  assert.deepEqual([registry.list()[0].sessionIds.includes('session-897a5c8a-bbbb'), renames.length, readHandoverHistory(root).length], [false, 2, 2]);
});

// 目标循环的替身：pause / resume 与宿主 GoalService 一样改 phase、activation 和 revision。
function goalLoop() {
  const byAgent = new Map();
  const calls = [];
  return { byAgent, calls,
    get: (agent) => byAgent.get(agent),
    pause(agent, ref) { calls.push(['pause', agent.id]); const g = byAgent.get(agent); assert.equal(ref.revision, g.revision);
      const next = { ...g, phase: 'paused', activation: 'disarmed', revision: g.revision + 1 }; byAgent.set(agent, next); return next; },
    resume(agent, ref) { calls.push(['resume', agent.id]); const g = byAgent.get(agent); assert.equal(ref.revision, g.revision);
      const next = { ...g, phase: 'active', activation: 'armed', revision: g.revision + 1 }; byAgent.set(agent, next); return next; } };
}

test('in a goal loop auto hand-over pauses the goal at the idle edge, hands over, and restores the goal with a retry cooldown when it does not', async (t) => {
  const { createAutoHandover, AUTO_HANDOVER_DEFAULTS, RETRY_COOLDOWN_MS } = await import('./handover.mjs');
  const root = dir(t);
  const aliases = createAliases(root);
  writeFileSync(aliases.file, '{"links":{}}');
  const goals = goalLoop();
  const agents = new Map();
  let clock = Date.parse('2026-11-17T12:00:00Z');
  let running = 0;
  let settings = { ...AUTO_HANDOVER_DEFAULTS, mode: 'auto', withRunningJobs: false };
  const submitted = [];
  const auto = createAutoHandover({ directory: root, settings: () => settings, aliases, now: () => clock, uptime: () => 3_600_000,
    runningJobs: async () => running, submit: (request) => submitted.push(request), goals: () => goals, agentOf: (id) => agents.get(id) });
  const session = (id, phase = 'active') => {
    const agent = { id, status: 'idle' };
    agents.set(id, agent);
    goals.byAgent.set(agent, { id: `G-${id}`, revision: 1, phase, activation: phase === 'active' ? 'armed' : 'disarmed', objective: '目标', maxGoalRounds: 10 });
    return agent;
  };
  const big = { messages: 6000, threshold: 5000, suggest: true };
  // 1. 满足条件：空闲事件里同步暂停目标（在 goal 排下一轮之前），再提交交接；交接成功后目标保持暂停。
  const a = session('session-A');
  const observing = auto.observe(a, big);
  assert.equal(goals.byAgent.get(a).phase, 'paused', 'paused before the first await');
  await observing;
  assert.deepEqual(submitted.map((r) => [r.sessionId, r.origin]), [['session-A', 'auto']]);
  auto.settled({ from: 'session-A', requestedAt: submitted[0].requestedAt, status: 'handed_over' });
  assert.deepEqual([goals.byAgent.get(a).phase, goals.calls], ['paused', [['pause', 'session-A']]]);
  // 2. 空闲后发现有任务在跑：恢复目标（重新武装），30 分钟内不再试。
  const b = session('session-B');
  running = 1;
  await auto.observe(b, big);
  assert.deepEqual([goals.byAgent.get(b).phase, goals.byAgent.get(b).activation], ['active', 'armed']);
  running = 0;
  await auto.observe(b, big);
  assert.equal(submitted.length, 1, 'retry cooldown');
  clock += RETRY_COOLDOWN_MS + 1;
  await auto.observe(b, big);
  assert.equal(submitted.at(-1).sessionId, 'session-B');
  // 交接被拒（例如用户恰好开了新回合）：恢复提前暂停的目标，进入重试冷却。
  auto.settled({ from: 'session-B', requestedAt: submitted.at(-1).requestedAt, status: 'refused', reason: 'turn_running' });
  assert.equal(goals.byAgent.get(b).phase, 'active');
  // 3. 用户手动暂停的目标：不暂停也不恢复，照原来的空闲触发提交。
  const c = session('session-C', 'paused');
  const before = goals.calls.length;
  await auto.observe(c, big);
  auto.settled({ from: 'session-C', requestedAt: submitted.at(-1).requestedAt, status: 'refused', reason: 'jobs_running' });
  assert.deepEqual([submitted.at(-1).sessionId, goals.calls.length, goals.byAgent.get(c).phase], ['session-C', before, 'paused']);
  // 4. confirm 模式询问时不碰目标；同意后在下一个空闲边界按同一流程暂停并交接，来源 confirm。
  settings = { ...settings, mode: 'confirm' };
  const d = session('session-D');
  await auto.observe(d, big);
  assert.deepEqual([auto.snapshot().prompts.find((p) => p.sessionId === 'session-D').kind, goals.byAgent.get(d).phase], ['ask', 'active']);
  auto.answer('session-D', true);
  await auto.observe(d, big);
  assert.deepEqual([submitted.at(-1).sessionId, submitted.at(-1).origin, goals.byAgent.get(d).phase], ['session-D', 'confirm', 'paused']);
});

test('title repair also covers auto-generated hand-over titles and runs once per link even after an earlier repair', async (t) => {
  const { repairLinks } = await import('./handover.mjs');
  const root = dir(t);
  const aliases = createAliases(root);
  aliases.link('session-0200eab4-aaaa', 'session-897a5c8a-bbbb');
  aliases.link('session-user-from', 'session-user-to');
  aliases.link('session-new-from', 'session-new-to');
  // 0.9.109 已修过工作区的链接：只缺标题修复。
  aliases.annotate('session-897a5c8a-bbbb', { repaired: '2026-11-18T03:00:00.000Z', workspaceId: 'W1' });
  const sessions = { 'session-0200eab4-aaaa': '继续 AI 编程助手对话', 'session-897a5c8a-bbbb': '[codex-conductor 交接] 本会话接手会话 session-0200eab4…',
    'session-user-from': '原标题', 'session-user-to': '我自己起的名字', 'session-new-from': '原标题', 'session-new-to': '[交接←new-from] 原标题' };
  const renames = [];
  const controller = { resolveAgent: async (id) => ({ agent: { id, session: { log: [{ type: 'session/title', data: { title: sessions[id] } }] } } }),
    rename: async (request) => { renames.push(request); sessions[request.sessionId] = request.title; } };
  await repairLinks({ registry: undefined, controller, aliases, directory: root });
  assert.deepEqual(renames, [{ sessionId: 'session-897a5c8a-bbbb', title: '[交接←0200eab4] 继续 AI 编程助手对话' }]);
  assert.ok(Object.values(aliases.links()).every((link) => link.repaired && link.titleRepaired));
  assert.equal(aliases.links()['session-897a5c8a-bbbb'].workspaceId, 'W1', 'earlier marks stay');
  await repairLinks({ registry: undefined, controller, aliases, directory: root });
  assert.equal(renames.length, 1, 'once per link');
});

test('a hand-over with running Codex jobs carries them to the successor and lists them; a running turn still refuses', async (t) => {
  const h = host(t);
  const a = h.agent('session-A');
  const startedAt = Date.now() / 1000 - 600;
  const jobs = [{ job_id: 'J-run', execution_status: 'running', started_at: startedAt, context: { task: '重写解析器\n细节' } },
    { job_id: 'J-done', execution_status: 'completed' }];
  const deps = { sessionJobs: async (owner) => (owner === 'session-A' || h.aliases.predecessors(owner).includes('session-A') ? jobs : []) };
  assert.equal((await h.request({ sessionId: 'session-A' }, deps)).reason, 'jobs_running', 'withRunningJobs off keeps the refusal');
  writeFileSync(h.aliases.file, '{"links":{}}');
  const carried = await h.request({ sessionId: 'session-A', origin: 'auto' }, { ...deps, withRunningJobs: true });
  assert.deepEqual([carried.status, carried.running, carried.checks.jobs], ['handed_over', ['J-run'], 'ok']);
  const brief = readFileSync(carried.briefPath, 'utf8');
  assert.match(brief, /仍在运行（这些任务随交接转给本会话：用 codex_status 等待并验收，不要重派；结束通知会转到本会话）：\n  - J-run：重写解析器（已运行 10 分钟）/);
  h.agent('session-B');
  h.agents.get('session-B').status = 'running';
  assert.equal((await h.request({ sessionId: 'session-B' }, { ...deps, withRunningJobs: true })).reason, 'turn_running');
  assert.ok(a);
});

test('job notices of a handed-over session go to the last successor and end the old turn without a model step; a revert returns them', async () => {
  const { forwardRetiredNotices, lastSuccessor } = await import('./handover.mjs');
  const links = { 'session-B': { from: 'session-A' }, 'session-C': { from: 'session-B' } };
  const aliases = { successor: (id) => Object.keys(links).find((to) => links[to].from === id) };
  assert.equal(lastSuccessor(aliases, 'session-A'), 'session-C');
  const notice = (id) => ({ id: `m-${id}`, role: 'user', content: [{ type: 'text', text: `background job ${id} completed\n结果` }], source: { kind: 'tool-jobs', form: 'notice' } });
  const jobs = { list: () => [{ id: 'bg-1', kind: 'codex', label: 'Codex 20261118-010203-abcdef · 任务' }, { id: 'bg-2', kind: 'bash', label: 'npm test' }] };
  const received = [];
  const successor = { id: 'session-C', status: 'idle', followup: (m) => received.push(['followup', m]), inject: (m) => received.push(['inject', m]) };
  const resolve = async (id) => (id === 'session-C' ? successor : undefined);
  const agentA = { id: 'session-A' };
  const only = await forwardRetiredNotices({ agent: agentA, messages: [notice('bg-1')], aliases, jobs, resolve });
  assert.deepEqual([only.successor, only.delivered, only.reject], ['session-C', true, true]);
  assert.equal(received[0][0], 'followup');
  assert.equal(received[0][1].source.kind, 'plugin:codex-conductor');
  assert.match(received[0][1].content[0].text, /原会话 session-A 交接前派出的任务已结束[\s\S]*background job bg-1 completed/);
  // 继任正在跑：放进下一步，不另开回合；混着别的输入时照转，但不拦前任这一回合。
  successor.status = 'running';
  const mixed = await forwardRetiredNotices({ agent: agentA, messages: [notice('bg-1'), { id: 'u', source: { kind: 'user' }, content: [] }], aliases, jobs, resolve });
  assert.deepEqual([mixed.reject, received.at(-1)[0]], [false, 'inject']);
  // 非 Codex 的后台任务、没有交接的会话：不管。
  assert.equal(await forwardRetiredNotices({ agent: agentA, messages: [notice('bg-2')], aliases, jobs, resolve }), undefined);
  delete links['session-B'];
  assert.equal(await forwardRetiredNotices({ agent: agentA, messages: [notice('bg-1')], aliases, jobs, resolve }), undefined, 'after a revert the notice stays with the original session');
});

test('a goal-loop session with running jobs is handed over at the idle edge; a new turn retries after two minutes, other failures after thirty', async (t) => {
  const { createAutoHandover, AUTO_HANDOVER_DEFAULTS, TURN_RETRY_COOLDOWN_MS, RETRY_COOLDOWN_MS } = await import('./handover.mjs');
  const root = dir(t);
  const aliases = createAliases(root);
  writeFileSync(aliases.file, '{"links":{}}');
  const goals = goalLoop();
  let clock = Date.parse('2026-11-18T03:34:46Z');
  const submitted = [];
  let checked = 0;
  const auto = createAutoHandover({ directory: root, settings: () => ({ ...AUTO_HANDOVER_DEFAULTS, mode: 'auto' }), aliases, now: () => clock, uptime: () => 3_600_000,
    runningJobs: async () => { checked++; return 1; }, submit: (request) => submitted.push(request), goals: () => goals, agentOf: () => agent });
  const agent = { id: 'session-4175cc7a', status: 'idle' };
  goals.byAgent.set(agent, { id: 'G', revision: 1, phase: 'active', activation: 'armed' });
  const big = { messages: 16800, threshold: 5000, suggest: true };
  await auto.observe(agent, big);
  assert.deepEqual([submitted.length, checked, goals.byAgent.get(agent).phase], [1, 0, 'paused'], 'running jobs no longer block the hand-over');
  auto.settled({ from: agent.id, requestedAt: submitted[0].requestedAt, status: 'refused', reason: 'turn_running' });
  const record = () => JSON.parse(readFileSync(path.join(root, 'auto-handover.json'), 'utf8')).sessions[agent.id];
  assert.equal(Date.parse(record().retryAfter) - clock, TURN_RETRY_COOLDOWN_MS);
  assert.equal(goals.byAgent.get(agent).phase, 'active', 'the paused goal is restored');
  clock += TURN_RETRY_COOLDOWN_MS + 1;
  await auto.observe(agent, big);
  auto.settled({ from: agent.id, requestedAt: submitted[1].requestedAt, status: 'refused', reason: 'successor_unavailable' });
  assert.equal(Date.parse(record().retryAfter) - clock, RETRY_COOLDOWN_MS);
});

test('a session last driven by LoopX hands its LoopX thread binding to the successor, starts it with /loopx and builds no native goal', async (t) => {
  const { loopxDriven } = await import('./handover.mjs');
  // 一份假的 LoopX 绑定表：线程 → 目标/代理，按 CLI 的三个子命令读写。
  const cli = (bound, { failBind } = {}) => {
    const calls = [];
    const loopx = async (args, cwd) => {
      calls.push([args[0], args[args.indexOf('--thread-id') + 1], cwd]);
      const id = args[args.indexOf('--thread-id') + 1];
      if (args[0] === 'resolve-agent-thread') return bound.has(id) ? { ok: true, status: 'bound', ...bound.get(id) } : { ok: true, status: 'missing' };
      if (args[0] === 'unbind-agent-thread') { bound.delete(id); return { ok: true, changed: true }; }
      if (failBind?.(id)) return { ok: false };
      bound.set(id, { goal_id: args[args.indexOf('--goal-id') + 1], agent_id: args[args.indexOf('--agent-id') + 1] });
      return { ok: true, changed: true };
    };
    return { loopx, calls };
  };
  const pair = { goal_id: 'goal-1', agent_id: 'agent-1' };
  const continuation = userEvent('continue', 2, 'loopx-continuation');
  assert.deepEqual([loopxDriven([userEvent('g', 1, 'goal'), continuation, userEvent('typed', 3)]), loopxDriven([continuation, userEvent('g', 3, 'goal')]), loopxDriven([])],
    [true, false, false]);

  // LoopX 续跑的会话：绑定挪走，首条消息是 /loopx，不重建原生目标（原来那个暂停着的目标也不重建）。
  const h = host(t);
  const a = h.agent('session-A');
  a.session.log.push(continuation);
  h.goalsByAgent.set(a, { id: 'G1', revision: 1, phase: 'paused', objective: '旧的原生目标' });
  const bound = new Map([['session-A', pair]]);
  const { loopx, calls } = cli(bound);
  const moved = await h.request({ sessionId: 'session-A' }, { loopx });
  assert.deepEqual([moved.status, moved.steps.loopx, moved.steps.successorGoal, moved.checks.goal], ['handed_over', 'moved', 'loopx', 'skipped:loopx']);
  assert.deepEqual([...bound], [[moved.to, pair]]);
  assert.deepEqual(calls.map((c) => c[2]), ['/work/p', '/work/p', '/work/p'], 'the CLI runs in the session directory');
  assert.match(h.prompts[0].content[0].text, /^\/loopx 这是会话交接后的续接.*goal goal-1，agent agent-1/);
  assert.doesNotMatch(h.prompts[0].content[0].text, /按交接单里的目标创建/);
  assert.equal(h.goalsByAgent.get(h.agents.get(moved.to)), undefined);
  assert.deepEqual(h.aliases.links()[moved.to].loopx, { goalId: 'goal-1', agentId: 'agent-1' });
  // 撤回：绑定挪回原会话。
  const reverted = await h.request({ revert: { from: 'session-A', to: moved.to } }, { loopx });
  assert.deepEqual([reverted.status, reverted.steps.loopx, [...bound]], ['reverted', 'restored', [['session-A', pair]]]);

  // 原生目标循环驱动的会话，即使有 LoopX 绑定也照旧：不调 CLI，重建原生目标。
  const native = host(t);
  const b = native.agent('session-B');
  b.session.log.push(continuation, userEvent('g', 3, 'goal'));
  native.goalsByAgent.set(b, { id: 'G1', revision: 1, phase: 'active', objective: '原生目标' });
  const untouched = cli(new Map([['session-B', pair]]));
  const plain = await native.request({ sessionId: 'session-B' }, { loopx: untouched.loopx });
  assert.deepEqual([plain.steps.loopx, plain.steps.successorGoal, untouched.calls.length], [undefined, 'created', 0]);
  assert.match(native.prompts[0].content[0].text, /^\[codex-conductor 交接\]/);

  // 没绑定、CLI 不可用、继任绑不上：交接照常进行并如实记录；绑不上时绑定还给原会话。
  for (const [name, runner, step, left] of [
    ['unbound', cli(new Map()).loopx, 'unbound', []],
    ['missing cli', async () => { throw new Error('loopx resolve-agent-thread: ENOENT'); }, 'failed:loopx resolve-agent-thread: ENOENT', null],
    ['bind refused', null, 'failed:loopx bind-agent-thread refused', [['session-C', pair]]],
  ]) {
    const x = host(t);
    const c = x.agent('session-C');
    c.session.log.push(continuation);
    const table = new Map([['session-C', pair]]);
    const result = await x.request({ sessionId: 'session-C' }, { loopx: runner ?? cli(table, { failBind: (id) => id !== 'session-C' }).loopx });
    assert.deepEqual([result.status, result.steps.loopx, result.steps.successorGoal], ['handed_over', step, 'none'], name);
    assert.match(x.prompts[0].content[0].text, /^\[codex-conductor 交接\]/, name);
    if (name === 'bind refused') assert.deepEqual([...table], left);
  }

  // 首条消息没送达而自动回滚：绑定也回到原会话。
  const offline = host(t, { prompt: async () => { throw new Error('offline'); } });
  offline.agent('session-D').session.log.push(continuation);
  const table = new Map([['session-D', pair]]);
  const rolled = await offline.request({ sessionId: 'session-D' }, { loopx: cli(table).loopx });
  assert.deepEqual([rolled.status, rolled.rollback.steps.loopx, [...table]], ['rolled_back', 'restored', [['session-D', pair]]]);
});

test('switching auto-continue off waits out a host settings transaction that is still running', async () => {
  const { autoContinueFromSettings, disableAutoContinue, mutateWhenFree } = await import('./handover.mjs');
  // 2026-11-22 的两次自动交接都在这里失败：建会话、放分组、改标题的配置事务还没结束。
  const modes = {};
  const settings = settingsService(modes, { busyFor: 2 });
  assert.deepEqual(await disableAutoContinue(autoContinueFromSettings(settings), 'session-A'), { autoContinue: 'disabled', previous: null });
  assert.deepEqual([settings.calls.length, modes], [3, { 'session-A': 'off' }]);
  // 一直忙就按次数放弃，其他错误不重试。
  const stuck = settingsService({}, { busyFor: 99 });
  await assert.rejects(mutateWhenFree(stuck, 'auto-continue', [], { attempts: 3, waitMs: 1 }), /cannot be nested/);
  assert.equal(stuck.calls.length, 3);
  const other = settingsService({}, { fail: 'busy' });
  await assert.rejects(mutateWhenFree(other, 'auto-continue', [], { attempts: 3, waitMs: 1 }), /busy/);
  assert.equal(other.calls.length, 1);
});

test('a session whose last 20 requests all carry a large context is flagged even with few messages', async (t) => {
  const { createHistoryTracker, autoHandoverStep, AUTO_HANDOVER_DEFAULTS } = await import('./handover.mjs');
  const root = dir(t);
  let floorLimit = 190_000;
  const tracker = createHistoryTracker({ directory: root, threshold: () => 2000, contextThreshold: () => floorLimit, writeEveryMs: 0 });
  const request = (input, cached) => ({ type: 'assistant/message', data: { usage: { inputTokens: input, cacheReadTokens: cached } } });
  const log = [];
  const agent = { id: 'session-A', session: { log } };
  for (let i = 0; i < 19; i++) log.push(request(5_000, 200_000 + i));
  // 不满 20 次请求不下结论。
  assert.deepEqual(tracker.observe(agent), { messages: 19, threshold: 2000, suggest: false, floor: undefined, contextThreshold: 190_000, contextFull: false });
  log.push(request(1_000, 195_000));
  assert.deepEqual(tracker.observe(agent), { messages: 20, threshold: 2000, suggest: true, floor: 196_000, contextThreshold: 190_000, contextFull: true });
  // 一次压缩把上下文降下来，窗口里就有了低点。
  log.push(request(2_000, 100_000));
  assert.equal(tracker.observe(agent).contextFull, false);
  tracker.flush();
  assert.equal(JSON.parse(readFileSync(path.join(root, 'history-status.json'), 'utf8')).sessions['session-A'].floor, 102_000);
  const sub = { id: 'session-S', session: { header: { origin: 'subagent' }, log: Array.from({ length: 20 }, () => request(1_000, 220_000)) } };
  assert.deepEqual(tracker.observe(sub), { messages: 20, threshold: 2000, suggest: false });
  floorLimit = 0;
  assert.deepEqual(tracker.observe(agent), { messages: 21, threshold: 2000, suggest: false });
  // 继任会话按消息数要从交接时起再涨满一个阈值；上下文地板触发不受这个限制。
  const now = Date.parse('2026-11-22T06:00:00Z');
  const base = { settings: { ...AUTO_HANDOVER_DEFAULTS, mode: 'auto' }, record: {}, messages: 800, threshold: 2000, suggest: true,
    idle: true, retired: false, link: { toMessages: 0 }, now, uptimeMs: 3_600_000 };
  assert.deepEqual(autoHandoverStep(base), { remind: false, act: null });
  assert.deepEqual(autoHandoverStep({ ...base, contextFull: true }), { remind: true, act: 'auto', origin: 'auto' });
});
