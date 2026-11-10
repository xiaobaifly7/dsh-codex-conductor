import { readFileSync } from 'node:fs';
const { validatePanelSettings, writeBackedUpFile } = await import(new URL(`./runtime.mjs${new URL(import.meta.url).search}`, import.meta.url));

export const PANEL_PATH = '/dsh-codex-conductor';
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

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
    .map((key) => [key, cfg[key]]).concat([['gemini', cfg.gemini ? { model: cfg.gemini.model, effort: cfg.gemini.effort } : null]]));
}

// No paths or runner commands come from HTTP input.
export function createPanelApi({ cfg, conductor, runtime, plannerFile }) {
  let saving = false;
  return async function api(method, pathname, query = {}, body) {
    const route = pathname.slice(PANEL_PATH.length);
    const known = { '/status': ['GET'], '/attention': ['GET'], '/settings': ['GET', 'POST'],
      '/settings/apply': ['POST'], '/settings/cancel': ['POST'], '/jobs': ['GET'], '/output': ['GET'],
      '/cancel': ['POST'], '/prompt': ['GET', 'POST'], '/reload': ['POST'] };
    if (!pathname.startsWith(PANEL_PATH + '/') || !known[route]) throw bad('找不到这个功能，请刷新面板后重试。', 404);
    if (!known[route].includes(method)) throw bad('打开方式不正确，请使用面板上的按钮重试。', 405);
    const allowedQuery = route === '/jobs' ? ['filter'] : route === '/output' ? ['job_id', 'offset', 'limit'] : [];
    object(query, allowedQuery);
    if (method === 'POST' && route !== '/settings') object(body, route === '/prompt' ? ['text'] : route === '/cancel' ? ['job_id', 'confirm'] :
      route === '/settings/apply' ? ['changes', 'confirm'] : []);
    if (route === '/status') {
      return { runtime: await runtime.execute({ action: 'status' }), settings: panelSettings(cfg) };
    }
    if (route === '/attention') {
      const now = Date.now() / 1000;
      const since = now - 24 * 60 * 60;
      const ids = new Set();
      let offset = 0;
      for (;;) {
        const page = runnerResult(await conductor.list({ needs_attention: true, limit: 100, offset }));
        if (!Array.isArray(page?.jobs) || !Number.isSafeInteger(page.total) || page.total < 0 ||
            page.jobs.length > 100 || (page.offset !== undefined && page.offset !== offset) ||
            (!page.jobs.length && offset < page.total)) {
          throw bad('任务列表暂时不完整，请刷新状态后再试。', 502);
        }
        // The runner sorts by start time, newest first; older pages cannot add recent tasks.
        let older = false;
        for (const job of page.jobs) {
          if (!Number.isFinite(job.started_at)) continue;
          if (job.started_at < since) older = true;
          else if (job.started_at <= now) ids.add(job.job_id);
        }
        offset += page.jobs.length;
        if (older || offset >= page.total) return { total: ids.size };
      }
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
        if (result.status === 'failed') throw Object.assign(bad(result.error ?? '重载失败', 409), { saved: result.saved === true });
        return changes ? { saved: result.saved === true, runtime: result } : result;
      } finally { saving = false; }
    }
    if (route === '/jobs') {
      const filter = query.filter ?? 'all';
      if (!['all', 'running', 'attention'].includes(filter)) throw bad('任务筛选不正确，请重新选择要查看的任务。');
      const page = runnerResult(await conductor.list({ limit: 20, ...(filter === 'running' ? { status: 'running' } : {}),
        ...(filter === 'attention' ? { needs_attention: true } : {}) }));
      return { total: page.total, jobs: page.jobs.map((job) => ({ job_id: job.job_id, started_at: job.started_at,
        status: job.status, execution_status: job.execution_status,
        title: Array.from(job.context?.task ?? '').slice(0, 60).join(''),
        needs_attention: ['needs_changes', 'invalid'].includes(job.verification_status) ||
          (job.verification_status === 'unreviewed' && job.review_status === 'needs_attention') })) };
    }
    if (route === '/output') {
      return runnerResult(await conductor.output(jobId(query.job_id), { artifact: 'report',
        offset: offset(query.offset, 0), limit: offset(query.limit, 8000, 20000) }));
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
  };
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
          if (size > 1024 * 1024) throw bad('提交的内容超过 1 MiB，请缩短内容后再保存。', 413);
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
