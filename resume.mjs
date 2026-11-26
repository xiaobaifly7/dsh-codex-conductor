import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

// Stable across module reloads; timeOrigin distinguishes reused PIDs.
const HOST_PROCESS = `${process.pid}:${performance.timeOrigin}`;
// 兜底或热重载续接读一个会话的原始日志最多等这么久，宿主没有只读尾部的接口。
const FALLBACK_READ_LIMIT_MS = 60_000;
const RELOAD_WINDOW_MS = 60_000;
const RECENT_ACTIVITY_MS = 600_000;

const lastTurnEvent = (events) => events?.findLast(event => event.type === 'turn/start' || event.type === 'turn/end');
const userStopped = (event) => event?.type === 'turn/end' && event.data?.reason?.kind === 'aborted' && event.data.reason.reason?.kind === 'user';
const turnKey = (event) => `${event.data?.turn}:${event.time}`;
// A restart and a user stop of a turn that is not a goal round both leave an active goal disarmed; only the stop is a
// decision to wait. The newer of the last user stop and the last goal resume or create decides.
const goalStoppedByUser = (events) => {
  for (let index = (events?.length ?? 0) - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'goal/change' && ['resume', 'create'].includes(event.data?.operation)) return false;
    if (userStopped(event)) return true;
  }
  return false;
};

function validSessionId(id) {
  return typeof id === 'string' && id.length >= 1 && id.length <= 100 && !/[^A-Za-z0-9_-]/.test(id);
}

export function validateRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      !Array.isArray(request.sessions) || request.sessions.length > 20) {
    throw new Error('sessions must be an array of at most 20 session IDs');
  }
  if (request.sessions.some((id) => !validSessionId(id))) {
    throw new Error('session IDs must match [A-Za-z0-9_-]{1,100}');
  }
  const message = request.message === undefined ? '继续' : request.message;
  if (typeof message !== 'string' || [...message].length > 2000) {
    throw new Error('message must be a string of at most 2000 Unicode characters');
  }
  return { sessions: [...new Set(request.sessions)], message };
}

export function validateSendRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      Object.hasOwn(request, 'sessions') || !validSessionId(request.sessionId) ||
      typeof request.message !== 'string' || !request.message.trim() || [...request.message].length > 4000 ||
      (Object.hasOwn(request, 'whenRunning') && request.whenRunning !== 'queue')) {
    throw new Error('invalid send request');
  }
  return { sessionId: request.sessionId, message: request.message, queue: request.whenRunning === 'queue' };
}

export function validateGoalRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || !validSessionId(request.sessionId) ||
      (request.objective === undefined && request.maxGoalRounds === undefined) ||
      (Object.hasOwn(request, 'objective') && (typeof request.objective !== 'string' || !request.objective.trim())) ||
      (Object.hasOwn(request, 'maxGoalRounds') && (!Number.isSafeInteger(request.maxGoalRounds) || request.maxGoalRounds < 1))) {
    throw new Error('invalid goal request');
  }
  const { sessionId, objective, maxGoalRounds } = request;
  return { sessionId, ...(objective === undefined ? {} : { objective }),
    ...(maxGoalRounds === undefined ? {} : { maxGoalRounds }) };
}

async function editGoal(ctx, { sessionId, ...changes }) {
  const result = (status, reason) => ({ sessionId, status, reason });
  try {
    const resolved = await ctx.get('sessionController').resolveAgent(sessionId);
    if (resolved.error?.code === 'session/not-found') return result('skipped', 'session_not_found');
    if (resolved.error) throw resolved.error;
    const { agent } = resolved;
    const goals = ctx.get('goals');
    const goal = goals.get(agent);
    if (!goal || goal.phase === 'complete') return result('skipped', 'no_active_goal');
    goals.edit(agent, { id: goal.id, revision: goal.revision }, changes);
    return result('edited', 'edited');
  } catch {
    return { ...result('skipped', 'error'), error: 'Goal edit failed or required host interfaces are unavailable' };
  }
}

