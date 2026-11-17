// 会话交接：后继会话继承前任会话的 Codex 任务归属。别名只由本机请求文件建立，不向模型开放。
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const validSessionId = (id) => typeof id === 'string' && id.length >= 1 && id.length <= 100 && !/[^A-Za-z0-9_-]/.test(id);

function writeTextAtomic(file, text) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, text);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export const writeJsonAtomic = (file, value) => writeTextAtomic(file, JSON.stringify(value, null, 2) + '\n');

// 交接请求的发起来源；外部直接写请求文件、没带来源时记为 file。
export const ORIGINS = ['panel', 'auto', 'confirm', 'tool', 'file'];

// 发布一份 handover-request.json；上一份还没被认领时拒绝，不覆盖。面板和自动交接共用。
export function submitHandoverRequest(directory, request) {
  const target = path.join(directory, 'handover-request.json');
  if (fs.existsSync(target)) throw Object.assign(new Error('a previous hand-over request is still pending'), { code: 'pending' });
  fs.mkdirSync(directory, { recursive: true });
  writeTextAtomic(target, JSON.stringify(request));
}

// handover-history.jsonl：每次交接、认领、撤回一行（不含交接单正文），只保留最近 200 行。
export function appendHandoverHistory(directory, entry, keep = 200) {
  const file = path.join(directory, 'handover-history.jsonl');
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  lines.push(JSON.stringify(entry));
  writeTextAtomic(file, lines.slice(-keep).join('\n') + '\n');
}

export function readHandoverHistory(directory, limit = 20) {
  try {
    return fs.readFileSync(path.join(directory, 'handover-history.jsonl'), 'utf8').split('\n').filter(Boolean).slice(-limit)
      .flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  } catch { return []; }
}

// 会话日志里的消息数和回合数（turn/start 个数）；交接时记下继任会话的基数，撤回时据此判断它是否已经开工。
export function logCounts(log) {
  let messages = 0, turns = 0;
  for (const event of Array.isArray(log) ? log : []) {
    if (MESSAGE_TYPES.has(event?.type)) messages++;
    else if (event?.type === 'turn/start') turns++;
  }
  return { messages, turns };
}

// handover.json：{ links: { "<后继>": { from: "<前任>", at, origin, requestedAt, toMessages, toTurns, ... } } }。每个前任最多一个后继，可成链 A→B→C。
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
    links: () => read(),
    link(from, to, extra = {}) {
      if (!file) throw new Error('no local state directory');
      if (!validSessionId(from) || !validSessionId(to) || from === to) throw new Error('invalid session ids');
      const links = read();
      if (links[to]) throw new Error(`${to} already took over ${links[to].from}`);
      const taken = successor(from, links);
      if (taken) throw new Error(`${from} was already handed over to ${taken}`);
      if (predecessors(from, links).includes(to)) throw new Error(`${to} is a predecessor of ${from}`);
      fs.mkdirSync(directory, { recursive: true });
      writeJsonAtomic(file, { links: { ...links, [to]: { from, at: new Date().toISOString(), ...extra } } });
    },
    // 交接完成后补记投递和自动续接的结果。
    annotate(to, fields) {
      const links = read();
      if (!links[to]) return;
      links[to] = { ...links[to], ...fields };
      writeJsonAtomic(file, { links });
    },
    unlink(from, to) {
      const links = read();
      if (links[to]?.from !== from) throw new Error(`${to} did not take over ${from}`);
      const removed = links[to];
      delete links[to];
      writeJsonAtomic(file, { links });
      return removed;
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
  if (input.origin !== undefined && !ORIGINS.includes(input.origin)) throw new Error(`origin must be one of ${ORIGINS.join(', ')}`);
  if (input.requestedAt !== undefined && (typeof input.requestedAt !== 'string' || input.requestedAt.length > 40 || !Number.isFinite(Date.parse(input.requestedAt)))) {
    throw new Error('requestedAt must be an ISO time');
  }
  const meta = { origin: input.origin ?? 'file', ...(input.requestedAt ? { requestedAt: input.requestedAt } : {}), force: input.force === true };
  return input.revert ? { revert: input.revert, ...meta } : {
    from: input.sessionId ?? input.adopt.from, to: input.adopt?.to, note: input.note ?? '', ...meta };
}

