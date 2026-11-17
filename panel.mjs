import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
const { validatePanelSettings, writeBackedUpFile, queryWithTimeout } = await import(new URL(`./runtime.mjs${new URL(import.meta.url).search}`, import.meta.url));
const { validateRequest, validateSendRequest, validateGoalRequest } = await import(new URL(`./resume.mjs${new URL(import.meta.url).search}`, import.meta.url));
const { validateHandoverRequest, submitHandoverRequest } = await import(new URL(`./handover.mjs${new URL(import.meta.url).search}`, import.meta.url));
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export const PANEL_PATH = '/dsh-codex-conductor';
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const SELFTEST_LIMIT = 64 * 1024;
const PROMPT_BACKUPS = 10;
const ARTIFACTS = ['report', 'context', 'review', 'stderr', 'result', 'diff'];
// runner 拒绝回滚的原因：前者是当前状态不允许（409），其余按任务服务不可用处理（502）。文案不含英文，前端原样显示。
const ROLLBACK_REFUSED = {
  rollback_conflict: '这些文件在任务之后又被改过，不能自动回滚，没有改动任何文件。请查看改动记录后手动处理。',
  lock_busy: '这个任务目录正有其他任务在写，暂时不能回滚，没有改动任何文件。请等它结束后重试。',
  still_running: '任务还在运行，不能回滚。请等它结束或先取消，再重试。',
  no_diff: '这一单没有记录可回滚的改动，请刷新任务列表后查看。',
  already_rolled_back: '这一单的改动已经回滚过，请刷新任务列表后查看。',
};
const RUNNER_JOB_ID = /^\d{8}-\d{6}-[0-9a-f]{6}$/;
// 搜索词会作为 --owner 的值传给 runner，不接受以 - 开头的写法。
const SESSION_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,99}$/;
const SESSION_REQUESTS = { '/session/send': 'send', '/session/resume': 'resume', '/session/goal': 'goal' };
const BACKUP_NAME = /^(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d)-(\d{3}Z)\.[0-9a-f-]{36}\.bak$/;

// 只认 writeBackedUpFile 为这个文件生成的备份；名字里的时间戳可直接排序，返回从旧到新。
function promptBackups(file) {
  const prefix = path.basename(file) + '.';
  return readdirSync(path.dirname(file)).filter((name) => name.startsWith(prefix) && BACKUP_NAME.test(name.slice(prefix.length))).sort();
}

function selftestResult(body) {
  object(body, ['id', 'claim', 'result']);
  if (Buffer.byteLength(JSON.stringify(body)) > SELFTEST_LIMIT) throw bad('自检结果超过 64 KiB，请缩短后重试。', 413);
  const result = body.result;
  object(result, ['settingsRegistered', 'sections', 'status', 'taskCount', 'report', 'http', 'errors', 'userAgent', 'origin', 'timedOut']);
  object(result.sections, ['运行状态', '常用设置', '最近任务', '规划提示词']);
  object(result.status, ['version', 'model', 'effort', 'serviceTier']);
  object(result.report, ['opened', 'summary', 'criteria', 'firstCriterion', 'note']);
  const string = (v, max) => typeof v === 'string' && Array.from(v).length <= max;
  const boolean = (v) => typeof v === 'boolean';
  if (!string(body.id, 128) || !string(body.claim, 36) ||
      !boolean(result.settingsRegistered) || !boolean(result.timedOut) ||
      !['运行状态', '常用设置', '最近任务', '规划提示词'].every((key) => boolean(result.sections[key])) ||
      !['version', 'model', 'effort', 'serviceTier'].every((key) => result.status[key] === null || string(result.status[key], 256)) ||
      !Number.isSafeInteger(result.taskCount) || result.taskCount < 0 || result.taskCount > 20 ||
      !['opened', 'summary', 'criteria'].every((key) => boolean(result.report[key])) || !string(result.report.firstCriterion, 80) ||
      (result.report.note !== undefined && !string(result.report.note, 128)) ||
      !string(result.userAgent, 2048) || !string(result.origin, 2048) ||
      !Array.isArray(result.errors) || result.errors.length > 40 || !result.errors.every((v) => string(v, 1000)) ||
      !Array.isArray(result.http) || result.http.length > 100) throw bad('自检结果字段不正确，请重新触发自检。');
  for (const entry of result.http) {
    object(entry, ['path', 'status']);
    if (!string(entry.path, 1024) || !/^\/(?:status|settings|jobs|prompt|attention|output|selftest\/request)(?:\?|$)/.test(entry.path) ||
        !(entry.status === null || (Number.isInteger(entry.status) && entry.status >= 100 && entry.status <= 599))) {
      throw bad('自检接口记录不正确，请重新触发自检。');
    }
  }
  return result;
}