function resumePendingInbox(agent, sessionId) {
  let method = null;
  try {
    const hasPending = agent.inbox?.hasPending;
    if (hasPending === undefined) throw new Error('agent.inbox.hasPending is unavailable');
    if (!hasPending) return { sessionId, status: 'skipped', reason: 'not_interrupted', method };
    method = 'inbox';
    // shortcut: wakeDriver is loop-specific; use a public wake-only API when the host provides one.
    agent.wakeDriver();
    return { sessionId, status: 'resumed', reason: 'pending_inbox_woken', method };
  } catch (error) {
    return { sessionId, status: 'skipped', reason: 'error', method, error: String(error?.message ?? error) };
  }
}

async function resumeSession(ctx, sessionId, message, { send = false, queue = false, automatic, reload, signal } = {}) {
  let method = null;
  const basis = {};
  const result = (status, reason, method = null) => ({ sessionId, status, reason,
    ...(send ? {} : { method }), ...(automatic ? { basis } : {}) });
  const skipped = (reason) => result('skipped', reason);
  try {
    if (signal?.aborted) return skipped('unloaded');
    const controller = ctx.get('sessionController');
    const query = ctx.get('sessionQuery');
    const agents = ctx.get('agents');
    const resolved = await controller.resolveAgent(sessionId);
    if (resolved.error) {
      if (!send && resolved.error.code === 'session/not-found') return skipped('not_found');
      throw resolved.error;
    }
    const { agent } = resolved;
    if (signal?.aborted) return skipped('unloaded');
    if (automatic) basis.agentStatus = agent.status;
    // An operator-named session whose goal is still active but disarmed (the user stopped a turn that was not a goal
    // round, so the round driver let go) only needs rearming: the driver queues the next round once the session is
    // idle, so this holds while it runs or after a completed turn, and no prompt is sent.
    if (!send && !automatic && !reload) {
      const goals = ctx.get('goals');
      const goal = goals?.get(agent);
      if (goal?.phase === 'active' && goal.activation === 'disarmed' && goal.roundsStarted < goal.maxGoalRounds) {
        method = 'goal';
        goals.resume(agent, { id: goal.id, revision: goal.revision });
        return result('resumed', 'goal_resumed', method);
      }
    }
    // queue: a running agent's followup lands in next-turn, the same path as the UI's Queue mode.
    if (agent.status === 'running' && !queue) return skipped('running');
    // Resolve first: the host closes a crashed, unterminated turn as interrupted.
    const events = (reload && agent.session?.log) || (await query.readSession(sessionId)).events;
    if (signal?.aborted) return skipped('unloaded');
    if (agents.get(sessionId) !== agent) return skipped('session_changed');
    if (automatic) basis.agentStatus = agent.status;
    if (agent.status === 'running' && !queue) return skipped('running');
    if (!send) {
      const lastTurn = lastTurnEvent(reload ? agent.session?.log ?? events : events);
      const ended = lastTurn?.type === 'turn/end' ? lastTurn.data?.reason?.kind : undefined;
      if (reload) {
        const reason = reload.skip();
        if (reason) return skipped(reason);
        if (userStopped(lastTurn)) return skipped('user_stopped');
        if (ended !== 'interrupted' || turnKey(lastTurn) !== reload.turn) return skipped('resumed_after_reload');
      }
      // After a restart another plugin may try to advance the disarmed goal; the host rejects that turn as "blocked"
      // before any step runs, so the session is still waiting to be resumed.
      if (!automatic && ended !== 'interrupted' && ended !== 'blocked') return skipped('not_interrupted');
      const goals = ctx.get('goals');
      const goal = goals?.get(agent);
      // A goal the user switched off stays off: only a cut-off turn is continued, by message.
      const goalHeld = Boolean(automatic && goal?.phase === 'active' && goal.activation === 'disarmed' && goalStoppedByUser(events));
      if (automatic) {
        Object.assign(basis, { lastTurn: automatic.lastTurn, loadedLastTurn: ended ?? 'none',
          cancelCause: automatic.cancelCause, shutdownPending: automatic.shutdownPending,
          goalPhase: goal?.phase ?? null, goalActivation: goal?.activation ?? null });
        if (automatic.lastTurn === 'aborted' && automatic.cancelCause === 'user') return skipped('user_stopped');
        if (goalHeld) basis.goalStoppedByUser = true;
        if (goal?.phase === 'paused' || goal?.phase === 'blocked') return skipped(`goal_${goal.phase}`);
        // An armed goal is already owned by the native round driver; never add a competing prompt.
        if (goal?.phase === 'active' && goal.activation === 'armed') return skipped('native_goal_driver');
        if (goal?.phase === 'active' && goal.roundsStarted >= goal.maxGoalRounds) return skipped('goal_round_limit');
        if ((goal?.phase !== 'active' || goalHeld) && automatic.lastTurn !== 'unterminated' && automatic.lastTurn !== 'error' &&
            !reload && !(automatic.shutdownPending && (automatic.lastTurn === 'interrupted' ||
              (automatic.lastTurn === 'aborted' && ['disposed', 'parent'].includes(automatic.cancelCause))))) {
          return skipped(['interrupted', 'aborted'].includes(automatic.lastTurn) ? 'interrupted_without_shutdown_marker' : 'not_interrupted');
        }
      }
      if (goal && !goalHeld && ['active', 'paused', 'blocked'].includes(goal.phase) &&
          (goal.phase !== 'active' || goal.activation === 'disarmed') && goal.roundsStarted < goal.maxGoalRounds) {
        method = 'goal';
        // The native goal driver submits the next round; a user prompt here would duplicate it.
        reload?.claim();
        goals.resume(agent, { id: goal.id, revision: goal.revision });
        return result('resumed', 'goal_resumed', method);
      }
      // A rejected turn alone says nothing was cut short, so it never justifies sending a prompt.
      if (!automatic && ended === 'blocked') return resumePendingInbox(agent, sessionId);
      method = 'message';
    }
    const queued = agent.status === 'running';
    reload?.claim();
    // via 标出这是插件代发的消息（续接、send-request），不当作用户回复。
    agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: message }], source: { kind: 'user', via: automatic || reload ? 'codex-conductor-auto-resume' : 'codex-conductor' } });
    return result(send ? 'sent' : 'resumed', queued ? 'message_queued' : 'message_submitted', method);
  } catch (error) {
    // Host errors may quote the submitted text; never publish them for the send entry.
    if (send) return { ...skipped('error'), error: 'Session message submission failed or required host interfaces are unavailable' };
    if (reload) return result('skipped', 'error', method);
    return { ...result('skipped', 'error', method), error: String(error?.message ?? error) };
  }
}

