import { readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
const { validatePanelSettings, writeBackedUpFile, queryWithTimeout } = await import(new URL(`./runtime.mjs${new URL(import.meta.url).search}`, import.meta.url));
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export const PANEL_PATH = '/dsh-codex-conductor';
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const SELFTEST_LIMIT = 64 * 1024;

function selftestResult(body) {
  object(body, ['id', 'claim', 'result']);
  if (Buffer.byteLength(JSON.stringify(body)) > SELFTEST_LIMIT) throw bad('自检结果超过 64 KiB，请缩短后重试。', 413);
  const result = body.result;
  object(result, ['settingsRegistered', 'sections', 'status', 'taskCount', 'report', 'http', 'errors', 'userAgent', 'origin', 'timedOut']);
  object(result.sections, ['运行状态', '常用设置', '最近任务', '规划提示词']);
  object(result.status, ['version', 'model', 'effort', 'serviceTier']);
  object(result.report, ['opened', 'summary', 'criteria', 'firstCriterion']);
  const string = (v, max) => typeof v === 'string' && Array.from(v).length <= max;
  const boolean = (v) => typeof v === 'boolean';
  if (!string(body.id, 128) || !string(body.claim, 36) ||
      !boolean(result.settingsRegistered) || !boolean(result.timedOut) ||
      !['运行状态', '常用设置', '最近任务', '规划提示词'].every((key) => boolean(result.sections[key])) ||
      !['version', 'model', 'effort', 'serviceTier'].every((key) => result.status[key] === null || string(result.status[key], 256)) ||
      !Number.isSafeInteger(result.taskCount) || result.taskCount < 0 || result.taskCount > 20 ||
      !['opened', 'summary', 'criteria'].every((key) => boolean(result.report[key])) || !string(result.report.firstCriterion, 80) ||
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

function runnerResult(value) {
  if (value?.error || value?.error_kind || value?.status === 'failed') {
    throw bad(value?.error ?? value?.error_kind ?? '任务查询失败', 502);
  }
  return value;
}

export function panelSettings(cfg) {
  return Object.fromEntries(['model', 'effort', 'readOnlyEffort', 'serviceTier', 'plannerAnswers', 'lockTimeoutSeconds', 'maxStorageMb']
    .map((key) => [key, cfg[key]]).concat([['plannerReads', cfg.plannerReads ?? 'open'],
      ['plannerReadAllowCount', cfg.plannerReadAllow?.length ?? 0],
      ['gemini', cfg.gemini ? { model: cfg.gemini.model, effort: cfg.gemini.effort } : null]]));
}

// No paths or runner commands come from HTTP input.
export function createPanelApi({ cfg, conductor, runtime, plannerFile,
  selftestDirectory = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'dsh-codex-conductor') }) {
  let saving = false;
  const selftests = new Map();
  async function api(method, pathname, query = {}, body, signal) {
    signal?.throwIfAborted();
    const route = pathname.slice(PANEL_PATH.length);
    const known = { '/status': ['GET'], '/attention': ['GET'], '/settings': ['GET', 'POST'],
      '/settings/apply': ['POST'], '/settings/cancel': ['POST'], '/jobs': ['GET'], '/output': ['GET'],
      '/cancel': ['POST'], '/prompt': ['GET', 'POST'], '/reload': ['POST'],
      '/selftest/request': ['GET'], '/selftest/result': ['POST'] };
    if (!pathname.startsWith(PANEL_PATH + '/') || !known[route]) throw bad('找不到这个功能，请刷新面板后重试。', 404);
    if (!known[route].includes(method)) throw bad('打开方式不正确，请使用面板上的按钮重试。', 405);
    const allowedQuery = route === '/jobs' ? ['filter', 'offset'] : route === '/output' ? ['job_id', 'offset', 'limit'] : [];
    object(query, allowedQuery);
    if (method === 'POST' && route !== '/settings' && route !== '/selftest/result') object(body, route === '/prompt' ? ['text'] : route === '/cancel' ? ['job_id', 'confirm'] :
      route === '/settings/apply' ? ['changes', 'confirm'] : []);
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
      return { runtime: await runtime.execute({ action: 'status' }, { signal }), settings: panelSettings(cfg) };
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
      const page = runnerResult(await conductor.list({ limit: 20, offset: offset(query.offset, 0), ...(filter === 'running' ? { status: 'running' } : {}),
        ...(filter === 'attention' ? { needs_attention: true } : {}) }, signal));
      return { total: page.total, next_offset: page.next_offset, jobs: page.jobs.map((job) => ({ job_id: job.job_id, started_at: job.started_at,
        status: job.status, execution_status: job.execution_status,
        title: Array.from(job.context?.task ?? '').slice(0, 60).join(''),
        needs_attention: ['needs_changes', 'invalid'].includes(job.verification_status) ||
          (job.verification_status === 'unreviewed' && job.review_status === 'needs_attention') })) };
    }
    if (route === '/output') {
      const id = jobId(query.job_id), start = offset(query.offset, 0);
      const page = runnerResult(await conductor.output(id, { artifact: 'report',
        offset: start, limit: offset(query.limit, 8000, 20000) }, signal));
      if (start !== 0) return page;
      try {
        const parts = [];
        let offset = 0;
        for (;;) {
          signal?.throwIfAborted();
          const context = runnerResult(await conductor.output(id, { artifact: 'context', offset, limit: 8000 }, signal));
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
    if (!plannerFile) throw bad('规划提示词的保存位置尚未配置，请在 DSH 中设置保存位置后重试。', 409);
    if (method === 'GET') return { text: readFileSync(plannerFile, 'utf8') };
    if (typeof body.text !== 'string') throw bad('规划提示词必须是文字，请重新填写后保存。');
    writeBackedUpFile(plannerFile, Buffer.from(body.text, 'utf8'));
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
