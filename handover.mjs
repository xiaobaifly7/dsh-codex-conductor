// 会话交接：后继会话继承前任会话的 Codex 任务归属。别名只由本机请求文件建立，不向模型开放。
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const validSessionId = (id) => typeof id === 'string' && id.length >= 1 && id.length <= 100 && !/[^A-Za-z0-9_-]/.test(id);

export function writeJsonAtomic(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

// handover.json：{ links: { "<后继>": { from: "<前任>", at } } }。每个前任最多一个后继，可成链 A→B→C。
// 每次读文件而不缓存：热重载后的新实例和请求处理看到的是同一份记录，文件很小。
export function createAliases(directory) {
  const file = directory && path.join(directory, 'handover.json');
  const read = () => {
    if (!file) return {};
    try {
      const links = JSON.parse(fs.readFileSync(file, 'utf8')).links;
      return links && typeof links === 'object' && !Array.isArray(links) ? links : {};
    } catch { return {}; }
  };
  const predecessors = (id, links = read()) => {
    const chain = [];
    for (let current = id; links[current] && validSessionId(links[current].from) && !chain.includes(links[current].from) &&
      links[current].from !== id;) chain.push(current = links[current].from);
    return chain;
  };
  const successor = (id, links = read()) => Object.keys(links).find((to) => links[to]?.from === id);
  return {
    file,
    predecessors: (id) => (validSessionId(id) ? predecessors(id) : []),
    owners: (id) => (validSessionId(id) ? [id, ...predecessors(id)] : []),
    successor: (id) => (validSessionId(id) ? successor(id) : undefined),
    link(from, to) {
      if (!file) throw new Error('no local state directory');
      if (!validSessionId(from) || !validSessionId(to) || from === to) throw new Error('invalid session ids');
      const links = read();
      if (links[to]) throw new Error(`${to} already took over ${links[to].from}`);
      const taken = successor(from, links);
      if (taken) throw new Error(`${from} was already handed over to ${taken}`);
      if (predecessors(from, links).includes(to)) throw new Error(`${to} is a predecessor of ${from}`);
      fs.mkdirSync(directory, { recursive: true });
      writeJsonAtomic(file, { links: { ...links, [to]: { from, at: new Date().toISOString() } } });
    },
    unlink(from, to) {
      const links = read();
      if (links[to]?.from !== from) throw new Error(`${to} did not take over ${from}`);
      delete links[to];
      writeJsonAtomic(file, { links });
    },
  };
}

// handover-request.json：{sessionId, note?, force?} 新建后继会话；{adopt: {from, to}, note?, force?} 接管已建好的会话；
// {revert: {from, to}} 撤销一次交接。
export function validateHandoverRequest(input) {
  const pair = (value) => value && typeof value === 'object' && !Array.isArray(value) &&
    validSessionId(value.from) && validSessionId(value.to) && value.from !== value.to;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('request must be an object');
  const modes = ['sessionId', 'adopt', 'revert'].filter((key) => input[key] !== undefined);
  if (modes.length !== 1) throw new Error('give exactly one of sessionId, adopt or revert');
  if (input.sessionId !== undefined && !validSessionId(input.sessionId)) throw new Error('sessionId must match [A-Za-z0-9_-]{1,100}');
  if ((input.adopt !== undefined && !pair(input.adopt)) || (input.revert !== undefined && !pair(input.revert))) {
    throw new Error('adopt and revert need two different valid session ids in from and to');
  }
  if (input.note !== undefined && (typeof input.note !== 'string' || [...input.note].length > 4000)) throw new Error('note must be a string of at most 4000 characters');
  if (input.force !== undefined && typeof input.force !== 'boolean') throw new Error('force must be a boolean');
  return input.revert ? { revert: input.revert } : {
    from: input.sessionId ?? input.adopt.from, to: input.adopt?.to, note: input.note ?? '', force: input.force === true };
}

const firstLine = (value, size = 80) => String(value ?? '').split('\n')[0].trim().slice(0, size);

// 交接单只用插件和 runner 已有的记录机械生成，不经模型。
export function buildBrief({ from, to, at, cwd, goal, jobs, pending, since, note }) {
  const running = jobs.filter((j) => (j.execution_status ?? j.status) === 'running');
  // 表里只放任务号（job_id）：续接、核验、验收都靠它。线程号只列给需要带 resume 返工的任务，免得被当成任务号。
  const rows = jobs.slice(0, 50).map((j) => `| ${j.job_id} | ${j.execution_status ?? j.status ?? '?'} | ${j.verification_status ?? '?'} | ` +
    `${j.review_status === 'needs_attention' ? '有标记' : '-'} | ${j.parent_job_id ?? '-'} | ${j.cwd ?? '-'} | ` +
    `${j.diff_status ?? '-'} | ${firstLine(j.context?.task).replace(/\|/g, '/')} |`);
  const threads = jobs.filter((j) => pending.needsChanges.includes(j.job_id) && j.thread_id);
  return [
    `# Codex 指挥交接单：${from} → ${to}`, '',
    `- 生成时间：${at}`, `- 工作目录：${cwd ?? '（未知）'}`,
    `- 会话目标：${goal ? `${firstLine(goal.objective, 2000)}（状态 ${goal.phase}，已用 ${goal.roundsStarted ?? '?'} / ${goal.maxGoalRounds ?? '?'} 轮）` : '（原会话没有目标）'}`,
    ...(note ? [`- 操作员备注：${note}`] : []), '',
    '## 待收尾',
    `- 报告有标记、尚未 codex_review：${pending.unreviewed.join('、') || '无'}`,
    `- 记了 needs_changes、还没有后续轮次：${pending.needsChanges.join('、') || '无'}`,
    `- 仍在运行：${running.map((j) => j.job_id).join('、') || '无'}（结束通知会发到原会话；用 codex_status 查询）`, '',
    `## 任务（收尾截止时间 ${new Date(since * 1000).toISOString()} 之后开始，共 ${jobs.length} 单${jobs.length > 50 ? '，只列最近 50 单' : ''}）`, '',
    '任务号（job_id）用于 codex_status、codex_output、codex_review、codex_verify、codex_continue 的 job_id 参数。', '',
    '| 任务号 job_id | 执行 | 验收 | 报告 | 续接自（任务号） | 目录 | diff | 任务首行 |', '|---|---|---|---|---|---|---|---|',
    ...rows, '',
    ...(threads.length ? ['## 返工用的线程号', '线程号（thread_id）不是任务号，只用于 codex_run 的 resume 参数；不要传给其他工具的 job_id。', '',
      ...threads.map((j) => `- 任务 ${j.job_id} 的线程号：${j.thread_id}`), ''] : []),
  ].join('\n');
}

const handoverMessage = (from, briefPath, brief) => `[codex-conductor 交接] 本会话接手会话 ${from} 的工作；原会话的目标已暂停，` +
  '它不能再派活或验收。下面是插件按记录生成的交接单' + (briefPath ? `（文件：${briefPath}）` : '') + '。\n' +
  '先调 codex_summary（session_id="current"）和 codex_jobs 看详情：本会话现在可以查看、验收、续接、核验和取消原会话的任务。' +
  '工具的 job_id 参数只填交接单里的任务号；线程号只用于 codex_run 的 resume。' +
  '收尾规则照旧：先给列出的待收尾任务做 codex_review 或返工，再派新任务。本会话若还没有目标，按交接单里的目标创建后继续推进。\n\n' + brief;

// 首条消息走 sessionController.prompt（与界面发送相同的路径）；它可能等到整轮结束才返回，8 秒内没回执就当作已投递。
async function deliver(controller, sessionId, text, waitMs) {
  try {
    const call = controller.prompt({ requestId: `handover-${randomUUID()}`, sessionId, mode: 'queue', content: [{ type: 'text', text }] },
      new AbortController().signal);
    call.catch(() => {});
    let timer;
    const outcome = await Promise.race([call.then(() => 'prompted', (error) => ({ error })),
      new Promise((resolve) => { timer = setTimeout(() => resolve('prompt_pending'), waitMs); })]);
    clearTimeout(timer);
    return typeof outcome === 'string' ? { delivered: outcome } : { delivered: 'failed', deliverError: String(outcome.error?.message ?? outcome.error) };
  } catch (error) {
    return { delivered: 'failed', deliverError: String(error?.message ?? error) };
  }
}

export async function handOver(ctx, { aliases, sessionJobs, pendingOf, since, directory, deliverWaitMs = 8_000 }, request) {
  const result = { status: 'refused', from: request.from ?? request.revert?.from, to: request.to ?? request.revert?.to ?? null, steps: {} };
  const refuse = (reason, extra = {}) => Object.assign(result, { reason, ...extra });
  const controller = ctx.get('sessionController');
  const goals = ctx.get('goals');
  const agentOf = async (id) => {
    const resolved = await controller.resolveAgent(id);
    if (resolved.error) throw Object.assign(new Error(resolved.error.message ?? 'session not found'), { code: resolved.error.code });
    return resolved.agent;
  };
  const ref = (goal) => ({ id: goal.id, revision: goal.revision });
  if (request.revert) {
    const { from, to } = request.revert;
    try { aliases.unlink(from, to); } catch (error) { return refuse('not_linked', { error: error.message }); }
    result.status = 'reverted';
    result.steps.alias = 'removed';
    // 回到原会话：暂停后继的目标、恢复原会话被暂停的目标；后继交接后派出的任务仍归后继。
    for (const [id, key, want] of [[to, 'successorGoal', 'pause'], [from, 'predecessorGoal', 'resume']]) {
      try {
        const agent = await agentOf(id);
        const goal = goals?.get(agent);
        if (want === 'pause' && goal?.phase === 'active') { goals.pause(agent, ref(goal)); result.steps[key] = 'paused'; }
        else if (want === 'resume' && goal?.phase === 'paused') { goals.resume(agent, ref(goal)); result.steps[key] = 'resumed'; }
        else result.steps[key] = goal ? `unchanged_${goal.phase}` : 'none';
      } catch (error) { result.steps[key] = `failed: ${error.message}`; }
    }
    return result;
  }
  const { from, note, force } = request;
  let agentA;
  try { agentA = await agentOf(from); } catch (error) { return refuse(error.code === 'session/not-found' ? 'session_not_found' : 'session_unavailable', { error: error.message }); }
  const taken = aliases.successor(from);
  if (taken) return refuse('already_handed_over', { successor: taken });
  if (!force && agentA.status === 'running') return refuse('turn_running');
  let jobs;
  try { jobs = await sessionJobs(from); } catch (error) { return refuse('jobs_unreadable', { error: String(error?.message ?? error) }); }
  const running = jobs.filter((j) => (j.execution_status ?? j.status) === 'running').map((j) => j.job_id);
  if (!force && running.length) return refuse('jobs_running', { running });
  const goal = goals?.get(agentA);
  const header = agentA.session?.header ?? {};
  let to = request.to;
  let agentB;
  try {
    if (!to) {
      // 与界面“新对话”相同的入口：会话归宿主所有，插件重载不会把它拆掉。
      const created = await controller.create({ ...(header.cwd ? { cwd: header.cwd } : {}), ...(header.agentPreset ? { agentPreset: header.agentPreset } : {}) });
      to = created?.sessionId;
      if (!validSessionId(to)) throw new Error('sessionController.create returned no session id');
      result.steps.session = 'created';
    } else result.steps.session = 'adopted';
    result.to = to;
    agentB = await agentOf(to);
  } catch (error) { return refuse('successor_unavailable', { error: String(error?.message ?? error) }); }
  if (request.to && !force && agentB.status === 'running') return refuse('successor_turn_running');
  try { aliases.link(from, to); } catch (error) { return refuse('alias_failed', { error: error.message }); }
  result.status = 'handed_over';
  result.steps.alias = 'linked';
  const pending = pendingOf(jobs);
  Object.assign(result, { pending, running });
  const at = new Date().toISOString();
  const brief = buildBrief({ from, to, at, cwd: header.cwd, goal, jobs, pending, since, note });
  try {
    const dir = path.join(directory, 'handovers');
    fs.mkdirSync(dir, { recursive: true });
    result.briefPath = path.join(dir, `${at.replace(/[:.]/g, '-')}-${from}-to-${to}.md`);
    fs.writeFileSync(result.briefPath, brief);
  } catch (error) { result.steps.brief = `failed: ${error.message}`; delete result.briefPath; }
  // 先停原会话的目标，再让新会话开工，避免两边同时推进。
  if (goal?.phase === 'active') {
    try { goals.pause(agentA, ref(goals.get(agentA))); result.steps.predecessorGoal = 'paused'; }
    catch (error) { result.steps.predecessorGoal = `failed: ${error.message}`; }
  } else result.steps.predecessorGoal = goal ? `unchanged_${goal.phase}` : 'none';
  Object.assign(result.steps, await deliver(controller, to, handoverMessage(from, result.briefPath, brief), deliverWaitMs));
  if (goal && goal.phase !== 'complete' && typeof goal.objective === 'string') {
    try {
      const existing = goals.get(agentB);
      if (existing && existing.phase !== 'complete') result.steps.successorGoal = 'exists';
      else {
        goals.create(agentB, { objective: goal.objective,
          ...(Number.isSafeInteger(goal.maxGoalRounds) ? { maxGoalRounds: Math.max(1, goal.maxGoalRounds - (goal.roundsStarted ?? 0)) } : {}) });
        result.steps.successorGoal = 'created';
      }
    } catch (error) { result.steps.successorGoal = `failed: ${error.message}`; }
  } else result.steps.successorGoal = 'none';
  return result;
}

export async function processHandoverRequest({ ctx, directory, ...deps }) {
  const claimed = path.join(directory, `handover-request.${randomUUID()}.processing.json`);
  try { fs.renameSync(path.join(directory, 'handover-request.json'), claimed); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const requestedAt = new Date().toISOString();
  let result;
  try {
    const request = validateHandoverRequest(JSON.parse(fs.readFileSync(claimed, 'utf8').replace(/^﻿/, '')));
    result = await handOver(ctx, { ...deps, directory }, request);
  } catch (error) {
    result = { status: 'rejected', reason: 'invalid_request', error: String(error?.message ?? error) };
  }
  result = { requestedAt, ...result, completedAt: new Date().toISOString() };
  writeJsonAtomic(path.join(directory, 'handover-result.json'), result);
  // 结果写不出来时保留已认领的请求文件，不自动重放。
  fs.unlinkSync(claimed);
  return result;
}

export function registerHandoverRequests({ ctx, directory, ...deps }) {
  let pending = Promise.resolve();
  let stopped = false;
  const warn = (error) => ctx.logger?.warn?.(`[codex-conductor] handover request: ${error?.message ?? error}`);
  const check = () => {
    pending = pending.then(() => stopped ? undefined : processHandoverRequest({ ctx, directory, ...deps })).catch(warn);
    return pending;
  };
  ctx.effect(() => {
    let watcher;
    try {
      fs.mkdirSync(directory, { recursive: true });
      watcher = fs.watch(directory, { persistent: false }, (_event, filename) => {
        if (filename == null || filename.toString() === 'handover-request.json') return check();
      });
      watcher.on('error', (error) => { warn(error); watcher.close(); });
    } catch (error) { warn(error); }
    void check();
    return () => { stopped = true; watcher?.close(); };
  });
  return check;
}
