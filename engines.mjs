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
export const runEngine = (args, cfg) => args.engine ?? (args.resume ? 'codex' : cfg.defaultEngine ?? 'codex');

export function verifyEngine(requested, source, cfg) {
  const engine = jobEngine(source);
  if (requested !== undefined) return requested;
  if (cfg.crossEngineVerify === false) return engine;
  return engine === 'gemini' ? 'codex' : cfg.gemini?.command ? 'gemini' : 'codex';
}

const samePath = (a, b) => path.win32.resolve(a).toLowerCase() === path.win32.resolve(b).toLowerCase();

// 只读 DSH agy 插件的账号池：每个账号有自己的 HOME 目录和代理，换号、冷却和额度由 DSH 插件维护，这里不写回。
// home 是续接原会话时原账号的目录：agy 会话按 HOME 分开保存，续接只能回到原账号。
// shortcut: 不看额度剩余比例和 Argon 资格，只按启用、未要求重新登录、未冷却选号；额度用尽时由 agy 报错，需要时再照 DSH 的 isAccountEligible 补齐。
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
  const usable = accounts.filter((a) => a.enabled === true && !a.authRequired && !(a.cooldowns?.[family]?.cooldownUntil > now));
  const account = [pool.activeAccountIds?.[family], pool.lastActiveAccountId].map((id) => usable.find((a) => a.id === id)).find(Boolean) ?? usable[0];
  if (!account) throw new Error('DSH agy 账号池里没有可用账号（都已停用、需要重新登录或在冷却中）；请先在 DSH 的 agy 插件里处理账号');
  return account;
}

// Codex 报额度用完时这一单结束的错误里带恢复时间（如 try again at Nov 23rd, 2026 11:23 PM，本机时区）。
// 返回恢复的毫秒时间戳；没有可解析的时间时，从这单结束起停 30 分钟（不知道结束时间就不停，免得翻看旧任务时重新计时）。不是额度错误返回 0。
export function codexQuotaUntil(error, finishedAt) {
  if (!/usage limit/i.test(error ?? '')) return 0;
  const stated = /try again at ([^.\n]+)/i.exec(error)?.[1].replace(/(\d)(?:st|nd|rd|th)\b/, '$1');
  const at = stated ? Date.parse(stated) : NaN;
  return !Number.isNaN(at) ? at : finishedAt ? finishedAt * 1000 + 30 * 60_000 : 0;
}

export function geminiArgv(args, cfg) {
  if (!cfg.gemini?.command) throw new Error('Gemini 执行需要在插件中配置 gemini.command');
  const effort = args.effort ?? (args.conversation_id ? undefined : cfg.gemini.executionEffort);
  const model = args.model ?? (args.conversation_id ? undefined : cfg.gemini.executionModel);
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
