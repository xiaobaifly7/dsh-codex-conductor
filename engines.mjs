import { readFileSync } from 'node:fs';
import path from 'node:path';

export const ENGINE_GUIDANCE = 'Codex 适合常规工程执行和原 Codex 线程续接。Gemini 使用 Windows Antigravity，任务目录须在 Windows 盘符下；只有主机访问任务能运行命令和写文件，沙箱内只能读文件；需配置 gemini.command。';
export const ENGINE_PARAMETER = { type: 'string', enum: ['codex', 'gemini'], description: ENGINE_GUIDANCE };
const GEMINI_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export function checkEngine(engine) {
  if (engine !== undefined && !ENGINE_PARAMETER.enum.includes(engine)) {
    throw new Error('engine 必须是 codex 或 gemini');
  }
}

export const jobEngine = (job) => job?.engine ?? job?.task_options?.engine ?? 'codex';
// lockEngine: every task, continuation and verification runs on defaultEngine, whatever the planner passes.
export const runEngine = (args, cfg) => cfg.lockEngine ? cfg.defaultEngine ?? 'codex'
  : args.engine ?? (args.resume ? 'codex' : cfg.defaultEngine ?? 'codex');

// The text planners see for engine choice: the general guidance, or which engine and model every task now uses.
export function engineGuidance(cfg) {
  if (!cfg.lockEngine) return ENGINE_GUIDANCE;
  const gemini = (cfg.defaultEngine ?? 'codex') === 'gemini';
  return `执行端已锁定为 ${gemini ? `Gemini（${cfg.gemini?.executionModel ?? cfg.gemini?.model}）` : 'Codex'}：codex_run、codex_continue、` +
    'codex_verify 都由它执行，传 engine 会被忽略。' + (gemini ? '返工用 codex_continue(job_id)，不要传 resume；续接原 Codex 任务时插件自动转给 Gemini 并附上轮交接。' +
    '任务目录须在 Windows 盘符下；只有主机访问任务能运行命令和写文件。' : '');
}

export function verifyEngine(requested, source, cfg) {
  if (cfg.lockEngine) return cfg.defaultEngine ?? 'codex';
  const engine = jobEngine(source);
  if (requested !== undefined) return requested;
  if (cfg.crossEngineVerify === false) return engine;
  return engine === 'gemini' ? 'codex' : cfg.gemini?.command ? 'gemini' : 'codex';
}

const samePath = (a, b) => path.win32.resolve(a).toLowerCase() === path.win32.resolve(b).toLowerCase();

// 只读 DSH agy 插件的账号池：每个账号有自己的 HOME 目录和代理，换号、冷却和额度由 DSH 插件维护，这里不写回。
// home 是续接原会话时原账号的目录：agy 会话按 HOME 分开保存，续接只能回到原账号。
// 选号按 DSH agy-link 的 isAccountEligible：启用、未要求重新登录、未冷却、支持这个模型（额度组列了模型时须在列），
// 额度组剩余不到 10% 或本周不到 5% 时等它重置。此前不查模型：只有一个号有 Gemini 4，换到另一个号就跑不了 Neon。
// shortcut: 没管 DSH 进程内记的“不支持模型”名单和发现的模型目录，只看 pool.json；不符时 agy 报错，再补。
export function poolAccount(file, model, home) {
  let pool;
  try {
    pool = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`读取 DSH agy 账号池失败（${file}）：${error.message}`);
  }
  const accounts = Array.isArray(pool?.accounts) ? pool.accounts.filter((a) => typeof a?.dir === 'string' && a.dir) : [];
  if (home) {
    const account = accounts.find((a) => samePath(a.dir, home));
    if (!account) throw new Error('原 Gemini 会话所在的 agy 账号已不在 DSH 账号池里，无法续接；请用 fresh: true 开新会话');
    return account;
  }
  const family = /argon/i.test(model ?? '') ? 'argon' : 'google';
  const now = Date.now();
  const base = (id) => String(id ?? '').trim().toLowerCase().replace(/\./g, '-').replace(/-(?:low|medium|high|xhigh|max)$/, '');
  const supports = (a) => {
    if (!model) return true;
    if (family === 'argon') return a.quotas?.argon !== undefined || a.dedicatedGroups?.includes('argon') === true ||
      (a.quotas?.google?.models ?? []).some((m) => /argon/i.test(m?.modelId ?? ''));
    const listed = a.quotas?.[family]?.models;
    return !Array.isArray(listed) || !listed.length || listed.some((m) => base(m?.modelId) === base(model));
  };
  const benched = (a) => {
    const q = a.quotas?.[family] ?? (family === 'argon' ? a.quotas?.google : undefined);
    const cleared = a.quotaGateClearedAt?.[family];
    if (!q || (cleared !== undefined && (q.updatedAt ?? 0) <= cleared)) return false;
    const pending = (time) => !time || !(Date.parse(time) <= now);
    return (typeof q.remainingFraction === 'number' && q.remainingFraction <= 0.1 && pending(q.resetTime)) ||
      (typeof q.weeklyFraction === 'number' && q.weeklyFraction <= 0.05 && pending(q.weeklyResetTime));
  };
  const usable = accounts.filter((a) => a.enabled === true && !a.authRequired && !(a.cooldowns?.[family]?.cooldownUntil > now) &&
    supports(a) && !benched(a));
  const account = [pool.activeAccountIds?.[family], pool.lastActiveAccountId].map((id) => usable.find((a) => a.id === id)).find(Boolean) ?? usable[0];
  if (!account) {
    throw new Error(`DSH agy 账号池里没有可用账号：没有能用 ${model || 'Gemini'} 的账号（已停用、需要重新登录、在冷却中、不支持这个模型或额度不足）；请先在 DSH 的 agy 插件里处理账号`);
  }
  return account;
}

