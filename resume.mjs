import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function validSessionId(id) {
  return typeof id === 'string' && id.length >= 1 && id.length <= 100 && !/[^A-Za-z0-9_-]/.test(id);
}

function validateRequest(request) {
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

function validateSendRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      Object.hasOwn(request, 'sessions') || !validSessionId(request.sessionId) ||
      typeof request.message !== 'string' || !request.message.trim() || [...request.message].length > 4000 ||
      (Object.hasOwn(request, 'whenRunning') && request.whenRunning !== 'queue')) {
    throw new Error('invalid send request');
  }
  return { sessionId: request.sessionId, message: request.message, queue: request.whenRunning === 'queue' };
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

async function resumeSession(ctx, sessionId, message, send = false, queue = false) {
  let method = null;
  const skipped = (reason) => ({ sessionId, status: 'skipped', reason, ...(send ? {} : { method: null }) });
  try {
    const controller = ctx.get('sessionController');
    const query = ctx.get('sessionQuery');
    const agents = ctx.get('agents');
    const resolved = await controller.resolveAgent(sessionId);
    if (resolved.error) {
      if (!send && resolved.error.code === 'session/not-found') return skipped('not_found');
      throw resolved.error;
    }
    const { agent } = resolved;
    // queue: a running agent's followup lands in next-turn, the same path as the UI's Queue mode.
    if (agent.status === 'running' && !queue) return skipped('running');
    // Resolve first: the host closes a crashed, unterminated turn as interrupted.
    const { events } = await query.readSession(sessionId);
    if (agents.get(sessionId) !== agent) return skipped('session_changed');
    if (agent.status === 'running' && !queue) return skipped('running');
    if (!send) {
      const lastTurn = events.findLast((event) => event.type === 'turn/start' || event.type === 'turn/end');
      const ended = lastTurn?.type === 'turn/end' ? lastTurn.data?.reason?.kind : undefined;
      // After a restart another plugin may try to advance the disarmed goal; the host rejects that turn as "blocked"
      // before any step runs, so the session is still waiting to be resumed.
      if (ended !== 'interrupted' && ended !== 'blocked') return skipped('not_interrupted');
      const goals = ctx.get('goals');
      const goal = goals?.get(agent);
      if (goal && ['active', 'paused', 'blocked'].includes(goal.phase) &&
          (goal.phase !== 'active' || goal.activation === 'disarmed') && goal.roundsStarted < goal.maxGoalRounds) {
        method = 'goal';
        // The native goal driver submits the next round; a user prompt here would duplicate it.
        goals.resume(agent, { id: goal.id, revision: goal.revision });
        return { sessionId, status: 'resumed', reason: 'goal_resumed', method };
      }
      // A rejected turn alone says nothing was cut short, so it never justifies sending a prompt.
      if (ended === 'blocked') return resumePendingInbox(agent, sessionId);
      method = 'message';
    }
    const queued = agent.status === 'running';
    agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: message }], source: { kind: 'user' } });
    return send ? { sessionId, status: 'sent', reason: queued ? 'message_queued' : 'message_submitted' }
      : { sessionId, status: 'resumed', reason: 'message_submitted', method };
  } catch (error) {
    // Host errors may quote the submitted text; never publish them for the send entry.
    if (send) return { ...skipped('error'), error: 'Session message submission failed or required host interfaces are unavailable' };
    return { sessionId, status: 'skipped', reason: 'error', method, error: String(error?.message ?? error) };
  }
}

async function processRequest({ ctx, directory }, kind) {
  const send = kind === 'send';
  const claimed = path.join(directory, `${kind}-request.${randomUUID()}.processing.json`);
  try {
    fs.renameSync(path.join(directory, `${kind}-request.json`), claimed);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const requestedAt = new Date().toISOString();
  const result = send ? { requestedAt, sessionId: null, status: 'skipped', reason: 'invalid_request' }
    : { requestedAt, status: 'processed', sessions: [] };
  let request;
  try {
    const input = JSON.parse(fs.readFileSync(claimed, 'utf8').replace(/^\uFEFF/, ''));
    if (send && validSessionId(input?.sessionId)) result.sessionId = input.sessionId;
    request = send ? validateSendRequest(input) : validateRequest(input);
  } catch (error) {
    if (send) result.error = 'Invalid send request: supply one valid sessionId and a non-empty message of at most 4000 Unicode characters, without sessions; whenRunning may only be \"queue\"';
    else {
      result.status = 'rejected';
      result.error = String(error?.message ?? error);
    }
  }
  if (request) {
    if (send) Object.assign(result, await resumeSession(ctx, request.sessionId, request.message, true, request.queue));
    else for (const sessionId of request.sessions) {
      result.sessions.push(await resumeSession(ctx, sessionId, request.message));
    }
  }
  result.completedAt = new Date().toISOString();
  const temporary = path.join(directory, `${kind}-result.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(result, null, 2) + '\n');
    fs.renameSync(temporary, path.join(directory, `${kind}-result.json`));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
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

export function registerResumeRequests({ ctx, directory }) {
  let stopped = false;
  let pending = Promise.resolve();
  const warn = (error) => ctx.logger?.warn?.(`[codex-conductor] local request: ${error?.message ?? error}`);
  const check = () => {
    for (const kind of ['resume', 'send']) {
      pending = pending.then(() => stopped ? undefined : processRequest({ ctx, directory }, kind)).catch(warn);
    }
    return pending;
  };
  ctx.effect(() => {
    let watcher;
    try {
      fs.mkdirSync(directory, { recursive: true });
      watcher = fs.watch(directory, { persistent: false }, (_event, filename) => {
        if (filename == null || ['resume-request.json', 'send-request.json'].includes(filename.toString())) return check();
      });
      watcher.on('error', (error) => { warn(error); watcher.close(); });
    } catch (error) { warn(error); }
    void check();
    return () => { stopped = true; watcher?.close(); };
  });
  return check;
}

export function registerAutoWake({ ctx, enabled = true }) {
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
    [...agent.inbox.nextStep, ...agent.inbox.nextTurn].some(message => batch.notices.has(message.id));
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
        ctx.get?.('agents')?.get(agent.id) !== agent) return;
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
    else if (event.type === 'turn/end') forget(session.id);
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