function readableError(error) {
  const message = String(error?.message ?? error);
  if (/ENOENT|not configured/.test(message)) return '需要的本地文件或保存位置尚未准备好，请在 DSH 中检查插件设置后重试。';
  if (/EACCES|EPERM|read.only/i.test(message)) return '没有权限保存本地文件，请检查文件是否可写、是否被其他程序占用，然后重试。';
  if (/active runner|pagination|bridge|WSL/i.test(message)) return '暂时无法确认 Codex 任务状态，请检查任务服务是否可用，刷新状态后再试。';
  if (/profile|runtime entry|plugins list|scalar|encoding|conductor config|YAML/i.test(message)) {
    return '无法读取或修改已保存的插件设置，请在 DSH 中检查配置文件的写法和插件位置后重试。';
  }
  if (!/[\u3400-\u9fff]/u.test(message)) return '这次操作没有完成，请刷新状态后重试；如果仍然失败，请检查 DSH 的错误记录。';
  return /请|重试|刷新|检查/.test(message) ? message : `${message}。请刷新状态后重试。`;
}

function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    throw bad('提交的内容不正确，请刷新页面后重新填写。');
  }
}

function jobId(value) {
  if (typeof value !== 'string' || !JOB_ID.test(value)) throw bad('任务编号不正确，请从任务列表重新打开。');
  return value;
}

function offset(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw bad('页码不正确，请重新打开任务报告。');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < (maximum ? 1 : 0) || (maximum && n > maximum)) throw bad('读取范围不正确，请重新打开任务报告。');
  return n;
}

function runnerResult(value, output = false) {
  if (output && (value?.error_kind === 'artifact_pending' || (value?.status === 'pending' && !value.error_kind && !value.error))) {
    return { ...value, status: 'pending', error_kind: 'artifact_pending', message: '这个任务还在运行，报告会在任务结束后生成。' };
  }
  if (value?.error || value?.error_kind || value?.status === 'failed') {
    throw bad(value?.error ?? value?.error_kind ?? '任务查询失败', 502);
  }
  return value;
}

export function panelSettings(cfg) {
  return Object.fromEntries(['model', 'effort', 'readOnlyEffort', 'serviceTier', 'plannerAnswers', 'lockTimeoutSeconds', 'maxStorageMb']
    .map((key) => [key, cfg[key]]).concat([['plannerReads', cfg.plannerReads ?? 'open'],
      ['plannerReadAllowCount', cfg.plannerReadAllow?.length ?? 0],
      ['gemini', cfg.gemini ? { model: cfg.gemini.model, effort: cfg.gemini.effort } : null],
      ...['timeoutSeconds', 'idleTimeoutSeconds', 'retries', 'maxRunningJobs'].map((key) => [key, cfg[key] ?? null]),
      ['autoResume', { enabled: cfg.autoResume?.enabled !== false }],
      ['roots', cfg.roots ?? []], ['allowHostAccess', cfg.allowHostAccess === true],
      ['defaultHostAccess', cfg.defaultHostAccess === true], ['unknownConfig', cfg.unknownConfig ?? []],
      ['toolPolicy', cfg.toolPolicy ?? 'denylist'], ['allowTools', [...(cfg.allowTools ?? [])]],
      ['plannerReadAllow', [...(cfg.plannerReadAllow ?? [])]],
      ...['maxSessionJobs', 'maxSessionTokens'].map((key) => [key, cfg[key] ?? null]), ['jobDiff', cfg.jobDiff === true],
      ['handoverSuggestMessages', cfg.handoverSuggestMessages ?? 5000], ['acceptanceWarnAbove', cfg.acceptanceWarnAbove ?? 8],
      ['continueFreshAboveTokens', cfg.continueFreshAboveTokens ?? 100000],
      ['closeoutGuard', cfg.closeoutGuard !== false],
      // 受护栏会话里出现过、白名单模式下不会放行的工具名；只读，不是设置项。
      ['seenTools', [...(cfg.seenTools ?? [])].sort()]]));
}

