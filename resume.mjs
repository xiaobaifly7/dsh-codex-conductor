import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function validateRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      !Array.isArray(request.sessions) || request.sessions.length > 20) {
    throw new Error('sessions must be an array of at most 20 session IDs');
  }
  if (request.sessions.some((id) => typeof id !== 'string' || id.length < 1 || id.length > 100 ||
      /[^A-Za-z0-9_-]/.test(id))) {
    throw new Error('session IDs must match [A-Za-z0-9_-]{1,100}');
  }
  const message = request.message === undefined ? '继续' : request.message;
  if (typeof message !== 'string' || [...message].length > 2000) {
    throw new Error('message must be a string of at most 2000 Unicode characters');
  }
  return { sessions: [...new Set(request.sessions)], message };
}

async function resumeSession(ctx, sessionId, message) {
  let method = null;
  const skipped = (reason) => ({ sessionId, status: 'skipped', reason, method: null });
  try {
    const controller = ctx.get('sessionController');
    const query = ctx.get('sessionQuery');
    const agents = ctx.get('agents');
    const resolved = await controller.resolveAgent(sessionId);
    if (resolved.error) {
      if (resolved.error.code === 'session/not-found') return skipped('not_found');
      throw resolved.error;
    }
    const { agent } = resolved;
    if (agent.status === 'running') return skipped('running');
    // Resolve first: the host closes a crashed, unterminated turn as interrupted.
    const { events } = await query.readSession(sessionId);
    if (agents.get(sessionId) !== agent) return skipped('session_changed');
    if (agent.status === 'running') return skipped('running');
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
    if (ended === 'blocked') return skipped('not_interrupted');
    method = 'message';
    agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: message }], source: { kind: 'user' } });
    return { sessionId, status: 'resumed', reason: 'message_submitted', method };
  } catch (error) {
    return { sessionId, status: 'skipped', reason: 'error', method, error: String(error?.message ?? error) };
  }
}

export async function processResumeRequest({ ctx, directory }) {
  const claimed = path.join(directory, `resume-request.${randomUUID()}.processing.json`);
  try {
    fs.renameSync(path.join(directory, 'resume-request.json'), claimed);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const result = { requestedAt: new Date().toISOString(), status: 'processed', sessions: [] };
  let request;
  try {
    request = validateRequest(JSON.parse(fs.readFileSync(claimed, 'utf8').replace(/^\uFEFF/, '')));
  } catch (error) {
    result.status = 'rejected';
    result.error = String(error?.message ?? error);
  }
  if (request) for (const sessionId of request.sessions) {
    result.sessions.push(await resumeSession(ctx, sessionId, request.message));
  }
  result.completedAt = new Date().toISOString();
  const temporary = path.join(directory, `resume-result.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(result, null, 2) + '\n');
    fs.renameSync(temporary, path.join(directory, 'resume-result.json'));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  // Keep the claimed file if publishing the result fails; never replay it automatically.
  fs.unlinkSync(claimed);
  return result;
}

export function registerResumeRequests({ ctx, directory }) {
  let stopped = false;
  let pending = Promise.resolve();
  const warn = (error) => ctx.logger?.warn?.(`[codex-conductor] resume request: ${error?.message ?? error}`);
  const check = () => {
    pending = pending.then(() => stopped ? undefined : processResumeRequest({ ctx, directory })).catch(warn);
    return pending;
  };
  ctx.effect(() => {
    let watcher;
    try {
      fs.mkdirSync(directory, { recursive: true });
      watcher = fs.watch(directory, { persistent: false }, (_event, filename) => {
        if (filename == null || filename.toString() === 'resume-request.json') return check();
      });
      watcher.on('error', (error) => { warn(error); watcher.close(); });
    } catch (error) { warn(error); }
    void check();
    return () => { stopped = true; watcher?.close(); };
  });
  return check;
}
