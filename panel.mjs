import { readFileSync } from 'node:fs';
const { validatePanelSettings, writeBackedUpFile } = await import(new URL(`./runtime.mjs${new URL(import.meta.url).search}`, import.meta.url));

export const PANEL_PATH = '/dsh-codex-conductor';
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    throw bad('请求字段不正确');
  }
}

function jobId(value) {
  if (typeof value !== 'string' || !JOB_ID.test(value)) throw bad('任务编号不正确');
  return value;
}

function offset(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw bad('分页参数必须是整数');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < (maximum ? 1 : 0) || (maximum && n > maximum)) throw bad('分页参数超出范围');
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
    const known = { '/status': ['GET'], '/attention': ['GET'], '/settings': ['GET', 'POST'], '/jobs': ['GET'], '/output': ['GET'],
      '/cancel': ['POST'], '/prompt': ['GET', 'POST'], '/reload': ['POST'] };
    if (!pathname.startsWith(PANEL_PATH + '/') || !known[route]) throw bad('没有这个接口', 404);
    if (!known[route].includes(method)) throw bad('请求方法不支持', 405);
    const allowedQuery = route === '/jobs' ? ['filter'] : route === '/output' ? ['job_id', 'offset', 'limit'] : [];
    object(query, allowedQuery);
    if (method === 'POST' && route !== '/settings') object(body, route === '/prompt' ? ['text'] : route === '/cancel' ? ['job_id', 'confirm'] : []);
    if (route === '/status') {
      return { runtime: await runtime.execute({ action: 'status' }), settings: panelSettings(cfg) };
    }
    if (route === '/attention') {
      const attention = runnerResult(await conductor.list({ needs_attention: true, limit: 1 }));
      return { total: attention.total };
    }
    if (route === '/settings' && method === 'GET') return panelSettings(cfg);
    if (route === '/settings' || route === '/reload') {
      if (route === '/settings') {
        try { validatePanelSettings(body, Boolean(cfg.gemini)); }
        catch (error) { throw bad(error.message); }
      }
      if (saving) throw bad('正在保存或请求重载，请稍等', 409);
      saving = true;
      try {
        const result = await runtime.execute({ action: 'reload', when: 'idle' }, { panel: true }, route === '/settings' ? body : undefined);
        if (result.status === 'failed') throw Object.assign(bad(result.error ?? '重载失败', 409), { saved: result.saved === true });
        return route === '/settings' ? { saved: result.saved === true, runtime: result } : result;
      } finally { saving = false; }
    }
    if (route === '/jobs') {
      const filter = query.filter ?? 'all';
      if (!['all', 'running', 'attention'].includes(filter)) throw bad('任务筛选不正确');
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
        throw bad(`取消尚未确认：${result?.error ?? result?.error_kind ?? result?.status ?? '未知状态'}`, 502);
      }
      return result;
    }
    if (!plannerFile) throw bad('规划提示词文件尚未配置', 409);
    if (method === 'GET') return { text: readFileSync(plannerFile, 'utf8') };
    if (typeof body.text !== 'string') throw bad('规划提示词必须是文字');
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
      if (!connection?.requestRejection) throw bad('DSH 登录校验服务不可用', 503);
      const rejection = connection.requestRejection(req);
      if (rejection !== undefined) throw bad('请先登录 DeepSeek Harness', rejection);
      const url = new URL(req.url, 'http://localhost');
      const query = {};
      for (const [key, value] of url.searchParams) {
        if (Object.hasOwn(query, key)) throw bad('请求参数重复');
        Object.defineProperty(query, key, { value, enumerable: true });
      }
      let body;
      if (req.method === 'POST') {
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw bad('请使用 JSON 请求', 415);
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 1024 * 1024) throw bad('请求内容超过 1 MiB', 413);
          chunks.push(chunk);
        }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw bad('JSON 格式不正确'); }
      }
      send(200, await api(req.method, url.pathname, query, body));
    } catch (error) {
      send(error.status ?? 500, { error: error.message, ...(error.saved ? { saved: true } : {}) });
    }
  } });
  return unregister;
}