const firstLine = (value, size = 80) => String(value ?? '').split('\n')[0].trim().slice(0, size);

// 交接单只用插件和 runner 已有的记录机械生成，不经模型。
export function buildBrief({ from, to, at, cwd, goal, jobs, pending, since, note, origin = 'file', requestedAt = at, autoContinue }) {
  const running = jobs.filter((j) => (j.execution_status ?? j.status) === 'running');
  // 表里只放任务号（job_id）：续接、核验、验收都靠它。线程号只列给需要带 resume 返工的任务，免得被当成任务号。
  const rows = jobs.slice(0, 50).map((j) => `| ${j.job_id} | ${j.execution_status ?? j.status ?? '?'} | ${j.verification_status ?? '?'} | ` +
    `${j.review_status === 'needs_attention' ? '有标记' : '-'} | ${j.parent_job_id ?? '-'} | ${j.cwd ?? '-'} | ` +
    `${j.diff_status ?? '-'} | ${firstLine(j.context?.task).replace(/\|/g, '/')} |`);
  const threads = jobs.filter((j) => pending.needsChanges.includes(j.job_id) && j.thread_id);
  return [
    `# Codex 指挥交接单：${from} → ${to}`, '',
    `- 生成时间：${at}`, `- 发起来源：${origin}（请求时间 ${requestedAt}）`, `- 工作目录：${cwd ?? '（未知）'}`,
    ...(autoContinue === 'manual_required' ? [`- 请操作员在界面把原会话 ${from} 的“自动继续”开关关掉（插件无法替你关闭），免得它被自动续接继续推进。`] : []),
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

// 可选集成 dsh-client-auto-continue：autoContinue(sessionId) 返回 undefined（没装）或 { mode, setMode? }；
// 没有 setMode（该插件未提供可供其他插件调用的接口）时只能请操作员手动关。失败不影响交接。
export async function setAutoContinue(probe, sessionId, mode) {
  let state;
  try { state = await probe?.(sessionId); } catch (error) { return { autoContinue: `failed:${error?.message ?? error}` }; }
  if (!state) return { autoContinue: 'not_installed' };
  if (state.mode === mode) return { autoContinue: 'disabled' };
  if (typeof state.setMode !== 'function') return { autoContinue: 'manual_required', previous: state.mode };
  try {
    await state.setMode(mode);
    return { autoContinue: 'disabled', previous: state.mode };
  } catch (error) { return { autoContinue: `failed:${error?.message ?? error}` }; }
}

export async function handOver(ctx, { aliases, sessionJobs, pendingOf, since, directory, deliverWaitMs = 8_000,
  autoContinue, disableAutoContinue = true }, request) {
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
    const link = aliases.links()[to];
    if (link?.from !== from) return refuse('not_linked', { error: `${to} did not take over ${from}` });
    // 继任会话交接后已经开工（交接单那一回合不算）时，撤回会让两个会话并行推进同一件事；默认拒绝，force 才执行。
    let newTurns = 0, successorRunning = false;
    try {
      const agent = await agentOf(to);
      newTurns = Math.max(0, logCounts(agent.session?.log).turns - (link.toTurns ?? 0) - (link.delivered === false ? 0 : 1));
      successorRunning = agent.status === 'running';
    } catch {} // 继任会话已不存在：不会并行。
    if (newTurns > 0 || successorRunning) {
      if (!request.force) {
        return refuse('successor_active', { status: 'rejected', newTurns, successorRunning,
          message: `继任会话已有 ${newTurns} 个新回合${successorRunning ? '且正在运行' : ''}，撤回会造成两个会话并行；确需撤回请带 force: true。` });
      }
      result.warning = 'parallel_sessions';
    }
    aliases.unlink(from, to);
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
    // 交接时由插件关掉的自动续接，撤回时恢复成原来的模式。
    if (link.autoContinue === 'disabled' && link.autoContinuePrevious) {
      result.steps.autoContinue = (await setAutoContinue(autoContinue, from, link.autoContinuePrevious)).autoContinue.replace(/^disabled$/, 'restored');
    }
    result.sessions = [
      { sessionId: from, state: 'restored', goal: result.steps.predecessorGoal, note: '原会话恢复：可以继续派活、验收和续接。' },
      { sessionId: to, state: 'detached', goal: result.steps.successorGoal, newTurns,
        note: '继任会话不再接管原会话的任务，目标已暂停；它在交接后派出的任务仍归它。' + (result.warning ? '它已经开工，请决定保留哪一个会话，另一个停下。' : '') },
    ];
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
  // 记下继任会话此刻的消息数和回合数：撤回保护和自动交接的再次触发都以它为基数。
  const base = logCounts(agentB.session?.log);
  const { origin, requestedAt } = request;
  try { aliases.link(from, to, { origin, requestedAt, toMessages: base.messages, toTurns: base.turns }); }
  catch (error) { return refuse('alias_failed', { error: error.message }); }
  result.status = 'handed_over';
  result.steps.alias = 'linked';
  const { previous: autoContinuePrevious, ...autoContinueStep } = disableAutoContinue ? await setAutoContinue(autoContinue, from, 'off') : {};
  Object.assign(result.steps, autoContinueStep);
  const pending = pendingOf(jobs);
  Object.assign(result, { pending, running });
  const at = new Date().toISOString();
  const brief = buildBrief({ from, to, at, cwd: header.cwd, goal, jobs, pending, since, note, origin, requestedAt,
    autoContinue: result.steps.autoContinue });
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
  try {
    aliases.annotate(to, { delivered: result.steps.delivered !== 'failed',
      ...(result.steps.autoContinue ? { autoContinue: result.steps.autoContinue } : {}),
      ...(autoContinuePrevious ? { autoContinuePrevious } : {}) });
  } catch (error) { result.steps.linkNote = `failed: ${error.message}`; }
  return result;
}

export async function processHandoverRequest({ ctx, directory, ...deps }) {
  const claimed = path.join(directory, `handover-request.${randomUUID()}.processing.json`);
  try { fs.renameSync(path.join(directory, 'handover-request.json'), claimed); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  let requestedAt = new Date().toISOString(), origin = 'file', action = 'invalid';
  let result;
  try {
    const request = validateHandoverRequest(JSON.parse(fs.readFileSync(claimed, 'utf8').replace(/^﻿/, '')));
    ({ origin } = request);
    requestedAt = request.requestedAt ??= requestedAt;
    action = request.revert ? 'revert' : request.to ? 'adopt' : 'handover';
    result = await handOver(ctx, { ...deps, directory }, request);
  } catch (error) {
    result = { status: 'rejected', reason: 'invalid_request', error: String(error?.message ?? error) };
  }
  result = { requestedAt, origin, ...result, completedAt: new Date().toISOString() };
  try {
    appendHandoverHistory(directory, { at: result.completedAt, action, from: result.from ?? null, to: result.to ?? null, origin,
      status: result.status, ...(result.reason ? { reason: result.reason } : {}), ...(result.warning ? { warning: result.warning } : {}) });
  } catch {} // 历史只是旁证，写不进去不影响交接结果。
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

// 会话历史越长每步越慢；这里只标记“建议交接”，提醒、询问和自动交接由 createAutoHandover 按配置决定。
// 会话日志只追加，按日志数组累计，每次只数新增事件。
const MESSAGE_TYPES = new Set(['assistant/message', 'tool/result', 'user/message', 'system/message', 'developer/message']);
export function createHistoryTracker({ directory, threshold, now = Date.now, writeEveryMs = 30_000 }) {
  const counts = new WeakMap();
  const file = directory && path.join(directory, 'history-status.json');
  let sessions = {};
  try { sessions = JSON.parse(fs.readFileSync(file, 'utf8')).sessions ?? {}; } catch {}
  let written = 0;
  let dirty = false;
  let timer;
  const count = (log) => {
    if (!Array.isArray(log)) return undefined;
    let entry = counts.get(log);
    if (!entry || entry.scanned > log.length) entry = { scanned: 0, messages: 0 };
    for (let i = entry.scanned; i < log.length; i++) if (MESSAGE_TYPES.has(log[i]?.type)) entry.messages++;
    entry.scanned = log.length;
    counts.set(log, entry);
    return entry.messages;
  };
  // 供外部看门狗读取：只有会话 ID、消息数、是否建议交接、工作目录、阈值和时间。
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!file || !dirty) return;
    const old = now() - 7 * 86_400_000;
    for (const [id, value] of Object.entries(sessions)) if (!(Date.parse(value.at) >= old)) delete sessions[id];
    try {
      fs.mkdirSync(directory, { recursive: true });
      writeJsonAtomic(file, { updatedAt: new Date(now()).toISOString(), threshold: threshold(), sessions });
      written = now();
      dirty = false;
    } catch {}
  };
  return {
    observe(agent) {
      const messages = count(agent?.session?.log);
      if (messages === undefined || !validSessionId(agent?.id)) return undefined;
      const limit = threshold();
      const value = { messages, threshold: limit, suggest: limit > 0 && messages > limit };
      const previous = sessions[agent.id];
      const cwd = agent.session?.header?.cwd;
      if (previous?.messages !== messages || previous?.suggest !== value.suggest) {
        sessions[agent.id] = { messages, suggest: value.suggest, ...(typeof cwd === 'string' ? { cwd } : {}), at: new Date(now()).toISOString() };
        dirty = true;
      }
      if (now() - written >= writeEveryMs) flush();
      else if (dirty && !timer) { timer = setTimeout(flush, writeEveryMs - (now() - written)); timer.unref?.(); }
      return value;
    },
    snapshot: () => ({ threshold: threshold(), sessions: Object.entries(sessions).map(([sessionId, value]) => ({ sessionId, ...value })) }),
    flush,
  };
}

const HOUR = 3_600_000;
export const AUTO_HANDOVER_DEFAULTS = { mode: 'confirm', cooldownHours: 12, remindStepMessages: 2000, startupDelayMinutes: 10, disableAutoContinue: true };

// 纯判定：会话标了建议交接之后这一次要做什么。remind 是面板提醒；act 为 ask（confirm 模式）或 auto（auto 模式）。
// 名下是否还有运行中的 Codex 任务要起 runner 查，由调用方在 act 非空时最后再查。
export function autoHandoverStep({ settings, record = {}, messages, threshold, suggest, idle, retired, link, now, uptimeMs }) {
  const step = { remind: false, act: null };
  if (settings.mode === 'off' || !suggest || retired) return step;
  // 继任会话从交接时起再涨满一个阈值才算（自动交接出的新会话不会马上再触发）。
  if (link && messages - (link.toMessages ?? 0) <= threshold) return step;
  step.remind = record.remindedMessages === undefined || messages - record.remindedMessages >= settings.remindStepMessages;
  if (settings.mode === 'notify' || !idle) return step;
  // 拒绝、点了“知道了”或询问后没人理，都在冷却期内不再询问或自动交接。
  const quiet = Math.max(Date.parse(record.askedAt) || 0, Date.parse(record.declinedAt) || 0);
  if (now - quiet < settings.cooldownHours * HOUR) return step;
  if (settings.mode === 'auto' && (uptimeMs < settings.startupDelayMinutes * 60_000 ||
    (record.autoAt ?? []).some((at) => now - Date.parse(at) < 24 * HOUR))) return step;
  step.act = settings.mode === 'auto' ? 'auto' : 'ask';
  return step;
}

// auto-handover.json：{ sessions: { "<会话>": { remindedMessages, remindedAt, open, askedAt, askedMessages, declinedAt, autoAt[] } } }。
// 宿主没有给插件的提醒或提问通道，提醒和询问都只出现在面板的“会话交接”里；用户同意后才写交接请求。
export function createAutoHandover({ directory, settings, aliases, runningJobs, submit = (request) => submitHandoverRequest(directory, request),
  now = Date.now, uptime = () => process.uptime() * 1000, logger }) {
  const file = directory && path.join(directory, 'auto-handover.json');
  const read = () => {
    try {
      const sessions = JSON.parse(fs.readFileSync(file, 'utf8')).sessions;
      return sessions && typeof sessions === 'object' && !Array.isArray(sessions) ? sessions : {};
    } catch { return {}; }
  };
  const save = (id, record) => {
    const sessions = read();
    sessions[id] = record;
    fs.mkdirSync(directory, { recursive: true });
    writeJsonAtomic(file, { sessions });
  };
  const checking = new Set();
  const openPrompt = (record, at = now()) => record?.open === 'remind' ||
    (record?.open === 'ask' && at - Date.parse(record.askedAt) < settings().cooldownHours * HOUR);
  return {
    // value 是 history.observe(agent) 的结果；会话每次回到空闲时调用。
    async observe(agent, value) {
      const id = agent?.id;
      if (!file || !value || !validSessionId(id) || checking.has(id)) return undefined;
      const record = { ...read()[id] };
      const at = new Date(now()).toISOString();
      const step = autoHandoverStep({ settings: settings(), record, messages: value.messages, threshold: value.threshold, suggest: value.suggest,
        idle: agent.status === 'idle', retired: Boolean(aliases.successor(id)), link: aliases.links()[id], now: now(), uptimeMs: uptime() });
      let changed = false;
      if (step.remind) {
        Object.assign(record, { remindedMessages: value.messages, remindedAt: at, open: record.open === 'ask' && openPrompt(record) ? 'ask' : 'remind' });
        changed = true;
        logger?.info?.(`[codex-conductor] 会话 ${id} 已有 ${value.messages} 条消息，建议交接；见面板“会话交接”。`);
      }
      if (step.act) {
        checking.add(id);
        try {
          // 查任务期间会话可能又开始了新回合。
          if (await runningJobs(id) === 0 && agent.status === 'idle') {
            if (step.act === 'ask') Object.assign(record, { open: 'ask', askedAt: at, askedMessages: value.messages });
            else {
              submit({ sessionId: id, origin: 'auto', requestedAt: at });
              record.autoAt = [...(record.autoAt ?? []).filter((t) => now() - Date.parse(t) < 24 * HOUR), at];
              record.open = null;
              logger?.info?.(`[codex-conductor] 会话 ${id} 已有 ${value.messages} 条消息，已自动提交交接请求。`);
            }
            changed = true;
          }
        } catch (error) {
          logger?.warn?.(`[codex-conductor] 自动交接检查跳过 ${id}：${error?.message ?? error}`);
        } finally { checking.delete(id); }
      }
      if (changed) save(id, record);
      return step;
    },
    // 面板上的“交接 / 暂不交接（知道了）”。
    answer(id, accept) {
      const record = read()[id];
      if (!openPrompt(record)) throw Object.assign(new Error('no open hand-over prompt'), { code: 'none' });
      const at = new Date(now()).toISOString();
      if (accept) submit({ sessionId: id, origin: record.open === 'ask' ? 'confirm' : 'panel', requestedAt: at });
      else record.declinedAt = at;
      save(id, { ...record, open: null });
      return accept ? { submitted: true } : { declined: true };
    },
    snapshot(suggestions = []) {
      const sessions = read();
      const links = aliases.links();
      let result = null;
      try { result = JSON.parse(fs.readFileSync(path.join(directory, 'handover-result.json'), 'utf8')); } catch {}
      return { mode: settings().mode,
        suggestions: suggestions.filter((s) => s.suggest && !aliases.successor(s.sessionId)),
        prompts: Object.entries(sessions).filter(([id, r]) => openPrompt(r) && !aliases.successor(id))
          .map(([sessionId, r]) => ({ sessionId, kind: r.open, at: r.open === 'ask' ? r.askedAt : r.remindedAt, messages: r.open === 'ask' ? r.askedMessages : r.remindedMessages })),
        links: Object.entries(links).map(([to, l]) => ({ from: l.from, to, at: l.at, origin: l.origin ?? null, autoContinue: l.autoContinue ?? null })),
        result, recent: directory ? readHandoverHistory(directory, 10) : [] };
    },
  };
}