// No runner commands come from HTTP input; file names from HTTP are only matched against fixed directory listings.
export function createPanelApi({ cfg, conductor, runtime, plannerFile, plannerInjected = false, executorFile, geminiHistoryFile,
  history = () => null, handover = () => null, answerHandover, selftestDirectory = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'dsh-codex-conductor') }) {
  let saving = false;
  const selftests = new Map();
  const promptFile = (kind = 'planner') => {
    if (kind !== 'planner' && kind !== 'executor') throw bad('提示词类型不正确，请刷新面板后重试。');
    const file = kind === 'planner' ? plannerFile : executorFile;
    if (!file) throw bad(kind === 'planner' ? '规划提示词的保存位置尚未配置，请在 DSH 中设置保存位置后重试。'
      : '给 Codex 的固定要求在当前环境不可用，请在 DSH 中配置规划提示词的保存位置后重试。', 409);
    return file;
  };
  async function api(method, pathname, query = {}, body, signal) {
    signal?.throwIfAborted();
    const route = pathname.slice(PANEL_PATH.length);
    const known = { '/status': ['GET'], '/attention': ['GET'], '/settings': ['GET', 'POST'],
      '/settings/apply': ['POST'], '/settings/cancel': ['POST'], '/jobs': ['GET'], '/output': ['GET'],
      '/cancel': ['POST'], '/rollback': ['POST'], '/prompt': ['GET', 'POST'], '/prompt/backups': ['GET'], '/prompt/backup': ['GET'], '/reload': ['POST'],
      '/doctor': ['GET'], '/gemini': ['GET'], '/session/send': ['POST'], '/session/resume': ['POST'], '/session/goal': ['POST'],
      '/session/results': ['GET'], '/selftest/request': ['GET'], '/selftest/result': ['POST'],
      '/handover/request': ['POST'], '/handover/answer': ['POST'] };
    if (!pathname.startsWith(PANEL_PATH + '/') || !known[route]) throw bad('找不到这个功能，请刷新面板后重试。', 404);
    if (!known[route].includes(method)) throw bad('打开方式不正确，请使用面板上的按钮重试。', 405);
    const allowedQuery = { '/jobs': ['filter', 'offset', 'q'], '/output': ['job_id', 'offset', 'limit', 'artifact'],
      '/prompt': method === 'GET' ? ['kind'] : [], '/prompt/backups': ['kind'], '/prompt/backup': ['kind', 'name'] }[route] ?? [];
    object(query, allowedQuery);
    if (method === 'POST' && route !== '/settings' && route !== '/selftest/result') object(body, { '/prompt': ['text', 'kind'],
      '/cancel': ['job_id', 'confirm'], '/rollback': ['job_id', 'confirm', 'check'], '/settings/apply': ['changes', 'confirm'], '/session/send': ['sessionId', 'message', 'queue'],
      '/session/resume': ['sessions', 'message'], '/session/goal': ['sessionId', 'objective', 'maxGoalRounds'],
      '/handover/request': ['sessionId', 'note', 'revert', 'force'], '/handover/answer': ['sessionId', 'accept'] }[route] ?? []);
    if (route === '/selftest/request') {
      if (!selftestDirectory) return { request: null };
      const claim = randomUUID();
      const claimed = path.join(selftestDirectory, `panel-selftest-request.${claim}.processing.json`);
      try { renameSync(path.join(selftestDirectory, 'panel-selftest-request.json'), claimed); }
      catch (error) { if (error.code === 'ENOENT') return { request: null }; throw error; }
      if (statSync(claimed).size > 4096) throw bad('自检请求超过 4 KiB，请缩短后重试。', 413);
      let request;
      try { request = JSON.parse(readFileSync(claimed, 'utf8').replace(/^\uFEFF/, '')); }
      catch { throw bad('自检请求不是有效 JSON，请重新触发。'); }
      object(request, ['id']);
      if (request.id !== undefined && (typeof request.id !== 'string' || Array.from(request.id).length > 128)) {
        throw bad('自检请求编号必须是最多 128 字符的文字。');
      }
      const id = request.id ?? claim;
      selftests.set(claim, { id, claimed });
      return { request: { id, claim } };
    }
    if (route === '/selftest/result') {
      const result = selftestResult(body);
      const request = selftests.get(body.claim);
      if (!request || request.id !== body.id) throw bad('自检请求已失效，请重新触发。', 409);
      const temporary = path.join(selftestDirectory, `panel-selftest-result.${body.claim}.tmp`);
      try {
        writeFileSync(temporary, JSON.stringify({ id: request.id, version, pid: process.pid,
          receivedAt: new Date().toISOString(), ...result }, null, 2) + '\n', { flag: 'wx' });
        renameSync(temporary, path.join(selftestDirectory, 'panel-selftest-result.json'));
      } finally { rmSync(temporary, { force: true }); }
      selftests.delete(body.claim);
      unlinkSync(request.claimed);
      return { saved: true };
    }
    if (route === '/status') {
      return { runtime: await runtime.execute({ action: 'status' }, { signal, panel: true }), settings: panelSettings(cfg), history: history(), handover: handover() };
    }
    if (route === '/attention') {
      const now = Date.now() / 1000;
      const page = runnerResult(await conductor.list({ needs_attention: true, limit: 1, started_between: [now - 86400, now] }, signal));
      if (!Number.isSafeInteger(page?.total) || page.total < 0 || !Array.isArray(page.jobs) ||
          page.jobs.length !== Math.min(page.total, 1)) {
        throw bad('任务列表暂时不完整，请刷新状态后再试。', 502);
      }
      return { total: page.total };
    }
    if (route === '/settings' && method === 'GET') return panelSettings(cfg);
    if (['/settings', '/settings/apply', '/settings/cancel', '/reload'].includes(route)) {
      const changes = route === '/settings' ? body : route === '/settings/apply' ? body.changes : undefined;
      if (route === '/settings/apply' && body.confirm !== true) throw bad('请先确认立即生效，再提交设置。');
      if (route === '/settings' || route === '/settings/apply') {
        try { validatePanelSettings(changes, Boolean(cfg.gemini)); }
        catch (error) { throw bad(error.message); }
      }
      if (saving) throw bad('正在保存或请求重载，请稍等', 409);
      saving = true;
      try {
        if (route === '/settings/cancel') return runtime.cancelPending();
        const result = await runtime.execute({ action: 'reload', when: route === '/settings/apply' ? 'now' : 'idle' }, { panel: true }, changes);
        if (result.status === 'failed') throw Object.assign(bad(result.error ?? '重载失败', result.error_status ?? 500), { saved: result.saved === true });
        return changes ? { saved: result.saved === true, runtime: result } : result;
      } finally { saving = false; }
    }
    if (route === '/jobs') {
      const filter = query.filter ?? 'all';
      if (!['all', 'running', 'attention'].includes(filter)) throw bad('任务筛选不正确，请重新选择要查看的任务。');
      const q = query.q;
      // 任务编号精确查，否则当作会话 ID 按归属筛选；其余写法不传给 runner。
      const search = q === undefined ? {} : RUNNER_JOB_ID.test(q) ? { job_ids: [q] } : SESSION_ID.test(q) ? { owner: q } : null;
      if (!search) throw bad('搜索内容请填完整的任务编号或会话编号后重试。');
      const page = runnerResult(await conductor.list({ limit: 20, offset: offset(query.offset, 0), ...(filter === 'running' ? { status: 'running' } : {}),
        ...(filter === 'attention' ? { needs_attention: true } : {}), ...search }, signal));
      return { total: page.total, next_offset: page.next_offset, jobs: page.jobs.map((job) => {
        const counts = job.criteria_counts;
        return { job_id: job.job_id, started_at: job.started_at,
          status: job.status, execution_status: job.execution_status,
          title: Array.from(job.context?.task ?? '').slice(0, 60).join(''),
          needs_attention: ['needs_changes', 'invalid'].includes(job.verification_status) ||
            (job.verification_status === 'unreviewed' && job.review_status === 'needs_attention'),
          // 只转交 runner 实际给出的字段。
          ...(job.context?.owner != null ? { owner: job.context.owner } : {}),
          ...Object.fromEntries(['cwd', 'duration_s', 'error_kind', 'verification_status', 'phase', 'attempt', 'updated_at',
            'diff_status', 'diff_files', 'rolled_back_at', 'last_activity']
            .filter((key) => job[key] != null).map((key) => [key, job[key]])),
          ...(counts && typeof counts === 'object' ? { criteria_counts: { met: counts.met, not_met: counts.not_met, blocked: counts.blocked } } : {}) };
      }) };
    }
    if (route === '/output') {
      const id = jobId(query.job_id), start = offset(query.offset, 0);
      const artifact = query.artifact ?? 'report';
      if (!ARTIFACTS.includes(artifact)) throw bad('要查看的内容类型不正确，请重新打开任务报告。');
      const page = runnerResult(await conductor.output(id, { artifact,
        offset: start, limit: offset(query.limit, 8000, 20000) }, signal), true);
      if (artifact !== 'report' || start !== 0 || page.status === 'pending') return page;
      try {
        const parts = [];
        let offset = 0;
        for (;;) {
          signal?.throwIfAborted();
          const context = runnerResult(await conductor.output(id, { artifact: 'context', offset, limit: 8000 }, signal), true);
          if (context.status === 'pending') return page;
          parts.push(context.text);
          if (context.eof) {
            const acceptance = JSON.parse(parts.join('')).acceptance;
            return Array.isArray(acceptance) ? { ...page, acceptance } : page;
          }
          if (!(context.next_offset > offset)) return page;
          offset = context.next_offset;
        }
      } catch {
        signal?.throwIfAborted();
        return page;
      } // Optional context must not prevent reading the report.
    }
    if (route === '/cancel') {
      const id = jobId(body.job_id);
      if (body.confirm !== true) throw bad('请先确认取消这个任务');
      const result = await conductor.cancel(id);
      if (!['cancelled', 'completed', 'failed'].includes(result?.status) || result?.error_kind) {
        throw bad('取消尚未确认：请刷新任务列表，检查是否仍在运行；暂时不要重复启动任务。', 502);
      }
      return result;
    }
    if (route === '/rollback') {
      const id = jobId(body.job_id);
      if (body.confirm !== true) throw bad('请先确认回滚这一单的改动');
      if (body.check !== undefined && typeof body.check !== 'boolean') throw bad('提交的内容不正确，请刷新页面后重新操作。');
      const result = await conductor.rollback(id, { check: body.check === true });
      if (result?.status !== 'completed' || result.error_kind) {
        const refused = ROLLBACK_REFUSED[result?.error_kind];
        throw bad(refused ?? '暂时无法确认回滚结果，请检查任务服务是否可用，刷新任务列表确认后再试。', refused ? 409 : 502);
      }
      return { job_id: id, rolled_back: result.rolled_back === true, checked: result.checked === true, files: result.files ?? null };
    }
    if (route === '/doctor') {
      const value = runnerResult(await conductor.doctor(signal));
      return { ok: value?.ok === true, checks: (Array.isArray(value?.checks) ? value.checks : []).map((check) => ({
        name: String(check?.name ?? ''), ok: check?.ok === true, detail: check?.detail == null ? '' : String(check.detail) })) };
    }
    if (route === '/gemini') {
      let lines = [];
      try { if (geminiHistoryFile) lines = readFileSync(geminiHistoryFile, 'utf8').split('\n'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const entries = [];
      for (const line of lines.reverse()) {
        if (entries.length === 20) break;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        entries.push({ ...Object.fromEntries(['at', 'session', 'output', 'status', 'chars', 'attempts', 'error', 'draft_path', 'duration_s']
          .map((key) => [key, entry[key] ?? null])),
        // 较新的记录才有这两项。
        ...(entry.id != null ? { id: entry.id } : {}), ...(typeof entry.background === 'boolean' ? { background: entry.background } : {}) });
      }
      return { entries };
    }
    if (route === '/session/results') {
      const read = (name) => {
        try { return JSON.parse(readFileSync(path.join(selftestDirectory, `${name}-result.json`), 'utf8')); } catch { return null; }
      };
      return Object.fromEntries(['send', 'resume', 'goal', 'autoresume'].map((name) => [name, selftestDirectory ? read(name) : null]));
    }
    if (route === '/handover/request' || route === '/handover/answer') {
      if (!selftestDirectory) throw bad('当前环境没有本机请求目录，无法提交交接，请检查 DSH 的本地数据目录后重试。', 409);
      try {
        if (route === '/handover/answer') {
          if (!SESSION_ID.test(body.sessionId ?? '') || typeof body.accept !== 'boolean') throw bad('会话编号或选择不正确，请刷新面板后重试。');
          if (!answerHandover) throw bad('当前环境不能处理交接询问，请刷新面板后重试。', 409);
          return answerHandover(body.sessionId, body.accept);
        }
        // 面板发起的请求总是带来源和提交时刻；仍走 handover-request.json，由 handover.mjs 的目录监听认领执行。
        let request;
        try { request = validateHandoverRequest({ ...body, origin: 'panel', requestedAt: new Date().toISOString() }); }
        catch { throw bad('会话编号或备注填写不正确，请检查后重新提交。'); }
        const { revert, from, note, force, origin, requestedAt } = request;
        submitHandoverRequest(selftestDirectory, revert ? { revert, ...(force ? { force } : {}), origin, requestedAt }
          : { sessionId: from, ...(note ? { note } : {}), origin, requestedAt }); // 面板只在撤回时提供 force
        return { submitted: true };
      } catch (error) {
        if (error.code === 'pending') throw bad('上一份交接请求还没有处理完，请稍后查看交接结果，再重新提交。', 409);
        if (error.code === 'none') throw bad('这条交接提醒已经处理过或已过期，请刷新面板。', 409);
        throw error;
      }
    }
    if (SESSION_REQUESTS[route]) {
      // 只发布现有的本机请求文件，由 resume.mjs 的目录监听认领和执行；面板自身不直接操作会话。
      const kind = SESSION_REQUESTS[route];
      if (!selftestDirectory) throw bad('当前环境没有本机请求目录，无法提交会话操作，请检查 DSH 的本地数据目录后重试。', 409);
      let request;
      try {
        if (kind === 'send') {
          if (body.queue !== undefined && typeof body.queue !== 'boolean') throw new Error('queue must be a boolean');
          const { sessionId, message } = validateSendRequest({ sessionId: body.sessionId, message: body.message });
          request = { sessionId, message, ...(body.queue ? { whenRunning: 'queue' } : {}) };
        } else if (kind === 'resume') {
          request = validateRequest(body);
          if (!request.sessions.length) throw new Error('sessions must not be empty');
        } else request = validateGoalRequest(body);
      } catch { throw bad('会话编号、消息或目标填写不正确，请检查后重新提交。'); }
      const target = path.join(selftestDirectory, `${kind}-request.json`);
      if (existsSync(target)) throw bad('上一份同类请求还没有处理完，请稍后查看最近结果，再重新提交。', 409);
      const temporary = path.join(selftestDirectory, `${kind}-request.${randomUUID()}.tmp`);
      try {
        writeFileSync(temporary, JSON.stringify(request), { flag: 'wx' });
        renameSync(temporary, target);
      } finally { rmSync(temporary, { force: true }); }
      return { submitted: true };
    }
    const kind = method === 'GET' ? query.kind : body.kind;
    const file = promptFile(kind);
    if (route === '/prompt/backups') {
      return { backups: promptBackups(file).reverse().slice(0, PROMPT_BACKUPS).map((name) => ({ name,
        savedAt: name.slice(path.basename(file).length + 1).replace(BACKUP_NAME, '$1:$2:$3.$4'),
        size: statSync(path.join(path.dirname(file), name)).size })) };
    }
    if (route === '/prompt/backup') {
      // name 只和目录里实际列出的备份逐字比较，不参与路径解析。
      const name = promptBackups(file).find((entry) => entry === query.name);
      if (!name) throw bad('找不到这份备份，请重新打开备份列表后再试。', 404);
      return { text: readFileSync(path.join(path.dirname(file), name), 'utf8') };
    }
    if (method === 'GET') return { text: readFileSync(file, 'utf8'), ...(kind === 'executor' ? {} : { injected: plannerInjected === true }) };
    if (typeof body.text !== 'string') throw bad('提示词必须是文字，请重新填写后保存。');
    writeBackedUpFile(file, Buffer.from(body.text, 'utf8'));
    // 保留最近几份备份；清理失败不影响已完成的保存。
    try {
      for (const name of promptBackups(file).slice(0, -PROMPT_BACKUPS)) unlinkSync(path.join(path.dirname(file), name));
    } catch {}
    return { saved: true };
  }
  return (method, pathname, query, body) => method === 'GET' &&
    ['/status', '/jobs', '/attention', '/output'].includes(pathname.slice(PANEL_PATH.length))
    ? queryWithTimeout((signal) => api(method, pathname, query, body, signal), undefined, 15_000)
    : api(method, pathname, query, body);
}

export function registerPanel({ ctx, ...options }) {
  return ctx.inject?.(['webServer', 'settings'], (ctx) => registerReadyPanel({ ctx, ...options }));
}

function registerReadyPanel({ ctx, ...options }) {
  const web = ctx.get('webServer');
  if (!web?.register) return;
  ctx.get?.('jobs')?.attachController?.('codex-conductor-panel');
  const api = createPanelApi(options);
  const unregister = web.register({ kind: 'prefix', path: PANEL_PATH, async handler(req, res) {
    const send = (status, value) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(value));
    };
    try {
      const connection = ctx.get?.('connection');
      if (!connection?.requestRejection) throw bad('DSH 暂时无法校验登录，请刷新页面或重新登录后重试。', 503);
      const rejection = connection.requestRejection(req);
      if (rejection !== undefined) throw bad(rejection === 403
        ? '网页来源未通过校验，请从 DSH 自己的页面打开面板后重试。' : '请先登录 DeepSeek Harness 后重试。', rejection);
      const url = new URL(req.url, 'http://localhost');
      const query = {};
      for (const [key, value] of url.searchParams) {
        if (Object.hasOwn(query, key)) throw bad('提交的内容有重复，请刷新页面后重试。');
        Object.defineProperty(query, key, { value, enumerable: true });
      }
      let body;
      if (req.method === 'POST') {
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw bad('提交格式不正确，请刷新页面后重新操作。', 415);
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          const limit = url.pathname === PANEL_PATH + '/selftest/result' ? SELFTEST_LIMIT : 1024 * 1024;
          if (size > limit) throw bad(`提交的内容超过 ${limit === SELFTEST_LIMIT ? '64 KiB' : '1 MiB'}，请缩短内容后再保存。`, 413);
          chunks.push(chunk);
        }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw bad('提交内容的格式不正确，请刷新页面后重新操作。'); }
      }
      send(200, await api(req.method, url.pathname, query, body));
    } catch (error) {
      send(error.status ?? 500, { error: readableError(error), ...(error.saved ? { saved: true } : {}) });
    }
  } });
  return unregister;
}