function writeJson(directory, name, value) {
  const temporary = path.join(directory, `${name}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(temporary, path.join(directory, `${name}.json`));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function readAutoState(directory) {
  try { return JSON.parse(fs.readFileSync(path.join(directory, 'autoresume-state.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function readRawSession(persistence, sessionId, signal) {
  const handle = await persistence.open(sessionId, 'read', { signal });
  try { return (await handle.read(0, undefined, { signal })).events; }
  finally { await handle.close(); }
}

async function processRequest({ ctx, directory }, kind) {
  const send = kind === 'send';
  const goal = kind === 'goal';
  const claimed = path.join(directory, `${kind}-request.${randomUUID()}.processing.json`);
  try {
    fs.renameSync(path.join(directory, `${kind}-request.json`), claimed);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const requestedAt = new Date().toISOString();
  const result = send || goal ? { requestedAt, sessionId: null, status: 'skipped', reason: 'invalid_request' }
    : { requestedAt, status: 'processed', sessions: [] };
  let request;
  try {
    const input = JSON.parse(fs.readFileSync(claimed, 'utf8').replace(/^\uFEFF/, ''));
    if ((send || goal) && validSessionId(input?.sessionId)) result.sessionId = input.sessionId;
    request = goal ? validateGoalRequest(input) : send ? validateSendRequest(input) : validateRequest(input);
  } catch (error) {
    if (goal) result.error = 'Invalid goal request: supply a valid sessionId and a non-empty objective and/or positive safe-integer maxGoalRounds';
    else if (send) result.error = 'Invalid send request: supply one valid sessionId and a non-empty message of at most 4000 Unicode characters, without sessions; whenRunning may only be \"queue\"';
    else {
      result.status = 'rejected';
      result.error = String(error?.message ?? error);
    }
  }
  if (request) {
    if (goal) Object.assign(result, await editGoal(ctx, request));
    else if (send) Object.assign(result, await resumeSession(ctx, request.sessionId, request.message, { send: true, queue: request.queue }));
    else for (const sessionId of request.sessions) {
      result.sessions.push(await resumeSession(ctx, sessionId, request.message));
    }
  }
  result.completedAt = new Date().toISOString();
  writeJson(directory, `${kind}-result`, result);
  // Keep the claimed file if publishing the result fails; never replay it automatically.
  fs.unlinkSync(claimed);
  return result;
}

export function processResumeRequest(options) {
  return processRequest(options, 'resume');
}

export function processSendRequest(options) {
  return processRequest(options, 'send');
}

export function processGoalRequest(options) {
  return processRequest(options, 'goal');
}

// delayed（兜底）：宿主启动 delaySeconds 秒后才扫，按会话此刻的实际状态重新判断，只补仍没被续上的会话。
export async function processAutoResume({ ctx, directory, autoResume, signal, delayed = false, retired = () => false, archived = () => false,
  hostStart = performance.timeOrigin, readLimitMs = FALLBACK_READ_LIMIT_MS }) {
  if (!autoResume.enabled || signal?.aborted) return;
  const readState = () => readAutoState(directory);
  const previous = readState();
  const continuing = previous?.hostProcess === HOST_PROCESS;
  // A scan cut short by a hot reload is finished by the next plugin instance in the same process.
  if (continuing && !previous.interrupted) return;
  const state = { hostProcess: HOST_PROCESS, resumed: continuing ? previous.resumed : [] };
  if (previous?.reload?.hostProcess === HOST_PROCESS) state.reload = previous.reload;
  // The previous process's shutdown list must outlive an interrupted scan; root shutdown reuses `pending`.
  const shutdownPending = continuing ? previous.previousPending : previous?.pending;
  if (shutdownPending) state.previousPending = shutdownPending;
  // Reserve the process before awaiting anything, including across overlapping hot reloads.
  writeJson(directory, 'autoresume-state', state);
  // The root shutdown snapshot writes the same file: re-read it and change only this scan's fields.
  const update = (change) => {
    const current = readState();
    if (current?.hostProcess !== HOST_PROCESS) return;
    change(current);
    writeJson(directory, 'autoresume-state', current);
  };
  // Marked synchronously on abort, so the instance loaded right after a reload already sees it.
  const interrupt = () => {
    try { update(current => { current.interrupted = true; }); }
    catch (error) { ctx.logger?.warn?.(`[codex-conductor] local request: ${error?.message ?? error}`); }
  };
  signal?.addEventListener('abort', interrupt, { once: true });
  const requestedAt = new Date().toISOString();
  const result = { requestedAt, status: 'processed', ...(delayed ? { trigger: 'fallback', delaySeconds: autoResume.delaySeconds } : {}), sessions: [] };
  const cutoff = Date.now() - autoResume.maxAgeHours * 3600_000;
  // 宿主启动之后开过的回合说明别的机制（auto-continue、目标循环、用户）已经续上了。
  const startedAfterBoot = (events) => events?.some((event) => event?.type === 'turn/start' && Number(event.time) >= hostStart);
  // If a reload arrived before the startup scan finished, let the reload path handle new turns.
  const checkNewTurns = delayed || (autoResume.reloadDelaySeconds > 0 &&
    (state.reload?.fallback || Object.keys(state.reload?.pending ?? {}).length > 0));
  try {
    const query = ctx.get('sessionQuery');
    const persistence = ctx.get('sessionPersistence');
    const records = await query.listSessions();
    for (const { header } of records) {
      if (signal?.aborted) { result.status = 'stopped'; break; }
      const sessionId = header.id;
      const skipped = (reason, basis) => ({ sessionId, status: 'skipped', reason, method: null, basis });
      let entry;
      try {
        if (state.resumed.includes(sessionId)) entry = skipped('already_resumed', { resumed: true });
        else if (autoResume.exclude.includes(sessionId)) entry = skipped('excluded', { excluded: true });
        else if (!sessionId.startsWith('session-')) entry = skipped('fork', { mainSession: false });
        else if (ctx.get('agents').get(sessionId)?.status === 'running') entry = skipped('running', { agentStatus: 'running' });
        else if (delayed && retired(sessionId)) entry = skipped('handed_over', { handedOver: true });
        else if (delayed && archived(sessionId)) entry = skipped('archived', { archived: true });
        else if (checkNewTurns && startedAfterBoot(ctx.get('agents').get(sessionId)?.session?.log)) entry = skipped('resumed_after_start', { live: true });
        else {
          // listSessions has no update time; stat avoids decompressing old JSONL logs.
          const { mtimeMs: updatedAt } = await fs.promises.stat(persistence.locate(header).path);
          if (updatedAt < cutoff) entry = skipped('too_old', { updatedAt, cutoff });
          else {
            // query.readSession also synthesizes interrupted endings, so inspect the raw read handle first.
            const readSignal = delayed ? AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(readLimitMs)]) : signal;
            let events;
            try { events = await readRawSession(persistence, sessionId, readSignal); }
            catch (error) {
              if (!delayed || signal?.aborted || !readSignal.aborted) throw error;
            }
            if (delayed && !events) {
              result.sessions.push({ ...skipped('read_timeout', { updatedAt, readLimitMs }) });
              continue;
            }
            if (checkNewTurns && startedAfterBoot(events)) {
              result.sessions.push(skipped('resumed_after_start', { updatedAt }));
              continue;
            }
            // 宿主启动时会往会话文件补写记录（session/end-seed 等），修改时间因此变新；按上次运行里最后一个事件的时间判断。
            // 11-26 重启后，6 小时前因服务商 502 停下的会话就因为这个被当成刚中断续上了。
            const lastActiveAt = events.reduce((latest, event) => {
              const time = Number(event?.time);
              return time < hostStart && time > latest ? time : latest;
            }, 0);
            if (lastActiveAt && lastActiveAt < cutoff) {
              result.sessions.push(skipped('too_old', { updatedAt, lastActiveAt, cutoff }));
              continue;
            }
            const lastTurn = lastTurnEvent(events);
            const automatic = { lastTurn: lastTurn?.type === 'turn/start' ? 'unterminated' : lastTurn?.data?.reason?.kind ?? 'none',
              cancelCause: lastTurn?.data?.reason?.reason?.kind ?? null,
              shutdownPending: shutdownPending?.includes(sessionId) ?? false };
            entry = await resumeSession(ctx, sessionId, autoResume.message, { automatic, signal });
          }
          entry.basis = { updatedAt, ...entry.basis };
        }
      } catch (error) {
        entry = { ...skipped('error', {}), error: String(error?.message ?? error) };
      }
      result.sessions.push(entry);
      // Recorded even after an abort, so the instance that finishes this scan never submits it again.
      if (entry.status === 'resumed') update(current => { current.resumed.push(sessionId); });
    }
    if (shutdownPending && !signal?.aborted) update(current => { delete current.previousPending; });
  } catch (error) {
    result.status = 'error';
    result.error = String(error?.message ?? error);
  }
  signal?.removeEventListener('abort', interrupt);
  // An aborted scan that is still unwinding must not overwrite the result of the instance that took over.
  if (signal?.aborted && !readState()?.interrupted) return result;
  result.completedAt = new Date().toISOString();
  writeJson(directory, 'autoresume-result', result);
  return result;
}

function updateReloadState(directory, change) {
  const state = readAutoState(directory) ?? {};
  const reload = state.reload?.hostProcess === HOST_PROCESS ? state.reload : { hostProcess: HOST_PROCESS, pending: {}, submitted: {} };
  change(reload, state);
  writeJson(directory, 'autoresume-state', { ...state, reload });
  return reload;
}

async function processReloadResume({ ctx, directory, autoResume, plan, signal, retired = () => false, archived = () => false }) {
  if (signal.aborted) return;
  const result = { requestedAt: new Date().toISOString(), status: 'processed', trigger: 'reload',
    delaySeconds: autoResume.reloadDelaySeconds, sessions: [] };
  const agents = ctx.get('agents');
  const persistence = ctx.get('sessionPersistence');
  const candidates = new Map(Object.entries(plan.pending));
  try {
    if (plan.fallback) {
      for (const { header } of await ctx.get('sessionQuery').listSessions(signal)) {
        if (validSessionId(header.id) && header.id.startsWith('session-') && !candidates.has(header.id)) {
          candidates.set(header.id, { at: plan.fallback.at, header });
        }
      }
    }
    for (const [sessionId, candidate] of candidates) {
      if (signal.aborted) return;
      const skipped = (reason) => ({ sessionId, status: 'skipped', reason, method: null });
      const skip = () => !validSessionId(sessionId) || !sessionId.startsWith('session-') ? 'fork'
        : autoResume.exclude.includes(sessionId) ? 'excluded'
          : retired(sessionId) ? 'handed_over' : archived(sessionId) ? 'archived' : null;
      let entry, readSignal;
      try {
        const reason = skip();
        if (reason) entry = skipped(reason);
        else if (agents.get(sessionId)?.status === 'running') entry = skipped('running');
        else {
          const from = candidate.header ? plan.fallback.from : candidate.at - RELOAD_WINDOW_MS;
          const liveLog = agents.get(sessionId)?.session?.log;
          if (candidate.header && !liveLog && (await fs.promises.stat(persistence.locate(candidate.header).path)).mtimeMs < from) continue;
          if (signal.aborted) return;
          readSignal = liveLog ? undefined : AbortSignal.any([signal, AbortSignal.timeout(FALLBACK_READ_LIMIT_MS)]);
          const events = liveLog ?? await readRawSession(persistence, sessionId, readSignal);
          if (signal.aborted) return;
          const end = lastTurnEvent(events);
          const start = events.findLast(event => event.type === 'turn/start');
          const newerTurn = start?.time > candidate.at || (candidate.header && start?.time === candidate.at);
          if (userStopped(end)) entry = skipped('user_stopped');
          else if (newerTurn || (candidate.turn !== undefined && end?.data?.turn !== candidate.turn)) {
            entry = skipped('resumed_after_reload');
          } else if (end?.type !== 'turn/end' || end.data?.reason?.kind !== 'interrupted') entry = skipped('not_interrupted');
          else if (!Number.isFinite(end.time) || end.time < from || end.time > candidate.at + RELOAD_WINDOW_MS ||
              (candidate.header && !(start?.time >= performance.timeOrigin))) {
            entry = skipped('interruption_outside_reload_window');
          } else {
            const turn = turnKey(end);
            if (plan.submitted[sessionId] === turn) entry = skipped('already_resumed');
            else entry = await resumeSession(ctx, sessionId, autoResume.message, {
              signal, automatic: { lastTurn: 'interrupted', cancelCause: null, shutdownPending: false },
              reload: { skip, turn, claim: () => {
                // Record before submission so another reload can never send the same turn twice.
                updateReloadState(directory, state => { state.submitted[sessionId] = turn; });
              } },
            });
          }
        }
      } catch (error) {
        entry = skipped(readSignal?.aborted ? 'read_timeout' : error?.code === 'ENOENT' || error?.code === 'session/not-found' ? 'not_found' : 'error');
      }
      if (signal.aborted) return;
      result.sessions.push(entry);
    }
  } catch {
    result.status = 'error';
  }
  if (signal.aborted) return;
  result.completedAt = new Date().toISOString();
  writeJson(directory, 'autoresume-result', result);
  if (result.status === 'processed') updateReloadState(directory, state => {
    state.pending = {};
    delete state.fallback;
  });
}

export function registerResumeRequests({ ctx, directory, autoResume, retired, archived, pluginFiber, previousLoad }) {
  let stopped = false;
  let pending = Promise.resolve();
  const controller = new AbortController();
  const warn = (error) => ctx.logger?.warn?.(`[codex-conductor] local request: ${error?.message ?? error}`);
  const reloadEnabled = autoResume?.enabled && autoResume.reloadDelaySeconds > 0;
  const rootFiber = autoResume?.enabled ? ctx.root.fiber : undefined;
  let snapshotTaken = false;
  const snapshotReload = () => {
    if (!reloadEnabled || snapshotTaken || rootFiber.state === 5) return;
    try {
      const at = Date.now();
      updateReloadState(directory, reload => {
        reload.unloadedAt = at;
        for (const agent of ctx.get('agents').list()) {
          if (agent.status !== 'running' || !validSessionId(agent.id) || !agent.id.startsWith('session-')) continue;
          const turn = lastTurnEvent(agent.session?.log)?.data?.turn;
          const prior = reload.pending[agent.id];
          if (!prior || (turn !== undefined && turn !== prior.turn)) reload.pending[agent.id] = { at, turn };
        }
      });
      snapshotTaken = true;
    } catch (error) { warn(error); }
  };
  if (autoResume?.enabled) {
    const agents = ctx.get('agents');
    ctx.on('internal/status', fiber => {
      if (stopped || fiber.state !== 5) return;
      if (fiber !== rootFiber) {
        if (reloadEnabled && fiber === pluginFiber) {
          snapshotReload();
          controller.abort();
        }
        return;
      }
      // Root unloading precedes agent cancellation; keep the shutdown list separate.
      controller.abort();
      try {
        let state = readAutoState(directory);
        if (state?.hostProcess !== HOST_PROCESS) state = { hostProcess: HOST_PROCESS, resumed: [] };
        state.pending = agents.list().filter(agent => agent.status === 'running').map(agent => agent.id);
        writeJson(directory, 'autoresume-state', state);
      } catch (error) { warn(error); }
    });
  }
  const check = () => {
    for (const kind of ['resume', 'send', 'goal']) {
      pending = pending.then(() => stopped ? undefined : processRequest({ ctx, directory }, kind)).catch(warn);
    }
    return pending;
  };
  ctx.effect(() => {
    const loadedAt = Date.now();
    let plan;
    let watcher;
    try {
      fs.mkdirSync(directory, { recursive: true });
      if (reloadEnabled) plan = updateReloadState(directory, (reload, state) => {
        // Upgrades from older plugins may only have the startup scan or loaded.json marker.
        const sameProcess = state.reload?.hostProcess === HOST_PROCESS || state.hostProcess === HOST_PROCESS ||
          (previousLoad?.pid === process.pid && previousLoad.at >= performance.timeOrigin && previousLoad.at <= loadedAt);
        if (sameProcess && !Number.isFinite(reload.unloadedAt)) {
          reload.fallback = { at: loadedAt, from: reload.fallback?.from ?? Math.max(performance.timeOrigin, loadedAt - RECENT_ACTIVITY_MS) };
        }
        delete reload.unloadedAt;
      });
    } catch (error) { warn(error); }
    try {
      watcher = fs.watch(directory, { persistent: false }, (_event, filename) => {
        if (filename == null || ['resume-request.json', 'send-request.json', 'goal-request.json'].includes(filename.toString())) return check();
      });
      watcher.on('error', (error) => { warn(error); watcher.close(); });
    } catch (error) { warn(error); }
    void check();
    let timer, reloadTimer;
    const cancelReady = autoResume?.enabled ? ctx.get('appReady').onReady(() => {
      if (!reloadTimer && plan && (plan.fallback || Object.keys(plan.pending).length)) {
        reloadTimer = setTimeout(() => {
          pending = pending.then(() => processReloadResume({ ctx, directory, autoResume, plan, signal: controller.signal,
            retired, archived })).catch(warn);
        }, Math.max(0, autoResume.reloadDelaySeconds * 1000 - (Date.now() - loadedAt)));
        reloadTimer.unref?.();
      }
      const delayed = autoResume.delaySeconds > 0;
      const run = () => {
        pending = pending.then(() => stopped ? undefined : processAutoResume({ ctx, directory, autoResume, signal: controller.signal,
          delayed, retired, archived })).catch(warn);
      };
      if (!delayed) return run();
      // 从宿主进程启动算起（插件热重载不重新计时）；每个宿主进程仍只扫一次。
      timer = setTimeout(run, Math.max(0, autoResume.delaySeconds * 1000 - (Date.now() - performance.timeOrigin)));
      timer.unref?.();
    }) : undefined;
    return () => {
      snapshotReload();
      stopped = true;
      controller.abort();
      cancelReady?.();
      clearTimeout(timer);
      clearTimeout(reloadTimer);
      watcher?.close();
    };
  });
  return check;
}

export function registerAutoWake({ ctx, enabled = true, retired = () => false, allowed = () => true }) {
  if (!enabled) return;
  const batches = new Map();
  const delays = [1000, 5000];
  let stopped = false;
  const warn = (message) => ctx.logger?.warn?.(`[codex-conductor] ${message}`);
  const forget = (id) => {
    clearTimeout(batches.get(id)?.timer);
    batches.delete(id);
  };
  const pendingNotices = (agent, batch) => agent.inbox?.hasPending &&
    [...agent.inbox.nextStep, ...agent.inbox.nextTurn].some(message => batch.notices.has(message.id) && allowed(agent, message));
  const schedule = (agent, batch) => {
    if (stopped || !batch.blocked || batch.timer || agent.status !== 'idle') return;
    if (ctx.get?.('agents')?.get(agent.id) !== agent || !pendingNotices(agent, batch)) {
      forget(agent.id);
      return;
    }
    if (batch.attempts >= delays.length) {
      if (!batch.exhausted) warn(`会话 ${agent.id} 自动唤醒已用尽（${delays.length}/${delays.length}），待处理通知仍留在 inbox。`);
      batch.exhausted = true;
      return;
    }
    batch.timer = setTimeout(() => {
      batch.timer = undefined;
      try {
        if (stopped || batches.get(agent.id) !== batch || !batch.blocked || agent.status !== 'idle') return;
        if (ctx.get?.('agents')?.get(agent.id) !== agent || !pendingNotices(agent, batch)) {
          forget(agent.id);
          return;
        }
        batch.attempts++;
        const result = resumePendingInbox(agent, agent.id);
        if (result.status === 'resumed') ctx.logger?.info?.(`[codex-conductor] 会话 ${agent.id} 自动唤醒 ${batch.attempts}/${delays.length}：处理已排队的任务通知。`);
        else if (result.error) warn(`会话 ${agent.id} 自动唤醒失败：${result.error}`);
        schedule(agent, batch);
      } catch (error) { warn(`自动唤醒检查失败：${error?.message ?? error}`); }
    }, delays[batch.attempts]);
    batch.timer.unref?.();
  };
  const listen = (name, handler) => ctx.on(name, (...args) => {
    if (stopped) return;
    try { handler(...args); } catch (error) { warn(`自动唤醒检查失败：${error?.message ?? error}`); }
  });
  // tool-jobs emits this only after inserting its notice; a settled job alone may have been awaited.
  listen('agent/inbox/inserted', ({ agent, message }) => {
    if (message.source?.kind !== 'tool-jobs' || message.source.form !== 'notice' ||
        ctx.get?.('agents')?.get(agent.id) !== agent || retired(agent.id) || !allowed(agent, message)) return;
    const text = message.content?.find(block => block.type === 'text')?.text;
    const id = /^background job (\S+)(?:\s|$)/.exec(text ?? '')?.[1];
    const job = id && ctx.get?.('jobs')?.list(agent.id).find(job => job.id === id && job.owner === agent.id &&
      job.kind === 'codex' && /^Codex [A-Za-z0-9][A-Za-z0-9_-]*(?: · |$)/.test(job.label ?? '') &&
      ['completed', 'failed', 'killed'].includes(job.status));
    if (!job) return;
    let batch = batches.get(agent.id);
    if (batch && (batch.agent !== agent || !pendingNotices(agent, batch))) {
      forget(agent.id);
      batch = undefined;
    }
    if (!batch) {
      batch = { agent, notices: new Set(), attempts: 0, blocked: false };
      batches.set(agent.id, batch);
    }
    batch.notices.add(message.id);
  });
  listen('session/event', (session, event) => {
    if (event.type !== 'turn/start' && event.type !== 'turn/end') return;
    const batch = batches.get(session.id);
    if (!batch || batch.agent.session !== session) return;
    clearTimeout(batch.timer);
    batch.timer = undefined;
    batch.blocked = event.type === 'turn/end' && event.data?.reason?.kind === 'blocked';
    if (batch.blocked) schedule(batch.agent, batch);
    // A normal ending with the notice still queued may be followed by a rejected turn; keep the batch for it.
    else if (event.type === 'turn/end' && !pendingNotices(batch.agent, batch)) forget(session.id);
  });
  // turn/end is appended while still running; kick() publishes idle only after releasing the driver.
  listen('agent/status', ({ agent, status }) => {
    const batch = batches.get(agent.id);
    if (status === 'idle' && batch?.agent === agent) schedule(agent, batch);
  });
  listen('agent/disposed', ({ agent }) => {
    if (batches.get(agent.id)?.agent === agent) forget(agent.id);
  });
  ctx.effect?.(() => () => {
    stopped = true;
    for (const id of batches.keys()) forget(id);
  });
}
