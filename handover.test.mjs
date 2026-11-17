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
  assert.deepEqual(result.steps, { session: 'created', alias: 'linked', predecessorGoal: 'paused', delivered: 'prompted', successorGoal: 'created' });
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