// Codex 报额度用完时这一单结束的错误里带恢复时间（本机时区）：跨天写 try again at Nov 23rd, 2026 11:23 PM，当天只写 11:23 PM。
// 返回恢复的毫秒时间戳；只有时刻时补上这单结束那天的日期，早于结束时间就算第二天；没有可解析的时间时从这单结束起停 30 分钟。
// 这两种都要知道结束时间，不知道就不停，免得翻看旧任务时重新计时。不是额度错误返回 0。
export function codexQuotaUntil(error, finishedAt) {
  if (!/usage limit/i.test(error ?? '')) return 0;
  const stated = /try again at ([^.\n]+)/i.exec(error)?.[1].replace(/(\d)(?:st|nd|rd|th)\b/, '$1').trim();
  const at = stated ? Date.parse(stated) : NaN;
  if (!Number.isNaN(at)) return at;
  if (!finishedAt) return 0;
  const ended = finishedAt * 1000;
  const today = /^\d{1,2}:\d{2}\s*[AP]M$/i.test(stated ?? '') ? Date.parse(`${new Date(ended).toDateString()} ${stated}`) : NaN;
  return Number.isNaN(today) ? ended + 30 * 60_000 : today > ended ? today : today + 86_400_000;
}

export function geminiArgv(args, cfg) {
  if (!cfg.gemini?.command) throw new Error('Gemini 执行需要在插件中配置 gemini.command');
  // forceModel / forceEffort: the configured model and effort apply to every Gemini job, continued conversations included
  // (agy switches the model of a conversation it resumes).
  const effort = cfg.gemini.forceEffort ? cfg.gemini.executionEffort : args.effort ?? (args.conversation_id ? undefined : cfg.gemini.executionEffort);
  const model = cfg.gemini.forceModel ? cfg.gemini.executionModel : args.model ?? (args.conversation_id ? undefined : cfg.gemini.executionModel);
  if (effort !== undefined && !GEMINI_EFFORTS.includes(effort)) throw new Error(`Gemini effort 必须是 ${GEMINI_EFFORTS.join('、')}`);
  const account = cfg.gemini.accountPool
    ? poolAccount(cfg.gemini.accountPool, model ?? cfg.gemini.executionModel, args.conversation_id ? args.agy_home : undefined) : null;
  const proxy = account?.proxyUrl || cfg.gemini.proxy;
  return ['--engine', 'gemini', '--agy-command', cfg.gemini.command,
    ...(effort ? ['--effort', effort] : []),
    ...(model ? ['--model', model] : []),
    ...(account ? ['--agy-home', account.dir] : []),
    ...(proxy ? ['--agy-proxy', proxy] : []),
    ...(cfg.maxGeminiRunningJobs == null ? [] : ['--max-engine-running', String(cfg.maxGeminiRunningJobs)])];
}
