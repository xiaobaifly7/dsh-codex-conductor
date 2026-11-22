// dsh-codex-conductor —— 「DSH agent 规划 → WSL 里的 Codex 执行 → agent 验收」的执行层与护栏
//
// 执行交给随包附带的 runner/codex_runner.py，在 WSL 里运行（超时、断线、重试、写锁、
// 按 thread 续跑、改动快照都在那里）。本插件负责：
//   · 结构化派活：codex_run 的任务、必填验收标准、执行约束和允许范围经 stdin 交给 runner，
//     要求 Codex 按 report.v2.schema.json 逐条回报；结果里标出自报未满足、偏离计划和范围外的改动
//   · 等待与取消：start 后立即登记 DSH 后台任务（任务表里看得到进度和结束摘要），经任务表等结果；
//     agent 留在本轮用 codex_status 长等待；空闲会话仍由结束通知唤醒。
//     停止观察不取消任务；未登记后台的派单同步等待被取消时，仍由 runner 清理 Codex 进程树。
//   · 护栏：config.workspaces 内的会话，写文件类工具一律拒绝，shell 只放行只读核验命令
//   · 防虚报：回合结束时声称已派 Codex、却没调用 codex_* 也没有在跑的任务，就提醒它补上或更正
//
// 护栏 fail-closed：范围内判定出错就拒绝并给出原因；范围外的会话完全不受影响。

import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
// helper 继承入口的重载 query，避免入口刷新后仍复用旧依赖。
const reloadQuery = new URL(import.meta.url).search;
const { validReport, blockingState, prepareContinuation, previousRoundBrief, ownerBlockerIds, resolvedBlockerIds,
  repeatedOutcome, writeContradictions, withoutVerificationProduct, continuationSubmission, sameCriteria } = await import(new URL(`./workflow.mjs${reloadQuery}`, import.meta.url));
const { runtimeIdentity, loadedRecord, pidReused, registerRuntimeTool, queryWithTimeout, QUERY_TIMEOUT_MS,
  REPEAT_FAILURE_DEFAULTS, validRepeatFailureField } = await import(new URL(`./runtime.mjs${reloadQuery}`, import.meta.url));
const { registerResumeRequests, registerAutoWake } = await import(new URL(`./resume.mjs${reloadQuery}`, import.meta.url));
const { geminiWrite } = await import(new URL(`./gemini.mjs${reloadQuery}`, import.meta.url));
const { ENGINE_GUIDANCE, ENGINE_PARAMETER, checkEngine, engineGuidance, jobEngine, runEngine, verifyEngine, geminiArgv, poolAccount, codexQuotaUntil } =
  await import(new URL(`./engines.mjs${reloadQuery}`, import.meta.url));
const { registerPanel } = await import(new URL(`./panel.mjs${reloadQuery}`, import.meta.url));
const { prepareReview, reviewRejection, reviewSkeleton, pendingCloseout, closeoutRefusal, closeoutDeferral, closeoutSince,
  flaggedCriteria, mustVerifyCriteria, verifyCriterionItem, verificationItemKey, reportRowOf, OWNER_ONLY_REASONS,
  HISTORICAL_GAP_KINDS, historicalCriteria } = await import(new URL(`./closeout.mjs${reloadQuery}`, import.meta.url));
const { writeJsonAtomic, createAliases, registerHandoverRequests, createHistoryTracker, createAutoHandover, AUTO_HANDOVER_DEFAULTS, autoContinueFromSettings, outsideHmr, repairLinks, lastSuccessor, forwardRetiredNotices, instructionArchivePath } = await import(new URL(`./handover.mjs${reloadQuery}`, import.meta.url));
const { registerAutoAnswer, normalizeAutoAnswer, AUTO_ANSWER_DEFAULTS } = await import(new URL(`./autoanswer.mjs${reloadQuery}`, import.meta.url));
const { wslPath, PS_SYNTAX, normPath, under, inWorkspace, splitCommand, readOnlyCommand, decide, knownTool, createProductReads, PRODUCT_DENY_HINT } =
  await import(new URL(`./guard.mjs${reloadQuery}`, import.meta.url));
export { PS_SYNTAX, normPath, splitCommand, readOnlyCommand, decide };

const loadedIdentity = runtimeIdentity(import.meta.url);

export const name = 'codex-conductor';
// systemPrompt 不列为依赖（这里的 inject 每一项都是必需的），用 ctx.get 取：有就注入规划要求，没有照样能用其余功能
export const inject = ['tools'];

const here = (file) => fileURLToPath(new URL(file, import.meta.url));
const bundledAgentsMd = here('./executor-agents.md');
const nativeDefaults = {
  python: 'python.exe',
  runner: here('./runner/codex_runner.py'),
  reportSchema: here('./report.v2.schema.json'),
};

// 留空的项都沿用 WSL 默认发行版和 Codex 自己的配置
const DEFAULTS = {
  runnerMode: 'wsl',
  distro: '',
  python: 'python3',
  runner: wslPath(nativeDefaults.runner),
  codexBin: '',
  pwshDir: '',
  codexHome: '',
  runnerHome: '',
  stateDir: '',
  // Codex 任务用的用户级 AGENTS.md：留空沿用 CODEX_HOME 里的；none 不带；绝对路径换成该文件（仅未传 use_user_config 的任务）
  runnerAgentsMd: '',
  routerCheckUrl: '',
  codexRoute: null,
  model: '',
  defaultEngine: 'codex',
  lockEngine: false,
  geminiFallback: true,
  crossEngineVerify: true,
  maxGeminiRunningJobs: 2,
  modelAB: { enabled: false, models: ['codex/gpt-6.1-sol', 'codex/gpt-6.2-sol'], share: 0.5 },
  effort: '',
  effortOverride: 'planner',
  // 只读任务的推理强度，留空与 effort 相同
  readOnlyEffort: '',
  serviceTier: '',
  waitSeconds: 0,
  autoWakeBlockedInbox: true,
  // delaySeconds > 0：宿主启动后等这么久再续接，只补那些到时仍没有新回合的会话（让 auto-continue 先扫）；0 立即续接
  autoResume: { enabled: true, maxAgeHours: 12, message: 'Harness 已重启，接着上次中断的地方继续。', exclude: [],
    delaySeconds: 0, reloadDelaySeconds: 20 },
  timeoutSeconds: null,
  idleTimeoutSeconds: null,
  retries: null,
  repeatFailureGuard: REPEAT_FAILURE_DEFAULTS,
  lockTimeoutSeconds: null,
  maxStorageMb: null,
  // 同时运行（含排队等写锁）的 Codex 任务数上限；留空不限制
  maxRunningJobs: null,
  // 每个会话累计可派的任务数、累计用量（token）上限；留空不限制
  maxSessionJobs: null,
  // 会话消息数超过这个值时标记“建议交接”；0 关闭（自动交接的提醒、询问也随之关闭）
  handoverSuggestMessages: 5000,
  // 最近 20 次请求的上下文都不低于这个 token 数时也建议交接（压缩已降不下来）；0 关闭。
  handoverContextTokens: 0,
  // 新派活的验收标准超过这么多条时，在派活回执里提醒一句（不拦截）；0 关闭
  acceptanceWarnAbove: 8,
  // 结案（verified / accepted_deviations）时，原报告自标 blocked / not_met 的条目记成 met 需要什么依据：
  // independent 需独立依据（核验任务、后续轮次或用户确认）；planner 规划端自己的非照抄证据即可；off 不查
  closeoutEvidence: 'independent',
  acceptOpenEvidence: 'strict',
  autoVerify: 'flagged',
  // 报告只是停下来等规划端回答（阻塞全是 user_input / task_conflict、没有 not_met）时不自动核验；false 照旧核验
  autoVerifySkipQuestions: true,
  // codex_continue（不带 answers）续接的原线程上一次请求超过这么多输入 token 时，改开新线程并附上轮交接内容；0 总是沿用原线程
  continueFreshAboveTokens: 100000,
  // 标记建议交接之后怎么办：off 只标记；notify 面板提醒；confirm 空闲时在面板询问；auto 空闲时直接交接，回合一直不结束时在步骤边界结束它再交接
  autoHandover: AUTO_HANDOVER_DEFAULTS,
  autoAnswer: AUTO_ANSWER_DEFAULTS,
  maxSessionTokens: null,
  // 可写任务在 git 仓库里记录本单改动的 diff（可回滚）；false 关闭
  jobDiff: true,
  // 本会话有已结束、报告有标记却未 codex_review 或 needs_changes 未跟进的任务时，拒绝开新工作的 codex_run；false 关闭
  closeoutGuard: true,
  convergenceGuard: true,
  historicalGapReview: true,
  dispatchConsistency: true,
  actionableReceipts: true,
  verificationReuse: true,
  // 受护栏会话的工具放行方式，allowlist 只放行护栏认识的工具和配置的名单。
  toolPolicy: 'denylist',
  allowTools: [],
  mcpWriteAllow: [],
  workspaces: [],
  denyTools: [],
  allowCommands: [],
  ignoreChanges: [],
  // 允许 codex_run 传 host_access=true，让 Codex 在沙箱外运行（能启动 Windows 程序）；默认关闭
  allowHostAccess: false,
  // 省略 host_access 时默认使用主机模式，仍须开启 allowHostAccess
  defaultHostAccess: false,
  plannerAnswers: false,
  ownerDecisions: 'planner',
  plannerReads: 'open',
  plannerReadAllow: [],
  // runner 在 WSL 里读取这个文件，用 --output-schema 约束 Codex 的最终答复
  reportSchema: wslPath(nativeDefaults.reportSchema),
  // 用户写给 DeepSeek 的规划要求（Markdown）；留空用 %LOCALAPPDATA%\dsh-codex-conductor\planner-prompt.md
  plannerPromptFile: '',
  // 附在每一单任务书后面、给 Codex 的固定要求（Markdown）；留空用规划要求文件同目录的 executor-prompt.md
  executorPromptFile: '',
  runtimeProfileFile: '',
  gemini: null,
};

const EXECUTOR_TEMPLATE = `<!--
每一单交给 Codex 的固定要求（dsh-codex-conductor）。

写在这段注释下面的内容，会附在每一单任务书的执行约束后面，Codex 每单都会看到；
它不增加权限，也不改变任务范围和验收标准。保存后下一单就生效，不用重载插件。
只留这段注释（或清空文件）就不附加任何内容。
-->
`;

const PLANNER_TEMPLATE = `<!--
DeepSeek 派活给 Codex 前的规划要求（dsh-codex-conductor）。

写在这段注释下面的内容，会作为系统提示词的一段注入给 DeepSeek，每一步都带着；
它是给 DeepSeek 自己规划用的（怎么拆任务、写 task 和验收标准时要注意什么），不会原样发给 Codex。
保存后下一步就生效，不用重载插件。只留这段注释（或清空文件）就不注入任何内容。
-->
`;

// 规划要求文件的有效内容：去掉 HTML 注释；文件不存在或读不了就当没有
// 给外部看门狗：哪些会话正有交接排队或进行中（自动交接的 pending，或还没处理完的交接请求文件）。只含会话 ID。
export function handoverPendingSessions(directory) {
  const ids = new Set();
  try {
    const sessions = JSON.parse(readFileSync(path.join(directory, 'auto-handover.json'), 'utf8')).sessions ?? {};
    for (const [id, record] of Object.entries(sessions)) if (record?.pending) ids.add(id);
  } catch {}
  let names = [];
  try { names = readdirSync(directory); } catch {}
  for (const name of names) {
    if (!/^handover-request(\.[0-9a-f-]+\.processing)?\.json$/.test(name)) continue;
    try {
      const request = JSON.parse(readFileSync(path.join(directory, name), 'utf8').replace(/^﻿/, ''));
      for (const id of [request.sessionId, request.adopt?.from, request.adopt?.to, request.revert?.from, request.revert?.to]) {
        if (typeof id === 'string' && id) ids.add(id);
      }
    } catch {}
  }
  return [...ids].sort();
}

export function plannerPrompt(file) {
  try {
    return readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '').trim();
  } catch {
    return '';
  }
}

export function plannerSection(text) {
  return text ? '## 派活给 Codex 前的规划要求（用户设定）\n' +
    '按下列要求写 task 和 acceptance，派单前核对授权与本轮可取证性。不要原样抄给 Codex。\n\n' +
    text : '';
}

// 声称已经派出 / Codex 正在执行的说法
const DISPATCH_CLAIM = new RegExp([
  '(已|已经)[^。\\n]{0,8}(派|派发|派出|交给|委派|提交)[^。\\n]{0,12}codex',
  'codex[^。\\n]{0,12}(正在|在做|在跑|执行中|处理中)',
  '派出去了',
  '(dispatched|delegated|handed (it )?(off|over)|sent)( it| the task)? to codex',
  'codex is (now )?(working|running|handling)',
].join('|'), 'i');
const NUDGE = '[codex-conductor] 你刚才说已经派 Codex 去做或 Codex 正在执行，但这一轮没有调用 codex_run / codex_status，' +
  '也没有由 codex_run 启动且仍在运行的任务。确实需要 Codex 执行的，现在调用 codex_run；' +
  '只是计划或需要用户先确认的，请更正说法，不要说已经派出。';

function routeConfiguration(cfg) {
  const router = cfg.routerCheckUrl && new URL(cfg.routerCheckUrl);
  if (router && !['http:', 'https:'].includes(router.protocol)) throw new Error('routerCheckUrl 必须是 HTTP(S) URL');
  const route = cfg.codexRoute;
  let routeUrl;
  if (route != null) {
    if (typeof route.provider !== 'string' || !/^[A-Za-z0-9_-]+$/.test(route.provider) || typeof route.baseUrl !== 'string') {
      throw new Error('codexRoute 需要已有自定义 provider 和 baseUrl');
    }
    routeUrl = new URL(route.baseUrl);
    if (!['http:', 'https:'].includes(routeUrl.protocol) || routeUrl.username || routeUrl.password) {
      throw new Error('codexRoute.baseUrl 必须是无凭据的 HTTP(S) URL');
    }
  }
  return { router, route, routeUrl };
}

function loadedGateway(cfg) {
  try {
    const { router, route, routeUrl } = routeConfiguration(cfg);
    return { codexRoute: routeUrl ? { provider: route.provider, origin: routeUrl.origin } : null,
      routerCheck: router ? { transport: 'tcp', origin: router.origin }
        : routeUrl ? { transport: 'http', origin: routeUrl.origin } : null };
  } catch {
    return { routeConfigInvalid: true };
  }
}

// wsl.exe 的参数。配置了的路径用 env 显式传入，不依赖宿主进程继承来的环境
function runnerEnvironment(cfg, mapPath) {
  const { router, route, routeUrl } = routeConfiguration(cfg);
  return [
    cfg.codexHome && `CODEX_HOME=${cfg.codexHome}`,
    cfg.runnerHome && `CODEX_RUNNER_HOME=${cfg.runnerHome}`,
    cfg.runnerAgentsMd && `CODEX_RUNNER_AGENTS_MD=${cfg.runnerAgentsMd === 'bundled' ? mapPath(bundledAgentsMd) : cfg.runnerAgentsMd}`,
    router && `CODEX_RUNNER_ROUTER_URL=${router.origin}`,
    routeUrl && `CODEX_RUNNER_ROUTE_PROVIDER=${route.provider}`,
    routeUrl && `CODEX_RUNNER_ROUTE_URL=${routeUrl.href}`,
    cfg.codexBin && `CODEX_RUNNER_CMD=${JSON.stringify([cfg.codexBin])}`,
  ].filter(Boolean);
}

export function runnerArgv(cfg, args) {
  return [...(cfg.distro ? ['-d', cfg.distro] : []), '-e', 'env', ...runnerEnvironment(cfg, wslPath),
    cfg.python, cfg.runner, ...args];
}

// 跑一个命令，返回它输出的最后一行 JSON。timeoutMs 到了还没结束（WSL 卡死或起不来）就结束它并按 bridge_error 返回，
export function runProcess(command, argv, { stdin, signal, timeoutMs, env, onProgress, singleResult = false } = {}) {
  if (signal?.aborted) return Promise.resolve({ status: 'failed', error_kind: 'bridge_error',
    error: `${command} 调用前已被中止`, retryable: true });
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, argv, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env });
    } catch (error) {
      resolve({ status: 'failed', error_kind: 'bridge_error', error: String(error?.message ?? error), retryable: true });
      return;
    }
    const out = [];
    const err = [];
    const stopChild = () => {
      child.kill();
      // The promise and the Node process must both be free to exit when a bridge is done.
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    };
    if (!onProgress && !singleResult) child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    const onAbort = () => {
      cleanup();
      stopChild();
      resolve({ status: 'failed', error_kind: 'bridge_error', error: `${command} 查询已中止`, retryable: true });
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    // 用 1 秒一跳的 interval，而不是一个长 setTimeout：Windows 上 libuv 计时走 QueryPerformanceCounter，含睡眠时间，
    // 一个长 setTimeout 会在电脑睡眠唤醒后立刻判超时、误杀在飞的 status；interval 睡眠期间只补一跳（约 1 秒），不会误杀，
    // 也不会因 timeoutMs 超过 2^31 而被 Node 夹成 1 毫秒立刻触发。
    const cleanup = () => {
      clearInterval(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    let ticks = 0;
    const timer = timeoutMs && setInterval(() => {
      if (++ticks * 1000 < timeoutMs) return;
      cleanup();
      stopChild();
      resolve({ status: 'failed', error_kind: 'bridge_error', retryable: true,
        error: `${command} 超过 ${Math.round(timeoutMs / 1000)} 秒没有返回，已结束该查询进程` });
    }, 1000);
    if (onProgress || singleResult) {
      const lines = createInterface({ input: child.stdout });
      const fail = (error) => { cleanup(); stopChild(); reject(error); };
      lines.on('error', fail);
      lines.on('line', (line) => {
        if (!line.trim()) return;
        let value;
        try { value = JSON.parse(line); } catch { return; }
        if (typeof value?.status !== 'string') return;
        if (!onProgress || value.status !== 'running') {
          // Runner emits one JSON result; inherited pipes must not delay its delivery.
          cleanup();
          resolve(value);
          stopChild();
          return;
        }
        ticks = 0;
        try { onProgress(value); } catch (error) { fail(error); }
      });
    }
    child.on('error', (error) => {
      cleanup();
      resolve({ status: 'failed', error_kind: 'bridge_error', error: error.message, retryable: true });
    });
    child.on('close', (code) => {
      cleanup();
      const stdout = Buffer.concat(out).toString('utf8').trim();
      if (!onProgress) {
        try { resolve(JSON.parse(stdout.split('\n').at(-1))); return; } catch {}
      }
      const stderr = Buffer.concat(err).toString('utf8').trim().slice(-2000);
      const detail = stderr || (onProgress ? 'status stream closed without a final result' : stdout.slice(-2000));
      resolve({ status: 'failed', error_kind: 'bridge_error', error: `runner exited ${code}: ${detail}`, retryable: true });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin ?? '');
  });
}

// 调用 WSL 里的 runner。不设 WSL_UTF8 时 wsl.exe 自己的报错是 UTF-16LE，按 UTF-8 读出来是乱码
// exec 可注入，默认 runProcess；测试据此验证超时/stdin/signal/env 真的传到了 spawn，而不是只在假 run 上验证
const bundledRunner = (cfg) => cfg.runnerMode === 'native'
  ? typeof cfg.runner === 'string' && path.win32.isAbsolute(cfg.runner) && path.win32.relative(nativeDefaults.runner, cfg.runner) === ''
  : cfg.runner === DEFAULTS.runner;

function resolveStatePath(dir) {
  try {
    return realpathSync.native(dir);
  } catch (error) {
    if (error.code !== 'ENOENT' || path.dirname(dir) === dir || lstatSync(dir, { throwIfNoEntry: false })) throw error;
    return path.join(resolveStatePath(path.dirname(dir)), path.basename(dir));
  }
}

function validateNativeState(cfg) {
  const local = process.env.LOCALAPPDATA;
  const profile = process.env.USERPROFILE || homedir();
  const protectedRoots = [path.join(profile, '.codex'), path.join(profile, '.local', 'state', 'codex-runner'),
    ...(local ? [path.join(local, 'dsh-codex-conductor'), path.join(local, 'codex-runner')] : [])]
    .flatMap(dir => [dir, resolveStatePath(dir)]);
  const directories = {};
  for (const key of ['stateDir', 'runnerHome', 'codexHome']) {
    if (typeof cfg[key] !== 'string' || path.win32.parse(cfg[key]).root.length < 3) {
      throw new Error(`Windows 原生模式需要配置独立的绝对路径 ${key}`);
    }
    const dir = path.win32.normalize(cfg[key]);
    const resolved = resolveStatePath(dir);
    for (const candidate of [dir, resolved]) {
      if (protectedRoots.some(root => {
        const relative = path.win32.relative(root, candidate);
        return relative === '' || (!path.win32.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..\\'));
      })) throw new Error(`Windows 原生模式的 ${key} 指向线上状态目录：${candidate}`);
    }
    directories[key] = resolved;
  }
  return directories;
}

export function runRunner(cfg, args, opts = {}, exec = runProcess) {
  const options = { ...opts, singleResult: bundledRunner(cfg) };
  if (cfg.runnerMode === 'native') {
    try {
      if (process.platform !== 'win32') throw new Error('原生 runner 需要 Windows');
      cfg = { ...cfg, ...validateNativeState(cfg) };
    } catch (error) {
      return Promise.resolve({ status: 'failed', error_kind: 'bridge_error', retryable: false,
        error: error.message });
    }
    const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
    if (cfg.pwshDir) env.CODEX_RUNNER_PWSH_DIR = cfg.pwshDir;
    for (const assignment of runnerEnvironment(cfg, (file) => file)) {
      const separator = assignment.indexOf('=');
      env[assignment.slice(0, separator)] = assignment.slice(separator + 1);
    }
    return exec(cfg.python || 'python.exe', [cfg.runner, ...args], { ...options, env });
  }
  return exec('wsl.exe', runnerArgv(cfg, args), { ...options, env: { ...process.env, WSL_UTF8: '1' } });
}

// Mutations retain the cold-start allowance; only background streams use the longer silence watchdog.
const BRIDGE_TIMEOUT_MS = 120_000;
const BRIDGE_SLACK_MS = 60_000;

const unknownState = (value) => ['bridge_error', 'unknown_job', 'invalid_record'].includes(value.error_kind) ||
  ['monitor_failed', 'unknown'].includes(value.status);
const cancelUnconfirmed = (value) => unknownState(value) || value.error_kind === 'process_cleanup_failed' ||
  !['cancelled', 'completed', 'failed'].includes(value.status);

export function createConductor(cfg, run = runRunner) {
  async function query(argv, signal, timeoutMs = QUERY_TIMEOUT_MS) {
    try {
      return await queryWithTimeout((signal) => run(cfg, argv, { signal, timeoutMs }), signal, timeoutMs);
    } catch (error) {
      if (error?.code !== 'query_timeout' && !signal?.aborted) throw error;
      return { status: 'failed', error_kind: 'bridge_error', error: error.message, retryable: true };
    }
  }

  // 手动查询仍有界；随包 runner 的后台观察可以在同一进程内继续等待。
  async function waitJob(jobId, seconds, signal, onProgress) {
    // 夹在 1 天内：既防超大值让底层 status 等上几十天，也让 timeoutMs 远小于 2^31
    const wait = Math.min(Math.max(0, seconds), 86_400);
    const follow = onProgress && bundledRunner(cfg);
    const argv = ['status', jobId, '--wait', String(wait)];
    if (follow) argv.push('--follow');
    const value = signal?.aborted ? undefined
      : follow ? await run(cfg, argv, { signal, timeoutMs: wait * 1000 + BRIDGE_SLACK_MS, onProgress })
        : await query(argv, signal, wait * 1000 + QUERY_TIMEOUT_MS);
    signal?.throwIfAborted();
    const note = value.status === 'running' ? { note: `等了 ${seconds} 秒仍在执行，任务在后台继续；${waitForJob(jobId)}` } : {};
    return { job_id: jobId, ...value, ...note };
  }

  async function start(args, cwd, signal, context) {
    if (cfg.runnerMode === 'native' && args.use_user_config === true) {
      throw new Error('Windows 原生模式使用独立的 Codex home，不支持 use_user_config=true。请改用默认精简配置，或在 WSL 模式使用原用户配置。');
    }
    const argv = ['start', '--cwd', cwd];
    const engine = runEngine(args, cfg);
    const repeat = cfg.repeatFailureGuard ?? REPEAT_FAILURE_DEFAULTS;
    argv.push('--repeat-guard', repeat.enabled ? 'on' : 'off', '--repeat-min-seconds', String(repeat.minSeconds),
      '--repeat-failures', String(repeat.failures), '--repeat-window-hours', String(repeat.windowHours));
    if (args.rerun_after_change) argv.push('--allow-rerun');
    const hostAccess = args.host_access ?? (cfg.defaultHostAccess === true);
    if (engine === 'gemini') {
      argv.push(...geminiArgv(args, cfg));
    } else {
      const effort = args.effort ?? (context?.verification_of ? undefined : defaultEffort(cfg, args.write));
      if (effort) argv.push('--effort', effort);
      const model = args.model ?? cfg.model;
      const serviceTier = args.service_tier ?? cfg.serviceTier;
      if (cfg.modelAB?.enabled && args.model === undefined && !args.resume && context && !context.continuation && !context.verification_of) {
        argv.push('--model-ab', JSON.stringify([cfg.modelAB.models, cfg.modelAB.share]));
      } else if (model) argv.push('--model', model);
      if (serviceTier) argv.push('--service-tier', serviceTier);
      if (cfg.geminiFallback !== false && cfg.gemini?.command && context?.owner) argv.push('--gemini-fallback-check');
    }
    for (const [key, flag] of [['timeoutSeconds', '--timeout'], ['idleTimeoutSeconds', '--idle-timeout'], ['retries', '--retries'],
      ['lockTimeoutSeconds', '--lock-timeout'], ['maxStorageMb', '--max-storage-mb']]) {
      if (cfg[key] != null) argv.push(flag, String(cfg[key]));
    }
    if (cfg.jobDiff === false) argv.push('--no-diff');
    // host_access 不管 write 都在沙箱外运行，write=false 的只读只靠提示约束
    if (hostAccess === true) argv.push('--sandbox', 'danger-full-access');
    else if (args.write === true) argv.push('--sandbox', 'workspace-write');
    const resume = engine === 'gemini' ? args.conversation_id : args.resume;
    if (resume) argv.push('--resume', resume);
    if (engine === 'codex' && args.use_user_config === true) argv.push('--use-user-config');
    if (cfg.reportSchema) argv.push('--schema', cfg.reportSchema);
    for (const s of args.scope ?? []) argv.push('--scope', s);
    for (const root of args.writable_roots ?? []) argv.push('--writable-root', root);
    // runner 在截取前 300 条改动之前就过滤，改动数和超出 scope 的检查才准
    for (const pattern of cfg.ignoreChanges ?? []) argv.push('--ignore', pattern);
    const task = args.rerun_after_change ? `${args.task.trim()}\n\n## 规划端说明的变化\n${args.rerun_after_change.trim()}` : args.task;
    const prompt = composePrompt(task, args.acceptance, args.scope, { hostAccess: hostAccess === true, write: args.write === true,
      ignore: cfg.ignoreChanges ?? [], fixed: cfg.executorPromptFile ? plannerPrompt(cfg.executorPromptFile) : '', mustVerify: args.must_verify,
      expectBlocked: args.expect_blocked, verification: Boolean(context?.verification_of) });
    if (context !== undefined) argv.push('--context-json');
    return run(cfg, argv, { stdin: context === undefined ? prompt : JSON.stringify({ prompt, context }), signal, timeoutMs: BRIDGE_TIMEOUT_MS });
  }

  async function cancel(jobId, signal) {
    const value = await run(cfg, ['cancel', jobId], { timeoutMs: BRIDGE_TIMEOUT_MS });
    if (signal?.aborted && cancelUnconfirmed(value)) {
      throw new Error(`Codex 任务 ${jobId} 的取消未确认：${value.error ?? value.error_kind ?? value.status}。` +
        `任务可能仍在运行，用 codex_jobs 核对正确 job_id，再用 codex_status 查询 ${jobId}，不要重派。`);
    }
    return value;
  }

  async function list(filters = {}, signal) {
    const argv = ['list', '--limit', String(filters.limit ?? 20), '--offset', String(filters.offset ?? 0)];
    for (const key of ['cwd', 'owner', 'status']) if (filters[key] !== undefined) argv.push(`--${key}`, filters[key]);
    for (const id of filters.owner !== undefined ? filters.also_owners ?? [] : []) argv.push('--also-owner', id);
    for (const [key, flag] of [['thread_id', '--thread-id'], ['parent_job', '--parent-job'],
      ['task_key', '--task-key'], ['verification_of', '--verification-of']]) if (filters[key] !== undefined) argv.push(flag, filters[key]);
    if (filters.needs_attention) argv.push('--needs-attention');
    if (filters.scope_conflicts) argv.push('--scope-conflicts');
    if (filters.started_between) argv.push('--started-between', ...filters.started_between.map(String));
    for (const id of filters.job_ids ?? []) argv.push('--job-id', id);
    return query(argv, signal);
  }

  async function output(jobId, { artifact = 'report', offset = 0, limit = 4000 } = {}, signal) {
    return query(['output', jobId, '--artifact', artifact, '--offset', String(offset), '--limit', String(limit)], signal);
  }

  async function review(jobId, review, reviewer, signal) {
    return run(cfg, ['review', jobId, '--reviewer', reviewer],
      { stdin: JSON.stringify(review), signal, timeoutMs: BRIDGE_TIMEOUT_MS });
  }

  async function summary(filters = {}, signal) {
    const argv = ['summary'];
    for (const key of ['cwd', 'owner']) if (filters[key] !== undefined) argv.push(`--${key}`, filters[key]);
    for (const id of filters.owner !== undefined ? filters.also_owners ?? [] : []) argv.push('--also-owner', id);
    if (filters.thread_id !== undefined) argv.push('--thread-id', filters.thread_id);
    for (const key of ['limit', 'offset']) if (filters[key] !== undefined) argv.push(`--${key}`, String(filters[key]));
    for (const id of filters.job_ids ?? []) argv.push('--job-id', id);
    return run(cfg, argv, { signal, timeoutMs: BRIDGE_TIMEOUT_MS });
  }

  const products = (owner) => run(cfg, ['products', '--owner', owner, '--limit', '10000'], { timeoutMs: BRIDGE_TIMEOUT_MS });
  const threadSize = (threadId, signal) => query(['thread-size', threadId], signal);
  const verificationVersion = (jobId, signal) => query(['verification-version', jobId], signal);
  function repeatGuard(cwd, signal) {
    const argv = ['repeat-guard'];
    if (cwd) {
      argv.push('--cwd', cwd);
      const repeat = cfg.repeatFailureGuard ?? REPEAT_FAILURE_DEFAULTS;
      for (const [key, flag] of [['failures', '--repeat-failures'], ['windowHours', '--repeat-window-hours']]) {
        if (repeat[key] !== REPEAT_FAILURE_DEFAULTS[key]) argv.push(flag, String(repeat[key]));
      }
    }
    return query(argv, signal).catch(() => undefined);
  }
  const doctor = (signal) => run(cfg, cfg.runnerMode === 'native' ? ['doctor', '--sandbox'] : ['doctor'],
    { signal, timeoutMs: BRIDGE_TIMEOUT_MS });
  const rollback = (jobId, { check = false } = {}, signal) =>
    run(cfg, ['rollback', jobId, ...(check ? ['--check'] : [])], { signal, timeoutMs: BRIDGE_TIMEOUT_MS });
  return { start, waitJob, cancel, list, output, review, summary, products, doctor, rollback, threadSize, repeatGuard, verificationVersion };
}

export function composePrompt(task, acceptance, scope = [], { hostAccess = false, write = false, ignore = [], fixed = '', mustVerify = [], expectBlocked = [], verification = false } = {}) {
  return `${task.trim()}\n\n## 验收标准\n完成后逐条自查，每条都要满足：\n` +
    acceptance.map((a, i) => `${i + 1}. ${a.trim()}`).join('\n') +
    (mustVerify.length ? `\n验收第 ${mustVerify.join('、')} 条必须实测；在 evidence 写清实际运行或观测的结果及可回查的证据位置。` : '') +
    expectBlocked.map(index => `\n第 ${index} 条预计在本环境受阻：不要在这一条上花时间，直接标 blocked，blockers 写 environment 并说明原因。`).join('') +
    '\n\n## 执行约束\n' +
    '- 只做上面任务和验收标准要求的事，不扩大范围，不顺手重构或修改无关文件。\n' +
    '- 脚本可能触及禁止的访问或状态变更时，先只读检查。副作用无法确认、会越出授权或破坏数据时，停该步。\n' +
    (scope.length ? `- 只允许改动这些路径：${scope.join('、')}；其他文件一律不要动。\n` : '') +
    (ignore.length ? `- 路径（相对任务目录，用 / 分隔）匹配这些 Python re 正则的文件会被其他进程持续写入：${ignore.join('、')}。` +
      '它们在任务期间的变化不一定是你造成的：不要因此认为现状与任务不符，也不要因此把验收标准标为 blocked；' +
      '任务或验收标准本身要求查看或修改这些文件时照常处理。\n' : '') +
    (hostAccess ? '- 你在沙箱外运行，对这台机器有完全访问权限，可以通过 WSL interop 启动 Windows 程序（pwsh.exe、ssh.exe、Hyper-V cmdlet 等）。' +
      '只做任务需要的事；任务没有点名的虚拟机、文件和网络设置，不要删除、停止、重建或改配置。\n' : '') +
    (hostAccess && !write && !verification ? '- 这是只读调查：不要修改任何文件，也不要改变虚拟机、网络或系统状态。\n' : '') +
    '- 计划步骤、工具或路径不可用时，在原授权内换方法证明同一验收结果。不得扩大写入、主机访问或目标范围。' +
    '在 deviations 写明换了什么、为何等价。完成可做的部分。\n' +
    '- 不要为了通过验收去修改验收脚本、测试或判据本身，除非任务明确要求。\n' +
    '- 脚本的关键观测、清理或恢复失败时，须以非零状态退出。\n' +
    (fixed ? '\n## 用户的固定要求\n以下要求适用于每一单，不增加权限，也不扩大范围；与上面的任务、验收标准或执行约束冲突时，' +
      `以上面的为准，并在 deviations 里说明。\n${fixed}\n` : '') +
    '\n## 最后汇报\n最终答复只输出符合给定 JSON 格式的对象：summary 概述结果；criteria 按上面的顺序逐条给出（条数与验收标准相同，一条对一条，不拆分、不合并、不另加）' +
    'status（met / not_met / blocked）和 evidence（具体证据：命令与输出、文件与行号）；files_changed 列出改动的文件；' +
    'deviations 列出与计划不一致的地方及原因（没有就空数组）；unresolved 列出没解决的问题。\n' +
    '实测结果不符记 not_met；缺权限、环境、输入或证据无法事后补采时记 blocked，写明缺失的前置。' +
    '同一前置导致多条未测时，首条写清，其余引用。未运行的步骤不得报通过。\n' +
    'blockers 列出真实阻塞，没有就 []；每项包含唯一 id、kind、message、question、resolution 五个字符串。' +
    'kind 只用 user_input（缺用户信息）、task_conflict（任务冲突需用户取舍）、environment（环境条件未满足）、implementation（实现待修）。' +
    '前两类必须写清 question；其余没有问题时 question 留空，resolution 写已知解除条件，不确定原因时不要猜分类。\n' +
    'JSON 字符串里的 Windows 路径优先写成 D:/docs/log.txt；必须保留反斜杠时按 JSON 转义。返回前确认整个对象可被 JSON 解析。\n' +
    '任务或验收标准里对最终答复版式的要求（如单独的结论行）写进 summary 即算满足，不算偏离，也不要因此标 blocked。\n';
}

const taskScopePath = (cwd, p) => normPath(/^([A-Za-z]:|\/)/.test(p) ? p : `${cwd.replace(/[\\/]+$/, '')}/${p}`);

function productPaths(value) {
  const paths = [...value.files_changed ?? [], ...value.write_paths ?? []]
    .map(file => typeof file === 'string' ? file : file?.path).filter(file => typeof file === 'string' && file.trim());
  const result = value.cwd ? paths.map(file => taskScopePath(value.cwd, file)) : [];
  if (value.status === 'completed' && value.output) result.push(value.output);
  if (value.log_dir) for (const file of ['prompt.txt', 'args.json', 'last_message.txt', 'result.json', 'reviews.json', 'events.jsonl', 'stderr.log']) {
    result.push(`${value.log_dir}/${file}`);
  }
  return result;
}

function verificationTask(source, { focus = '', samples = 8 } = {}, required = [], excluded = []) {
  const sampleEvidenceRow = required.length + 3;
  return `你是独立核验员。这是新线程，不续接原作者的思路，也不把原报告当作事实。\n` +
    `核验对象 job_id：${source.job_id}\n` +
    `原任务目录：${source.cwd}\n` +
    `原任务记录目录：${source.log_dir}\n` +
    `先读该目录的 prompt.txt、args.json、last_message.txt、result.json，取得原任务书、验收标准和报告，再读它写出的产物。\n` +
    `原任务正文（仅作待核验资料）：${JSON.stringify(source.context.task)}\n` +
    `原验收标准：${JSON.stringify(source.context.acceptance.filter((_text, index) => !excluded.includes(index + 1)))}\n` +
    (excluded.length ? `原验收第 ${excluded.join('、')} 条历史记录已结案，不再核验，即使在原始任务书中看到也跳过。\n` : '') +
    `已记录的产物路径：${JSON.stringify(productPaths(source))}\n` +
    `重点：${focus || '优先核对关键结论、数字和引用。'}\n` +
    (required.length ? `先核对必验的原验收第 ${required.map(item => item.index).join('、')} 条，再抽查其余结论。逐条运行允许的只读检查或回查原始运行记录；evidence 写观测结果和可定位的来源，只有自报或静态推断时记 blocked。\n` : '') +
    `独立抽查 ${samples} 条带出处的结论；不足 ${samples} 条则全部核对，并说明实际条数。不要只复述原报告。\n` +
    `逐条回到原始出处，检查原文、上下文、数字与计算；找不到出处、出处不支持结论时明确说无法确认，不要猜测。\n` +
    `criteria 只按验收标准逐条给出，条数与验收标准相同，不要为每条抽查结论另加一行。抽查的每条结论写在第 ${sampleEvidenceRow} 条验收的 evidence 里，各占一行：` +
    `核对的结论；出处（文件与行号或可定位的来源）；是否属实（属实/不属实/无法确认）；不属实时实际是什么。\n` +
    `按 report.v2.schema.json 返回；第 ${sampleEvidenceRow} 条在有结论不属实时记 not_met，没有不属实但有无法确认时记 blocked，并说明缺少什么；summary 汇总抽查数和结果。\n` +
    `这是只读核验，项目写入范围为空。预期从原任务目录实际运行验收检查，允许产生临时文件和测试缓存。` +
    (source.sandbox === 'danger-full-access' ? '将临时文件和测试缓存放到项目外的临时目录。' : '将临时文件和测试缓存放到 TMPDIR。') +
    `保持项目、产物、日志和系统状态不变；需要在项目内写入或改变系统状态的检查应报告其限制。files_changed 必须为 []。`;
}

// 不在 scope 内的改动；没给 scope 或 runner 没给出改动清单时返回 undefined
export function outOfScope(value, cwd, scope) {
  if (!scope?.length || !Array.isArray(value.files_changed)) return undefined;
  const roots = scope.map(p => taskScopePath(cwd, p));
  return value.files_changed.map(f => f.path).filter(p => !roots.some(r => under(taskScopePath(cwd, p), r)));
}

function widensOverlappingScope(previousCwd, original, cwd, requested) {
  if (!original?.length) return false;
  if (!requested?.length && normPath(previousCwd) === normPath(cwd)) return true;
  const before = original.map(p => taskScopePath(previousCwd, p));
  const after = requested?.length ? requested.map(p => taskScopePath(cwd, p)) : [normPath(cwd)];
  return after.some(p => before.some(r => under(p, r) || under(r, p))) &&
    after.some(p => !before.some(r => under(p, r)));
}

// 外部看门狗通过 send-request 补发的固定话术。
const AUTOMATIC_TEXTS = new Set(['继续']);
export function hasUserReply(log, job, owner, autoMessage) {
  const text = (e) => (Array.isArray(e.data?.content) ? e.data.content : []).filter(c => c?.type === 'text').map(c => c.text).join('\n');
  // autoResume submits its restart notice with the user source; nobody answered anything.
  // 插件自己代发的续接、看门狗补发的“继续”都不是用户回复（宿主提问的自动代答 kind 是 user-question-reply，本来就不算）。
  const user = log.findLastIndex(e => e.type === 'user/message' && e.data?.source?.kind === 'user' &&
    e.data.source.via !== 'codex-conductor' && !(autoMessage && text(e) === autoMessage) && !AUTOMATIC_TEXTS.has(text(e).trim()));
  if (user < 0) return false;
  const replyAt = log[user].at ?? log[user].time;
  const review = job.verification;
  if (review?.blockers?.length && Number.isFinite(review.time) &&
      (!Number.isFinite(replyAt) || replyAt <= review.time * 1000)) return false;
  const label = `Codex ${job.job_id}`;
  const native = log.findLast(e => e.type === 'job/registered' && e.data?.kind === 'codex' && e.data.owner === owner &&
    (e.data.label === label || e.data.label?.startsWith(`${label} · `)));
  const settled = native?.data?.jobId && log.findLastIndex(e => e.type === 'job/settled' && e.data?.jobId === native.data.jobId);
  return Number.isInteger(settled) && settled >= 0 ? user > settled :
    Number.isFinite(replyAt) && Number.isFinite(job.finished_at) && replyAt > job.finished_at * 1000;
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_REASONS = ['concurrency_or_locking', 'cross_session_state', 'security_boundary', 'data_migration', 'prior_rework'];
const defaultEffort = (cfg, write) => write === true ? cfg.effort : cfg.readOnlyEffort || cfg.effort;

export function validateRun(args) {
  checkEngine(args?.engine);
  if (typeof args?.task !== 'string' || args.task.trim().length < 10) throw new Error('codex_run: task 必须写清目标、相关路径和约束（至少 10 个字符）');
  if (!Array.isArray(args.acceptance) || args.acceptance.length === 0 ||
    args.acceptance.some((a) => typeof a !== 'string' || a.trim().length < 4)) {
    throw new Error('codex_run: acceptance 必须是至少 1 条可核验的验收标准（每条至少 4 个字符，条数不限）');
  }
  if (args.must_verify !== undefined && (!Array.isArray(args.must_verify) ||
    args.must_verify.some(i => !Number.isInteger(i) || i < 1 || i > args.acceptance.length))) {
    throw new Error(`codex_run: must_verify 必须是验收条目编号数组，编号为 1–${args.acceptance.length} 的整数`);
  }
  const validIndex = index => Number.isInteger(index) && index >= 1 && index <= args.acceptance.length;
  if (args.expect_blocked !== undefined && (!Array.isArray(args.expect_blocked) || !args.expect_blocked.every(validIndex))) {
    throw new Error('codex_run: expect_blocked 必须是验收条目编号数组');
  }
  if (args.acceptance_needs !== undefined && (!Array.isArray(args.acceptance_needs) ||
      args.acceptance_needs.some(entry => !validIndex(entry?.index) || !Array.isArray(entry.steps) ||
        !entry.steps.length || entry.steps.some(step => typeof step !== 'string' || !step.trim())))) {
    throw new Error('codex_run: acceptance_needs 必须列出验收条目编号 index 和非空步骤名称数组 steps');
  }
  // 不传就默认只读时，实际常因此白跑一整轮（只读任务又不能 resume），所以必须明说
  if (typeof args.write !== 'boolean') {
    throw new Error('codex_run: write 必须是布尔值 true 或 false（不能省略，也不能写成字符串）：要改文件、做修复或建备份传 true，只读调查传 false');
  }
  for (const k of ['cwd', 'resume', 'effort', 'rerun_after_change']) {
    if (args[k] !== undefined && (typeof args[k] !== 'string' || !args[k].trim())) throw new Error(`codex_run: ${k} 必须是非空字符串`);
  }
  if (args.wait_seconds !== undefined && (!Number.isInteger(args.wait_seconds) || args.wait_seconds < 0)) {
    throw new Error('codex_run: wait_seconds 必须是非负整数');
  }
  for (const k of ['scope', 'writable_roots', 'required_writes']) {
    if (args[k] !== undefined && (!Array.isArray(args[k]) || args[k].length > 50 ||
      args[k].some((s) => typeof s !== 'string' || !s.trim()))) {
      throw new Error(`codex_run: ${k} 必须是不超过 50 个非空路径`);
    }
  }
  if (args.writable_roots?.length && args.write !== true) throw new Error('codex_run: writable_roots 需要 write=true');
}

// 执行完成不等于独立验收通过；模型自报全 met 仍需规划端核验。
export function reviewState(value) {
  const report = Object.hasOwn(value, 'structured') ? value.structured : value.report;
  const counts = { met: 0, not_met: 0, blocked: 0 };
  const criteria = Array.isArray(report?.criteria) ? report.criteria : [];
  for (const item of criteria) if (Object.hasOwn(counts, item?.status)) counts[item.status]++;
  const valid = validReport(report);
  const unknown = unknownState(value);
  const execution = unknown ? 'unknown' : value.error_kind === 'schema_invalid' ? 'completed' : value.status;
  const pending = execution === 'running';
  const reportStatus = unknown ? 'missing' : pending ? 'pending' : value.error_kind === 'schema_invalid' || value.report_status === 'invalid' ? 'invalid'
    : report === undefined ? 'missing' : valid ? 'valid' : 'invalid';
  const expected = value.acceptance ?? value.context?.acceptance;
  const attention = execution !== 'completed' || reportStatus !== 'valid' || counts.not_met > 0 || counts.blocked > 0 ||
    report?.unresolved?.length > 0 || report?.deviations?.length > 0 || report?.blockers?.length > 0 || value.out_of_scope?.length > 0 ||
    (Array.isArray(expected) && expected.length !== criteria.length);
  return { execution_status: execution, report_status: reportStatus,
    review_status: pending ? 'pending' : attention ? 'needs_attention' : 'needs_verification', criteria_counts: counts };
}

// 将 runner 的规范化路径用于范围检查，并把 structured 汇报改名为 report。
// schema_invalid 的执行回合已结束，保留原始答复并把报告标为无效，等待独立核验。
export function withReport(value) {
  const { structured, ...rest } = value;
  if (rest.context?.acceptance) rest.acceptance = rest.context.acceptance;
  const outside = outOfScope(rest, rest.cwd, rest.scope_paths);
  if (outside) rest.out_of_scope = outside;
  Object.assign(rest, reviewState({ ...rest, ...(structured !== undefined ? { structured } : {}) }));
  if (rest.status === 'failed' && rest.error_kind === 'schema_invalid') {
    const { error_kind: _kind, error, retryable: _retryable, ...done } = rest;
    const prefix = 'Final message is not valid JSON: ';
    const detail = typeof error === 'string' && error.startsWith(prefix) ? `\nJSON 解析错误：${error.slice(prefix.length)}` : '';
    const value = { ...done, status: 'completed', report_note: 'Codex 没按 JSON 格式逐条汇报，核验时以 final_message 和实际文件为准。' + detail };
    return { ...value, blocking: blockingState(value) };
  }
  if (structured === undefined) return { ...rest, blocking: blockingState(rest) };
  const lists = ['criteria', 'files_changed', 'deviations', 'unresolved'];
  if (!structured || typeof structured !== 'object' || Array.isArray(structured) ||
      lists.some((key) => structured[key] !== undefined && !Array.isArray(structured[key])) ||
      (structured.criteria ?? []).some((c) => !c || typeof c !== 'object' || Array.isArray(c))) {
    return { ...rest, blocking: blockingState(rest), report_note: 'Codex 汇报字段格式不正确，核验时以 final_message 和实际文件为准。' };
  }
  const normalized = { ...rest, report: structured };
  return { ...normalized, blocking: blockingState(normalized) };
}

// 执行端只是停下来等规划端回答：阻塞全是会进 blocking.questions 的种类，没有 not_met，must_verify 条目都没报 met。
// 这时核验只能确认“在等回答”，还会让续接等它结束。
function awaitingAnswers(value) {
  const { blockers, questions } = blockingState(value);
  const rows = value.report.criteria;
  return blockers.length > 0 && questions.length === blockers.length && rows.every(row => row.status !== 'not_met') &&
    (value.context.must_verify ?? []).every(index => reportRowOf(value.context.acceptance, rows, index)?.status === 'blocked');
}

const RECORD_REVIEW = '核验后用 codex_review 按原验收标准逐条记录证据：全部通过用 verified，有明确差距用 needs_changes，逐条通过且用户明确接受已列出的偏差时用 accepted_deviations。';
const PLANNER_ANSWERS = '按用户原始目标和已有事实自行回答，并在给用户的汇报里写明替用户做了哪些决定；拿不准，或回答意味着删除数据、改动用户没提过的目录时，仍然先问用户。';
const USER_REPORT = '向用户汇报时先用大白话说明完成情况、核对结果和剩余问题，不必带任务号和内部状态名。';
const WAIT_GUIDANCE = '① 派齐本批：同一回合用 wait_seconds: 0 派出已就绪且护栏允许的独立只读调查（write=false）和 codex_verify，记 runner job_id，能并列调用就并列。' +
  '有依赖、写同目录或改变同一真机、虚拟机、服务状态的任务须串行。' +
  '② 等待与验收：留在本轮，先验收已收到的报告，再选一单用 codex_status（wait_seconds: 3600），其余单继续跑。报告有缺才用 job_output 或 codex_output 补读。';
const waitForJob = (jobId) => `先派齐本批获准的独立只读调查和核验，再留在本轮一次等一单，例如 codex_status(${JSON.stringify({ job_id: jobId, wait_seconds: 3600 })})。` +
  '其余单继续跑。先验收已收到的报告，再等尚未完成的单，勿零等待轮询或重派。';
const RERUN_AFTER_CHANGE = { type: 'string', minLength: 1,
  description: '外部条件已经改变时填写具体变化（例如用户修好了虚拟机），允许本次重新运行此前反复失败的步骤。' };
const minutes = seconds => Math.round(seconds / 60);
const EXPECT_BLOCKED = { type: 'array', items: { type: 'integer', minimum: 1 },
  description: '预计在本环境无法完成的验收条目编号（从 1 起）。执行端直接标 blocked 并说明环境原因。' };
const ACCEPTANCE_NEEDS = { type: 'array', items: { type: 'object', additionalProperties: false,
  properties: { index: { type: 'integer', minimum: 1 }, steps: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } } },
  required: ['index', 'steps'] }, description: '显式声明验收条目依赖的步骤名称（Verb-Noun 或脚本文件名），派单时提示本目录的近期重复失败。' };
const SCRIPT_EXTENSIONS = new Set('ps1 psm1 psd1 py pyi sh bash zsh fish js mjs cjs ts jsx tsx bat cmd rb pl php lua'.split(' '));
const stepWords = step => (step.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(word => !SCRIPT_EXTENSIONS.has(word));
function predispatchWarnings(args, cwd, parent, repeat) {
  if (repeat?.status !== 'completed') return [];
  const warnings = new Set();
  const report = parent?.report ?? parent?.structured;
  const previous = parent?.predispatch ?? (validReport(report) && report.blockers?.some(blocker => blocker.kind === 'environment')
    ? { acceptance: parent.context?.acceptance, criteria: report.criteria } : undefined);
  if (parent?.cwd && normPath(parent.cwd) === normPath(cwd) && previous && Number.isFinite(parent.finished_at) &&
      Number.isFinite(repeat._changed_at) && repeat._changed_at <= parent.finished_at) {
    args.acceptance.forEach((criterion, i) => {
      if (criterion === previous.acceptance?.[i] && reportRowOf(previous.acceptance, previous.criteria, i + 1)?.status === 'blocked') {
        warnings.add(`第 ${i + 1} 条在本环境上一轮已受阻且之后无改动：要么改验收项，要么先解决环境，要么在派单时用 expect_blocked 标出这一条`);
      }
    });
  }
  for (const { index, steps } of args.acceptance_needs ?? []) {
    for (const word of new Set(steps.flatMap(stepWords))) {
      const hash = createHash('sha1').update(word).digest('hex').slice(0, 8);
      const failure = repeat.standing?.find(entry => entry.words?.includes(hash));
      if (failure) warnings.add(`第 ${index} 条依赖的步骤 ${word} 在本目录近期反复失败（${failure.failures} 次、约 ${minutes(failure.seconds)} 分钟）：先解决环境、改验收项，或用 expect_blocked 标出这一条`);
    }
  }
  return [...warnings];
}
function repeatStandingLine(standing) {
  if (!standing?.length) return '';
  const failures = standing.reduce((sum, step) => sum + step.failures, 0);
  const seconds = standing.reduce((sum, step) => sum + step.seconds, 0);
  return `这个目录有 ${standing.length} 个步骤近期反复失败（共 ${failures} 次、约 ${minutes(seconds)} 分钟），环境问题未解决前，依赖它们的工作会被拦下。`;
}
function repeatBlockLine(blocks) {
  if (!blocks?.length) return '';
  // 整理报告时同一步骤还可能被拦一次，此前的失败只计一份。
  const prior = [...new Map(blocks.map(block => [block.step, block])).values()];
  const failures = prior.reduce((sum, block) => sum + block.prior_failures, 0);
  const seconds = prior.reduce((sum, block) => sum + block.prior_seconds, 0);
  return `runner 拦下了重复运行同一个失败步骤 ${blocks.length} 次（此前已失败 ${failures} 次、约 ${minutes(seconds)} 分钟）；` +
    '依赖它的验收项应记 blocked（environment 或 user_input），不要再派同样依赖它的任务；外部情况已经改变时，下一单带 rerun_after_change 写明改变了什么。';
}
const SERVICE_FAILURE = new Map([
  ['reconnect_timeout', 'Codex 重连超时'], ['router_down', 'Codex 本地路由不可达'],
  ['idle_timeout', 'Codex 执行空闲超时'], ['transient', '模型服务或连接暂时异常'],
  ['timeout', 'Codex 执行达到总超时，runner 不自动重试'],
  ['sandbox_setup_failed', 'Windows Codex 沙箱初始化失败，命令未启动'],
]);

function failureReceipt(value, cause) {
  const attempts = value.attempts ?? value.attempt;
  const files = value.files_changed_total ?? value.files_changed?.length;
  return `${cause}。${attempts == null ? '尝试次数未记录' : `runner 共尝试 ${attempts} 次`}，` +
    (files == null ? '文件改动数未记录。' : `记录的文件改动共 ${files} 个。`) +
    (files > 0 ? '先用 git status 或对比文件确认现状。' : '');
}

// resumed：这次是否带了 resume；codex_status 不知道时传 undefined，按 runner 有没有给 thread_id 判断
// readOnly：这次是不是只读任务；host_access=true、write=false 的任务沙箱是 danger-full-access，只能由调用方告知
export function nextStep(value, acceptance, resumed, { readOnly = value.context?.write === false || value.sandbox === 'read-only', plannerAnswers = false, plannerReads = 'open', ownerDecisions } = {}) {
  const blocking = blockingState(value);
  if (blocking.next_action === 'done') return `独立核验已记录（${value.verification_status}）。本轮已关闭；完整依据可用 codex_output artifact=review 重读。`;
  if (value.error_kind === 'provider_permanent') {
    const target = value.context?.verification_of;
    return `Gemini 提供方无法执行：${String(value.error ?? '请核对账号、模型和额度').slice(0, 300)}。` +
      (target ? `用 codex_verify 对 ${target} 显式传 engine: "codex" 重新核验。`
        : '先核对已有产物，再按原授权用 codex_run 显式传 engine: "codex" 重新派单，只补缺项。');
  }
  if (jobEngine(value) === 'gemini' && value.error_kind === 'bad_arguments') {
    const error = String(value.error ?? '请核对 agy 参数和任务权限').slice(0, 300);
    return `Gemini 启动参数无效：${error}。` + (/local Windows drive path/.test(error)
      ? '该目录不在 Windows 盘符下，Windows 上的 agy 进不去；改用 engine: "codex" 重新派单或核验。' : '');
  }
  if (value.error_kind === 'executor_lost') {
    const resume = value.thread_id ? `，或用 codex_continue ${value.job_id} 在原线程续接（fresh=false）` : '';
    return `任务 ${value.job_id} 的执行环境中断（${value.lost_reason}：WSL 重启或执行进程退出），没有生成报告。` +
      `先核对已有产物（codex_output artifact=diff/events），再按原任务重新派单${resume}；不要当作失败结论处理。`;
  }
  if (value.error_kind === 'verification_tree_changed') {
    return '主机核验期间受核验范围的 Git 状态、索引或文件内容发生变化，核验失败。请核对仓库改动来源和现状，勿使用本轮核验结论。';
  }
  if (value.status === 'completed' && value.context?.verification_of && value.report_status !== 'invalid') return `对原任务 ${value.context.verification_of} 的独立核验已结束。` +
    (value.verification_integrity === 'concurrent_changes' ? '检测到范围外或与其他任务重叠的仓库变化，请核对验收证据。'
      : value.verification_integrity === 'unavailable' ? 'Git 状态完整性比对不可用（例如非 Git 目录或查询超时）。' : '') +
    (value.verification_unchecked_files > 0 ? `有 ${value.verification_unchecked_files} 个文件的内容未比对，请核对对应验收证据。` : '') +
    `先机械核对抽查条数、出处与证据是否齐全，再按原任务验收标准用 codex_review 记录原任务 ${value.context.verification_of}（核验任务本身不复核、不再核验）；发现不属实或无法确认的结论时记录差距，不把核验结束当作全部通过。`;
  if (plannerReads === 'products') return nextStep(value, acceptance, resumed, { readOnly, plannerAnswers, ownerDecisions })
    .replace('用只读检查逐条核验', '先对产物做机械核对，逐条检查')
    .replace('先用 git status 或对比文件确认现状', '先用 git status 核对文件列表，内容核对交给 codex_verify')
    .replace('再用 git status 或对比文件核对已有产物', '再用 git status 核对产物列表，内容核对交给 codex_verify') +
    '\n任务结束后只做机械核对：产物在不在、结论有没有带出处、数字对不对得上；内容是否属实用 codex_verify 交给独立 Codex 核验。';
  acceptance ??= value.acceptance ?? value.context?.acceptance;
  const recordReview = plannerAnswers
    ? RECORD_REVIEW.replace('用户明确接受已列出的偏差时', '已列出的偏差符合用户原始目标和已有事实时') + PLANNER_ANSWERS : RECORD_REVIEW;
  if (!value.job_id && unknownState(value)) {
    return '这次未取得任务编号，无法确认 Codex 是否已经启动。先用 codex_jobs 按相同任务目录和原任务核对近期记录，找回 job_id 后再查状态，不要直接重派。';
  }
  if (value.job_id && unknownState(value)) {
    return `当前未取得可信状态或报告，Codex 任务 ${value.job_id} 可能仍在运行。` +
      `用 codex_jobs 核对正确 job_id；先用 codex_status 查询，不要直接重派。`;
  }
  if (value.status === 'failed' && value.error_kind === 'repeated_failure') {
    return failureReceipt(value, 'runner 拦下了重复失败的步骤（repeated_failure，不自动重试）') +
      '不要原样重派。可用 codex_review 验收已有结果，把依赖项记为 blocked（environment 或 user_input）。' +
      '需要继续时先修复环境，外部条件改变后在下一单用 rerun_after_change 写明变化。';
  }
  if (value.status === 'running') {
    if (value.phase === 'engine_wait') return `任务 ${value.job_id} 正在排队等 Gemini 名额（同时运行的 Gemini 任务已满），尚未启动。${waitForJob(value.job_id)}不要重复派活。`;
    if (value.phase === 'lock_wait') return `任务 ${value.job_id} 正在等待同目录写锁，尚未启动 Codex。${waitForJob(value.job_id)}需要退出队列时用 codex_cancel，只取消本任务，不要重复派活。`;
    if (value.phase === 'codex_reconnecting') return `任务 ${value.job_id} 正在重连模型服务。${waitForJob(value.job_id)}不要重复派活。`;
    return `任务 ${value.job_id} 仍在执行。${waitForJob(value.job_id)}不要自己动手补做。`;
  }
  // 取消会保留恢复信息，但不会重建中断前的改动清单。
  if (value.status === 'cancelled') {
    if (value.phase === 'lock_wait') return '已取消排队，尚未启动 Codex；没有取消持锁任务。不要自行恢复或重派。';
    if (value.phase === 'engine_wait') return '已取消排队，Gemini 尚未启动；没有取消其他任务。不要自行恢复或重派。';
    return 'Codex 任务已取消（用户停止、会话归档或调用中止）：不要自行续跑或重派，先问用户。' +
      '如果这是可写任务，取消前可能已改了部分文件且没有改动清单，核验前先用 git status 或对比文件确认现状。';
  }
  const report = value.report ?? {};
  const original = sameCriteria(report, acceptance);
  const list = !original && Array.isArray(acceptance) ? acceptance.map((a, i) => `${i + 1}. ${a}`).join('\n') : '';
  const reportIssue = value.error_kind === 'incomplete' ? '缺少任务完成报告（incomplete）'
    : value.error_kind === 'schema_invalid' || (value.status === 'completed' && value.report_status === 'invalid') ? '报告格式不合格（schema_invalid）' : '';
  if (reportIssue) return failureReceipt(value, reportIssue) +
    '工作可能已做。缺内容时用 codex_output（artifact=report）补读，再用 codex_verify 按原验收标准核验已有产物，不要原样重派。' +
    recordReview + (list ? `\n原验收标准：\n${list}` : '');
  if (value.status === 'completed' || blocking.blockers.length || ['verified', 'accepted_deviations', 'needs_changes', 'invalid'].includes(value.verification_status)) {
    if (blocking.next_action === 'ask_user') {
      const environment = blocking.blockers.some((b) => b.kind === 'environment');
      const guidance = ownerDecisions === 'planner'
        ? '按所有者的常设授权，依据当前目标选方案，用 codex_continue 提交 answers（包含选定方案、理由及放弃的方案）或 resolution。' +
          '不可逆数据变更、对外动作、花钱、账号凭据及扩大安全边界留给所有者。' +
          (environment ? '同时用 resolution 说明环境条件已满足的证据。' : '') + '\n'
        : plannerAnswers
        ? PLANNER_ANSWERS + (environment
          ? '同时核实报告里的环境解除条件；答案齐全且条件已满足后，用 codex_continue 同时提交 answers 和 resolution，resolution 写明条件已满足的具体证据。条件未齐备时先不要续接；不要重复派活：\n'
          : '用 codex_continue 提交 answers；不要重复派活：\n')
        : environment
        ? '先向用户提出以下具体问题，同时核实报告里的环境解除条件。取得回答且条件已满足后，用 codex_continue 同时提交 answers 和 resolution，resolution 写明条件已满足的具体证据。条件未齐备时先不要续接；不要重复派活或替用户决定：\n'
        : '先向用户提出以下具体问题，取得回答后用 codex_continue 提交 answers；不要重复派活或替用户决定：\n';
      return guidance + blocking.questions.map((q) => `${q.id}: ${q.question}`).join('\n');
    }
    if (blocking.next_action === 'wait_condition') return '当前受环境条件阻塞。先说明 blockers 中的解除条件；条件改变并取得证据后，用 codex_continue 的 resolution 说明事实再续跑，不要原样重试。';
    if (blocking.next_action === 'inspect_report') return '报告或任务状态仍需核对。先读完整报告和实际状态，按原验收标准逐条核对。对照原任务范围区分真实缺口与已说明的验证边界；边界说明本身不自动增加补做要求。确有遗留问题时，再查清需要用户回答、环境变化还是实现修正；不能把未知原因当实现问题重复派活。\n' +
      recordReview +
      (value.out_of_scope?.length ? `\n范围外改动待核实：${value.out_of_scope.join('、')}。快照也可能包含其他进程写的文件，先核实归属，不能仅凭快照认定 Codex 越界。` : '') +
      (list ? `\n原验收标准：\n${list}` : '');
    if (blocking.next_action === 'resume_fix') return '已有明确实现差距。用 codex_continue 续接原任务，它会保留原目录、验收、write、scope 和主机权限；不得借修正扩大授权。';
  }
  if (value.status !== 'completed') {
    if (value.error_kind === 'model_refused') {
      return failureReceipt(value, '执行模型拒绝了这单（model_refused，终态）') +
        '不要原样重派。可回看任务书有无与目标无关的内容、是否写清目的，或把影响告诉用户，由用户决定下一步。';
    }
    if (value.error_kind === 'upstream_rejected') {
      return failureReceipt(value, '模型服务拒收请求（upstream_rejected，runner 不自动重试）') +
        '先查明拒收原因并核对完成情况，确认有缺项再按原授权补做。不要用 resume 续这条线程或原样重派。';
    }
    if (value.error_kind === 'lock_timeout') {
      return failureReceipt(value, '等待写锁超时，尚未启动 Codex') +
        '先用 codex_jobs 查询同目录正在运行的任务，再决定等待还是用 codex_cancel 取消持锁任务；不要直接重派。';
    }
    // 只读任务用 --ephemeral 运行；只有它续跑的持久线程还能续。
    const thread = (value.sandbox !== 'read-only' || resumed !== false) && value.thread_id;
    const resume = value.conversation_id ? '沿用原授权，用 codex_continue(job_id) 续接，只补缺项。'
      : thread ? '沿用原授权，用 codex_run 的 resume 填原 thread_id，传 fresh=false 续接，只补缺项。' : '按原授权补做缺项。';
    if (value.error_kind === 'worker_died') {
      const check = readOnly ? '先按原验收核对已有产物。'
        : '退出前可能已改了部分文件。先用 codex_output（artifact=context）取回原验收标准，再用 git status 或对比文件核对已有产物。';
      return failureReceipt(value, '执行进程已中断（worker_died）') + check +
        (value.residual_codex_pid ? '先确认残留的 Codex 进程已结束，再决定下一步。' : `确认有缺项后，${resume}`);
    }
    const cause = SERVICE_FAILURE.get(value.error_kind) ?? `Codex 任务失败（${value.error_kind ?? '原因未记录'}）`;
    if (value.retryable) return failureReceipt(value, cause) +
      `先确认故障解除并核对已有产物。确认有缺项后，${resume}不要原样重派。`;
    return failureReceipt(value, cause) +
      '先用大白话说明哪一步没做成和实际影响，必要时附原始错误。核对已完成项后再决定下一步，不要原样重派。';
  }
  const alerts = [
    report.deviations?.length ? `Codex 自报偏离计划：${report.deviations.join('；')}` : '',
    value.out_of_scope?.length ? `改动超出 scope：${value.out_of_scope.join('、')}。这份清单来自目录快照，可能含同时段其他进程写的文件（如定期日志）；` +
      '不在 Codex 自报 files_changed 里、明显来自其他进程的，只需一句说明，不算 Codex 越界，也不用请用户决定；其余的先核实是否应保留；' +
      '总是由其他进程写的文件，可以请用户写进插件配置 ignoreChanges，以后不再列出' : '',
  ].filter(Boolean);
  const where = original ? '上面逐条汇报里的验收标准' : list ? '下面的验收标准' : '验收标准';
  return (alerts.length ? `${alerts.join('\n')}\n${plannerAnswers ? PLANNER_ANSWERS : '偏离或冲突需要用户取舍的，先向用户说明，不要替用户选。'}\n` : '') +
    `Codex 的答复不是完成证据。用只读检查逐条核验${where}，给出每条的证据；` +
    recordReview +
    `有差距时先记录 needs_changes，再用 codex_continue 在原权限内修正。${list ? `\n${list}` : ''}`;
}

const MARK = { met: '✓', not_met: '✗', blocked: '⛔' };
// 每条证据最多显示的字数：Codex 的答复本来就不是完成证据，全文留在 runner 任务目录的 last_message.txt
const EVIDENCE_LIMIT = 800;

function continuationError(message) {
  return new Error(`续接未启动：${message}\ncontinuation_ready=false`);
}

// 一行摘要，任务表的 detail 和结果第一行都以它开头，如 completed · 12 met / 1 blocked · 3 files · 148 s
function summaryLine(value) {
  const criteria = value.report?.criteria ?? [];
  const counts = Object.keys(MARK).map((s) => [s, criteria.filter((c) => c.status === s).length])
    .filter(([, n]) => n).map(([s, n]) => `${n} ${s}`).join(' / ');
  const files = value.files_changed_total ?? value.files_changed?.length;
  const done = value.status === 'completed';
  const summary = [String(value.status), done ? counts : value.error_kind, done && files !== undefined && `${files} files`,
    typeof value.duration_s === 'number' && `${Math.round(value.duration_s)} s`,
    ['verified', 'accepted_deviations'].includes(value.verification_status) && `已核验 ${value.verification_status}`,
    done && !['verified', 'accepted_deviations'].includes(value.verification_status) && value.review_status === 'needs_attention' && '待关注',
    done && !['verified', 'accepted_deviations'].includes(value.verification_status) && value.review_status === 'needs_verification' && '待核验',
    done && value.verification_status === 'needs_changes' && '核验待修',
    done && value.report_status === 'invalid' && '报告异常'].filter(Boolean).join(' · ');
  return value.continuation_ready === false
    ? `续接未启动：${value.next?.split('\n')[0]} · continuation_ready=false\n原任务状态：${summary}` : summary;
}

// 结果文字里列出的改动文件数上限；一单常有上百个证据文件，全列会让每次 codex_status 多出上万字
const FILES_SHOWN = 30;

// 已完成的结果只留核验用得上的：任务目录和一行改动清单；失败、取消、仍在执行的保留全部字段，便于排查。
// 用量、日志目录等完整字段在 runner 的 result.json（runnerHome/jobs/<job_id>/）里
function details(rest) {
  if (rest.status !== 'completed') {
    const value = { ...rest };
    if (value.context) value.context = { owner: value.context.owner, write: value.context.write, task: taskLine(value.context, 120),
      ...(value.context.verification_of ? { verification_of: value.context.verification_of } : {}) };
    return [JSON.stringify(value, null, 2)];
  }
  // runner 最多列 300 条，总数照实给；文字里只列前 FILES_SHOWN 条，超出 scope 的改动由 outOfScope 单独列出
  const shown = rest.files_changed?.length;
  const total = rest.files_changed_total ?? shown;
  const listed = rest.files_changed?.slice(0, FILES_SHOWN);
  const files = Array.isArray(rest.files_changed) && `改动文件（${rest.files_changed_source ?? '来源未知'}，共 ${total} 个` +
    `${total > shown ? `，只列出前 ${shown} 个，超出 scope 的检查也只看这些，其余的到任务目录里核对` : ''}）：` +
    (listed.map((f) => `${f.path}(${f.change})`).join('、') || '无') +
    (shown > listed.length ? `；此处只显示前 ${listed.length} 个，完整清单用 codex_output（artifact: "result"）查看` +
      (rest.out_of_scope?.length ? `；其中超出 scope 的：${rest.out_of_scope.join('、')}` : '') : '');
  return [rest.cwd && `任务目录：${rest.cwd}`, files,
    rest.continuation_ready === false && 'continuation_ready=false',
    rest.context?.verification_of && `独立核验任务；核验对象：${rest.context.verification_of}`,
    rest.execution_status && `执行：${rest.execution_status}；报告：${rest.report_status}；执行端自报检查：${rest.review_status}`,
    rest.verification_status && `独立核验：${rest.verification_status}${rest.verification?.reviewer ? `；核验人：${rest.verification.reviewer}` : ''}`,
    rest.verification_error && `核验记录异常：${rest.verification_error}`,
    rest.verification?.notes && `核验说明：${rest.verification.notes}`,
    ...(rest.verification?.criteria ?? []).map((c) => `核验第 ${c.index} 条 ${c.status}：${c.evidence}`),
    rest.usage && `用量（${rest.usage_scope ?? '统计范围未知'}，不是费用）：${JSON.stringify(rest.usage)}`,
    ...(rest.ignore_warnings ?? []),
    rest.final_message_repaired?.length && `报告的 JSON 经转义修复（${[rest.final_message_repaired].flat().join('、')}）后才解析成功：` +
      `证据里带反斜杠的路径或正则可能与原文不同，以 ${rest.log_dir ? `${rest.log_dir}/last_message.txt` : 'last_message.txt'} 原文为准。`,
    rest.report_note].filter(Boolean);
}

function render(value) {
  // 后台任务结算时存下的成品文字，原样交回
  if (typeof value?.rendered === 'string') return [{ type: 'text', text: value.rendered }];
  // acceptance 不放进详细字段：逐条汇报或下一步里已列出
  const { final_message: answer, report, next, acceptance, resubmit, ...rest } = value ?? {};
  const executor = jobEngine(rest) === 'gemini' ? 'Gemini' : 'Codex';
  const full = rest.log_dir ? `${rest.log_dir}/last_message.txt` : 'runner 任务目录里的 last_message.txt';
  // 不合 schema 的汇报（如 evidence 为 null）也要能显示；截断处不留半个代理对
  const clip = (v) => {
    const s = typeof v === 'string' ? v : String(v ?? '');
    return s.length > EVIDENCE_LIMIT ? `${s.slice(0, EVIDENCE_LIMIT).replace(/[\uD800-\uDBFF]$/, '')}…（已截断，全文见 ${full}）` : s;
  };
  const original = sameCriteria(report, acceptance);
  const reportLines = report ? [
    `--- ${executor} 逐条汇报（保留原记录）---`, `概述：${report.summary ?? ''}`,
    ...(report.criteria ?? []).map((c, i) => `${MARK[c.status] ?? '?'} ${i + 1}. ${original ? acceptance[i] : c.criterion} —— ${clip(c.evidence)}`),
    `自报改动：${report.files_changed?.join('、') || '无'}`,
    `偏离计划：${report.deviations?.join('；') || '无'}`,
    `未解决：${report.unresolved?.join('；') || '无'}`,
  ] : [];
  const extra = details(rest);
  const blockers = value?.blocking ?? blockingState(value);
  return [{ type: 'text', text: [
    `${summaryLine(value ?? {})}${rest.job_id ? `  job_id: ${rest.job_id}` : ''}${rest.thread_id ? `  thread_id: ${rest.thread_id}` : ''}` +
      (executor === 'Gemini' ? `  engine: gemini${rest.conversation_id ? `  conversation_id: ${rest.conversation_id}` : ''}` : ''),
    ...(report ? reportLines
      : answer ? [`--- ${executor} 最终答复${rest.truncated ? `（超过 8000 字已截断，全文见 ${full}）` : ''} ---`, answer] : []),
    ...(extra.length ? ['--- 详细字段 ---', ...extra] : []),
    ...(blockers.blockers.length ? ['--- 阻塞与待回答问题 ---', ...blockers.blockers.map((b) =>
      `${b.id} [${b.kind}] ${b.message}${b.question ? `\n需要回答：${b.question}` : ''}${b.resolution ? `\n解除条件/已有信息：${b.resolution}` : ''}`)] : []),
    ...(resubmit ? [`可填好后提交：codex_continue ${JSON.stringify(resubmit)}`] : []),
    ...(next ? ['--- 下一步 ---', next, USER_REPORT] : []),
  ].join('\n') }];
}

// 这一轮的最后一条回复文字，以及调用过的工具名（tool_call 间接调用按其参数里的真实工具名算）
export function turnSummary(log, turn) {
  let text = '';
  const tools = [];
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    const t = e?.data?.turn;
    if (t === undefined) continue;
    if (t < turn) break;
    if (t !== turn) continue;
    if (e.type === 'tool/call') {
      tools.push(e.data.name);
      if (e.data.name === 'tool_call') tools.push(...(String(e.data.arguments).match(/codex_\w+/g) ?? []));
    } else if (e.type === 'assistant/message' && !text) {
      text = (e.data.message?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    }
  }
  return { text, tools };
}

const OUTPUT = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => render(value) };

// codex_review 写入后的回执：规划端刚看过报告、刚写完验收，不再把整份报告、改动清单和它自己的核验证据原样回显，
// 只留结案状态、仍待回答的阻塞和下一步。完整内容仍可用 codex_status / codex_output 读取。
function renderReview(value) {
  if (typeof value?.rendered === 'string') return [{ type: 'text', text: value.rendered }];
  const blockers = value?.blocking ?? blockingState(value);
  const recorded = value?.verification_status ? `已记录独立核验：${value.verification_status}` +
    (value.verification?.reviewer ? `（核验人：${value.verification.reviewer}）` : '') : '';
  return [{ type: 'text', text: [
    `${summaryLine(value ?? {})}${value?.job_id ? `  job_id: ${value.job_id}` : ''}${value?.thread_id ? `  thread_id: ${value.thread_id}` : ''}`,
    recorded, value?.verification_error && `核验记录异常：${value.verification_error}`,
    value?.status !== 'completed' && value?.error && `错误：${value.error}`,
    ...(blockers.blockers.length ? ['--- 阻塞与待回答问题 ---', ...blockers.blockers.map((b) =>
      `${b.id} [${b.kind}] ${b.message}${b.question ? `\n需要回答：${b.question}` : ''}${b.resolution ? `\n解除条件/已有信息：${b.resolution}` : ''}`)] : []),
    ...(value?.next ? ['--- 下一步 ---', value.next, USER_REPORT] : []),
  ].filter(Boolean).join('\n') }];
}
const REVIEW_OUTPUT = { schema: OUTPUT.schema, render: (_args, value) => renderReview(value) };
const DATA_OUTPUT = { schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };

// 任务列表只用来找回编号、看状态：核验明细约占一页的四成，和空字段、执行端目录一起不放进列表，
// 规划端每次查列表都要把整页留在上下文里。核验明细用 codex_status 或 codex_output（artifact: "review"）读取。
export function listedJob(job) {
  const { verification, task_options: options, context, ...rest } = job ?? {};
  const kept = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== null));
  if (verification?.reviewer) kept.verification_reviewer = verification.reviewer;
  if (options) {
    const { agy_home: _home, ...used } = options;
    kept.task_options = Object.fromEntries(Object.entries(used).filter(([, v]) => v !== null));
  }
  if (context) {
    const { dispatcher, ...task } = context;
    kept.context = dispatcher ? { ...task, dispatcher: { version: dispatcher.version, pid: dispatcher.pid } } : task;
  }
  return kept;
}

// 工具卡片和任务表用的短标题：任务的第一行，截到 n 个字
export function taskLine(args, n) {
  const line = typeof args?.task === 'string' ? args.task.trim().split('\n')[0].trim() : '';
  return line.length > n ? `${line.slice(0, n)}…` : line;
}
// 结果第一行里 job_id 之前的一行摘要
const resultSummary = (result) =>
  (result?.content?.find((c) => c?.type === 'text')?.text ?? '').split('\n')[0].split('  job_id')[0].trim();
// 聊天里 codex_* 调用卡片的标题：进行中显示派了什么，结束后换成一行摘要；只依赖参数和结果，重放时也一样
const PRESENT = {
  codex_run: {
    presentCall: (a) => ({ card: 'generic', kind: a?.write === true || a?.host_access === true ? 'execute' : 'read', rawInput: a,
      title: [`${a?.resume ? 'Codex 返工' : 'Codex'}${a?.host_access === true ? '（主机）' : ''}`, taskLine(a, 60)].filter(Boolean).join(' · ') }),
    presentResult: (a, r) => r?.isError || !resultSummary(r) ? undefined
      : { card: 'generic', title: [`Codex ${resultSummary(r)}`, taskLine(a, 40)].filter(Boolean).join(' · ') },
  },
  codex_status: {
    presentCall: (a) => ({ card: 'generic', kind: 'read', title: `Codex 状态 ${a?.job_id ?? ''}` }),
    presentResult: (a, r) => r?.isError || !resultSummary(r) ? undefined
      : { card: 'generic', title: `Codex 状态 ${a?.job_id ?? ''} · ${resultSummary(r)}` },
  },
  codex_cancel: {
    presentCall: (a) => ({ card: 'generic', kind: 'execute', title: `取消 Codex ${a?.job_id ?? ''}` }),
  },
};
const sessionCwd = (exec) => exec?.agent?.session?.header?.cwd;

// 任务目录：显式 cwd > 包含会话工作区的 workspaces 条目的 cwd（最具体的那条）> 会话工作区
export function taskCwd(args, session, workspaces) {
  if (args.cwd) return args.cwd;
  const hits = workspaces.filter((w) => w.cwd && inWorkspace(session, [w.root]));
  return hits.sort((a, b) => b.root.length - a.root.length)[0]?.cwd ?? session;
}

function settings(config, logger) {
  // A misspelt key (workspace for workspaces) would otherwise switch the guard off without a trace.
  const unknownConfig = Object.keys(config).filter(key => !Object.hasOwn(DEFAULTS, key));
  if (unknownConfig.length) logger?.warn?.(`[codex-conductor] 未知配置项 ${unknownConfig.join(', ')} 已忽略，请核对拼写`);
  config = Object.fromEntries(Object.entries(DEFAULTS).map(([key, defaults]) => {
    const fallback = config.runnerMode === 'native' ? (nativeDefaults[key] ?? defaults) : defaults;
    const value = config[key];
    const counts = ['maxRunningJobs', 'maxSessionJobs', 'maxSessionTokens', 'maxGeminiRunningJobs'];
    const optionalBudget = ['timeoutSeconds', 'idleTimeoutSeconds', 'retries', 'lockTimeoutSeconds', 'maxStorageMb', ...counts].includes(key);
    if (value === undefined || (value === '' && (typeof fallback === 'string' || optionalBudget))) return [key, fallback];
    const valid = optionalBudget
      ? value === null || (Number.isFinite(value) && (key === 'retries' ? Number.isInteger(value) && value >= 0
        : counts.includes(key) ? Number.isInteger(value) && value > 0 : value > 0))
      : key === 'stateDir' ? typeof value === 'string' && path.isAbsolute(value)
      : key === 'runnerMode' ? ['native', 'wsl'].includes(value)
      : key === 'plannerReads' ? ['open', 'products'].includes(value)
      : key === 'toolPolicy' ? ['denylist', 'allowlist'].includes(value)
      : key === 'closeoutEvidence' ? ['independent', 'planner', 'off'].includes(value)
      : key === 'acceptOpenEvidence' ? ['strict', 'relaxed', 'off'].includes(value)
      : key === 'ownerDecisions' ? ['planner', 'owner'].includes(value)
      : key === 'autoVerify' ? ['off', 'flagged'].includes(value)
      : key === 'defaultEngine' ? ENGINE_PARAMETER.enum.includes(value)
      : key === 'effortOverride' ? ['planner', 'raise-only-listed', 'config'].includes(value)
      : ['handoverSuggestMessages', 'handoverContextTokens', 'acceptanceWarnAbove', 'continueFreshAboveTokens'].includes(key) ? Number.isInteger(value) && value >= 0
      : key === 'runnerAgentsMd' ? typeof value === 'string' && (['none', 'bundled'].includes(value) || /^(?:[A-Za-z]:[\\/]|\/)[^\r\n]*$/.test(value))
      : key === 'allowTools' ? Array.isArray(value) && value.every(name => typeof name === 'string' && name.trim())
      : key === 'mcpWriteAllow' ? Array.isArray(value) && value.every(name => typeof name === 'string' && /^mcp__/i.test(name.trim()))
      : key === 'plannerReadAllow' ? Array.isArray(value) && value.every(p => typeof p === 'string' && /^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(p))
      : ['autoResume', 'autoHandover', 'autoAnswer', 'modelAB', 'repeatFailureGuard'].includes(key) ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : ['codexRoute', 'gemini'].includes(key) ? value === null || (typeof value === 'object' && !Array.isArray(value))
        : Array.isArray(fallback) ? Array.isArray(value)
          : typeof value === typeof fallback && (typeof value !== 'number' || Number.isFinite(value));
    if (!valid) logger?.warn?.(`[codex-conductor] 忽略无效的配置 ${key}，使用默认值`);
    return [key, valid ? value : fallback];
  }));
  const autoResume = config.autoResume;
  config.autoResume = Object.fromEntries(Object.entries(DEFAULTS.autoResume).map(([key, fallback]) => {
    const value = autoResume[key];
    const valid = key === 'enabled' ? typeof value === 'boolean'
      : key === 'maxAgeHours' ? Number.isFinite(value) && value > 0
      : key === 'delaySeconds' ? Number.isFinite(value) && value >= 0
      : key === 'reloadDelaySeconds' ? Number.isFinite(value) && value >= 0 && value * 1000 <= 2_147_483_647
      : key === 'message' ? typeof value === 'string' && [...value].length <= 2000
      : Array.isArray(value) && value.every(id => typeof id === 'string' && id.length >= 1 && id.length <= 100 && !/[^A-Za-z0-9_-]/.test(id));
    if (value !== undefined && !valid) logger?.warn?.(`[codex-conductor] 忽略无效的配置 autoResume.${key}，使用默认值`);
    return [key, valid ? value : fallback];
  }));
  const autoHandover = config.autoHandover;
  for (const key of Object.keys(autoHandover)) if (!Object.hasOwn(DEFAULTS.autoHandover, key)) unknownConfig.push(`autoHandover.${key}`);
  config.autoHandover = Object.fromEntries(Object.entries(DEFAULTS.autoHandover).map(([key, fallback]) => {
    const value = autoHandover[key];
    const valid = key === 'mode' ? ['off', 'notify', 'confirm', 'auto'].includes(value)
      : key === 'remindStepMessages' ? Number.isSafeInteger(value) && value > 0
      : key === 'maxChainDepth' ? Number.isSafeInteger(value) && value >= 0
      : ['disableAutoContinue', 'withRunningJobs'].includes(key) ? typeof value === 'boolean'
      : Number.isFinite(value) && value >= 0;
    if (value !== undefined && !valid) logger?.warn?.(`[codex-conductor] 忽略无效的配置 autoHandover.${key}，使用默认值`);
    return [key, valid ? value : fallback];
  }));
  if (unknownConfig.some((key) => key.startsWith('autoHandover.'))) logger?.warn?.(`[codex-conductor] 未知配置项 ${unknownConfig.filter((key) => key.startsWith('autoHandover.')).join(', ')} 已忽略，请核对拼写`);
  config.autoAnswer = normalizeAutoAnswer(config.autoAnswer, unknownConfig, logger);
  const modelAB = config.modelAB;
  for (const key of Object.keys(modelAB)) {
    if (Object.hasOwn(DEFAULTS.modelAB, key)) continue;
    unknownConfig.push(`modelAB.${key}`);
    logger?.warn?.(`[codex-conductor] 未知配置项 modelAB.${key} 已忽略，请核对拼写`);
  }
  config.modelAB = Object.fromEntries(Object.entries(DEFAULTS.modelAB).map(([key, fallback]) => {
    const value = modelAB[key];
    const valid = key === 'enabled' ? typeof value === 'boolean'
      : key === 'share' ? Number.isFinite(value) && value >= 0 && value <= 1
        : Array.isArray(value) && value.length === 2 && value.every(model => typeof model === 'string' && model.trim()) &&
          value[0].trim() !== value[1].trim();
    if (value !== undefined && !valid) logger?.warn?.(`[codex-conductor] 忽略无效的配置 modelAB.${key}，使用默认值`);
    return [key, valid ? (key === 'models' ? value.map(model => model.trim()) : value) : fallback];
  }));
  const repeat = config.repeatFailureGuard;
  for (const key of Object.keys(repeat)) {
    if (Object.hasOwn(REPEAT_FAILURE_DEFAULTS, key)) continue;
    unknownConfig.push(`repeatFailureGuard.${key}`);
    logger?.warn?.(`[codex-conductor] 未知配置项 repeatFailureGuard.${key} 已忽略，请核对拼写`);
  }
  config.repeatFailureGuard = Object.fromEntries(Object.entries(REPEAT_FAILURE_DEFAULTS).map(([key, fallback]) => {
    const value = repeat[key];
    const valid = validRepeatFailureField(key, value);
    if (value !== undefined && !valid) logger?.warn?.(`[codex-conductor] 忽略无效的配置 repeatFailureGuard.${key}，使用默认值`);
    return [key, valid ? value : fallback];
  }));
  if (config.gemini) {
    const gemini = config.gemini;
    if (typeof gemini.command !== 'string' || !/^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+\\)/.test(gemini.command.trim())) {
      logger?.warn?.('[codex-conductor] 忽略无效的配置 gemini.command，必须是 agy.exe 的绝对 Windows 路径');
      config.gemini = null;
    } else {
      config.gemini = { command: gemini.command.trim() };
      for (const [key, fallback] of Object.entries({ proxy: '', model: 'gemini-4-argon', effort: '', timeoutSeconds: 1800, idleTimeoutSeconds: 600 })) {
        const value = gemini[key];
        const valid = ['timeoutSeconds', 'idleTimeoutSeconds'].includes(key) ? Number.isFinite(value) && value > 0
          : key === 'effort' ? ['', 'low', 'medium', 'high'].includes(value) : typeof value === 'string' && value.trim().length > 0;
        if (value !== undefined && !valid) logger?.warn?.(`[codex-conductor] 忽略无效的配置 gemini.${key}，使用默认值`);
        config.gemini[key] = valid ? value : fallback;
        if (key === 'model' && valid) config.gemini.executionModel = value;
        if (key === 'effort' && valid && value) config.gemini.executionEffort = value;
      }
      // The configured effort wins over whatever the planner passes.
      if (gemini.forceEffort !== undefined) {
        if (typeof gemini.forceEffort === 'boolean') config.gemini.forceEffort = gemini.forceEffort;
        else logger?.warn?.('[codex-conductor] 忽略无效的配置 gemini.forceEffort，必须是 true 或 false');
      }
      // The configured model wins over whatever the planner passes, continued conversations included.
      if (gemini.forceModel !== undefined) {
        if (typeof gemini.forceModel === 'boolean') config.gemini.forceModel = gemini.forceModel;
        else logger?.warn?.('[codex-conductor] 忽略无效的配置 gemini.forceModel，必须是 true 或 false');
      }
      if (gemini.accountPool !== undefined) {
        if (typeof gemini.accountPool === 'string' && path.isAbsolute(gemini.accountPool.trim())) config.gemini.accountPool = gemini.accountPool.trim();
        else logger?.warn?.('[codex-conductor] 忽略无效的配置 gemini.accountPool，必须是 DSH agy 账号池 pool.json 的绝对路径');
      }
      // Applied when a call omits max_chars, so length stays capped even if the planner forgets it.
      if (gemini.defaultMaxChars !== undefined) {
        if (Number.isSafeInteger(gemini.defaultMaxChars) && gemini.defaultMaxChars > 0) config.gemini.defaultMaxChars = gemini.defaultMaxChars;
        else logger?.warn?.('[codex-conductor] 忽略无效的配置 gemini.defaultMaxChars，必须是正整数');
      }
    }
  }
  // workspaces 的条目可以是路径字符串，也可以是 {path, cwd}
  const workspaces = (Array.isArray(config.workspaces) ? config.workspaces : [])
    .map((w) => typeof w === 'string' ? { root: normPath(w) }
      : { root: normPath(w?.path), cwd: typeof w?.cwd === 'string' && w.cwd.trim() ? w.cwd.trim() : undefined })
    .filter((w) => w.root);
  // allowCommands 用 JavaScript 正则；ignoreChanges 交给 runner 按 Python re 验证和应用。
  const patterns = (key) => (Array.isArray(config[key]) ? config[key] : []).flatMap((pattern) => {
    try {
      return [new RegExp(pattern)];
    } catch (error) {
      logger?.warn?.(`[codex-conductor] 忽略无效的 ${key} 正则 ${pattern}：${error.message}`);
      return [];
    }
  });
  return {
    ...config,
    workspaces,
    roots: workspaces.map((w) => w.root),
    denyTools: new Set(Array.isArray(config.denyTools) ? config.denyTools : []),
    allowCommands: patterns('allowCommands'),
    ignoreChanges: Array.isArray(config.ignoreChanges) ? config.ignoreChanges.map(String) : [],
    allowTools: config.allowTools.map(name => name.trim()),
    mcpWriteAllow: config.mcpWriteAllow.map(name => name.trim()),
    seenTools: new Set(),
    unknownConfig,
  };
}

// 后台状态更新间隔；最终结果写好后立即返回。
const BG_WAIT = 20;
// runner 取消后会立即写下结果，后台循环一秒内就能看到，这里只是上限
const CANCEL_SETTLE_MS = 30_000;
const JOB_STATUS = { completed: 'completed', cancelled: 'killed' };
// 同一宿主内热重载后，旧的后台观察仍可能与新实例同时看到完成。
const hostVerifications = globalThis[Symbol.for('dsh-codex-conductor.verifications')] ??= new WeakMap();
const hostConvergenceStarts = globalThis[Symbol.for('dsh-codex-conductor.convergenceStarts')] ??= new Set();
const hostParkedReviews = globalThis[Symbol.for('dsh-codex-conductor.parkedReviews')] ??= new Map();
const hostAutoVerifyScans = globalThis[Symbol.for('dsh-codex-conductor.autoVerifyScans')] ??= new Map();
const automaticVerification = Symbol('automaticVerification');

export function apply(ctx, config = {}, run = runRunner, launchGemini = spawn) {
  if (config.runnerMode === 'native') {
    if (process.platform !== 'win32') throw new Error('原生 runner 需要 Windows');
    config = { ...config, ...validateNativeState(config) };
  }
  const cfg = settings(config, ctx.logger);
  const stateDirectory = cfg.stateDir || (process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'dsh-codex-conductor'));
  const canAnswer = (log, job, owner) => cfg.plannerAnswers === true || hasUserReply(log, job, owner, cfg.autoResume.message);
  const conductor = createConductor(cfg, run);
  let dispatching = 0;
  let dispatchGeneration = 0;
  const geminiWrites = new Set();
  const startingWrites = new Set();
  const closeoutFrom = closeoutSince(stateDirectory);
  // 独立依据规则从本机第一次加载这一版起生效；之前结束的任务按 planner 规则（0.9.103）结案，不会因升级变难收尾。
  const evidenceFrom = closeoutSince(stateDirectory,
    Date.now() / 1000, 'closeout-evidence-since.json');
  const reworkFrom = closeoutSince(stateDirectory,
    Date.now() / 1000, 'closeout-rework-since.json');
  const acceptOpenFrom = closeoutSince(stateDirectory,
    Date.now() / 1000, 'accept-open-evidence-since.json');
  const autoVerifyFrom = closeoutSince(stateDirectory,
    Date.now() / 1000, 'auto-verify-since.json');
  const beforeCutoff = (source, since) => {
    if (Number.isFinite(source.finished_at)) return source.finished_at < since;
    // 拿不到结束时间时看任务号里的开始时间（runner 所在系统的本地时间，时区不定，按 ±14 小时取界）：
    // 只有最晚也早于截止时间的才按旧规则。
    const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(String(source.job_id ?? ''));
    const started = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000 : undefined;
    return started !== undefined && started + 14 * 3600 < since;
  };
  const evidenceLevel = (source) => cfg.closeoutEvidence === 'independent' && beforeCutoff(source, evidenceFrom)
    ? 'planner' : cfg.closeoutEvidence;
  const openEvidenceLevel = (source) => beforeCutoff(source, acceptOpenFrom) ? 'off' : cfg.acceptOpenEvidence;
  // 原报告自标未满足的条目各有哪些独立依据：晚于这一轮结束、核验本单元的核验任务判这一条 met；同一单元的后续轮次报告这一条 met；
  // 原会话用户在作业结束后有过真实回复（与 accepted_deviations 的用户确认同一判定，但不因 plannerAnswers 放宽）。
  const openAccepted = (review) => [...(Array.isArray(review.criteria) ? review.criteria : []), ...(Array.isArray(review.report_rows) ? review.report_rows : [])]
    .some((c) => typeof c?.accepted === 'string' && c.accepted.trim());
  const verificationTargetText = (target, key) => key.startsWith('row')
    ? target?.structured?.criteria?.[Number(key.slice(3)) - 1]?.criterion
    : target?.context?.acceptance?.[Number(key) - 1];
  const jobStatusLookup = (signal, limit = Infinity) => {
    const statuses = new Map();
    return (id) => {
      if (!statuses.has(id) && statuses.size < limit) statuses.set(id, conductor.waitJob(id, 0, signal));
      return statuses.get(id);
    };
  };
  async function criterionSupport(source, owner, log, signal, checkOpen, strictLookup = false) {
    const flagged = flaggedCriteria(source);
    const required = mustVerifyCriteria(source);
    const support = {};
    const openSupport = {};
    const targets = new Map([...required, ...flagged].map(f => [f.key, f]));
    const openTargets = checkOpen ? targets : new Map();
    if (!flagged.length && !required.length) return { support, openSupport };
    const add = (map, key, kind) => { (map[key] ??= []).includes(kind) || map[key].push(kind); };
    if (hasUserReply(log, source, owner, cfg.autoResume.message)) {
      for (const f of flagged) add(support, f.key, 'user');
      for (const key of openTargets.keys()) add(openSupport, key, 'user');
    }
    const jobs = [];
    const from = Number.isFinite(source.started_at) ? source.started_at : evidenceFrom;
    const lookup = async (request) => {
      const value = await (strictLookup ? request : request.catch(() => { signal?.throwIfAborted(); }));
      if (strictLookup && (!value || unknownState(value))) {
        throw new Error(value?.error ?? value?.error_kind ?? '无法核对复核依据');
      }
      return value;
    };
    for (let offset = 0; offset !== null && offset < 500;) {
      const page = await lookup(conductor.list({ owner, also_owners: aliases.predecessors(owner), started_between: [from, Date.now() / 1000 + 86_400], limit: 100, offset }, signal));
      if (page?.error_kind || !Array.isArray(page?.jobs)) {
        if (strictLookup) throw new Error(page?.error ?? page?.error_kind ?? '任务列表不可用');
        break;
      }
      jobs.push(...page.jobs);
      offset = page.next_offset ?? null;
    }
    const unit = new Set([source.job_id]);
    const threads = new Map();
    const first = jobs.find(job => job.job_id === source.job_id);
    const sourceThread = source.thread_id ?? first?.thread_id;
    if (sourceThread) threads.set(sourceThread, source.started_at ?? first?.started_at);
    for (const job of [...jobs].sort((a, b) => (a.started_at ?? 0) - (b.started_at ?? 0))) {
      if (job.context?.verification_of || job.job_id === source.job_id) continue;
      if (unit.has(parentOf(job)) || job.started_at > threads.get(job.thread_id)) {
        unit.add(job.job_id);
        if (job.thread_id && threads.get(job.thread_id) === undefined) threads.set(job.thread_id, job.started_at);
      }
    }
    const runningVerification = jobs.find(job =>
      job.execution_status === 'running' && job.context?.verification_of === source.job_id)?.job_id;
    const later = jobs.filter((job) => job.job_id !== source.job_id && job.execution_status === 'completed' &&
      job.finished_at > (source.finished_at ?? 0) &&
      (job.context?.verification_of ? unit.has(job.context.verification_of) : unit.has(job.job_id)));
    const status = jobStatusLookup(signal);
    for (const job of later.slice(0, 10)) {
      const full = await lookup(status(job.job_id));
      if (!full) continue;
      const report = full.structured;
      const acceptance = full.context?.acceptance;
      if (full.error_kind || !validReport(report) || !Array.isArray(acceptance)) continue;
      // 报告行按条文或（条数相同时）位置对应验收项；对不上的行不当作任何一条的结论。
      const targetId = full.context?.verification_of;
      if (targetId) {
        const target = targetId === source.job_id ? source : await lookup(status(targetId));
        acceptance.forEach((item, i) => {
          const targetKey = verificationItemKey(item);
          if (!targetKey) return;
          let key = targetKey;
          if (targetId !== source.job_id) {
            const text = verificationTargetText(target, targetKey);
            if (typeof text !== 'string') return;
            const matches = [...targets.values()].filter(f => Boolean(f.row) === targetKey.startsWith('row') && f.criterion === text);
            // 原任务里同一条文出现不止一次（含未标记的条目）时对不准是哪一条，不算依据。
            const sameText = targetKey.startsWith('row') ? (source.structured?.criteria ?? []).filter(c => c?.criterion === text).length
              : (source.context?.acceptance ?? []).filter(a => a === text).length;
            if (matches.length !== 1 || sameText > 1) return;
            key = matches[0].key;
          }
          const row = key && reportRowOf(acceptance, report.criteria, i + 1);
          if (row && openTargets.has(key)) add(openSupport, key, 'verification');
          if (row?.status !== 'met') return;
          if (flagged.some(f => f.key === key)) add(support, key, 'verification');
          if (row.evidence.trim() && required.some(f => f.key === key &&
              verifyCriterionItem({ ...f, index: Number(targetKey) }) === item)) add(support, key, 'must_verify');
        });
      } else {
        for (const f of flagged) {
          const i = acceptance.findIndex((a) => a.trim() === String(f.criterion ?? '').trim());
          if (i >= 0 && reportRowOf(acceptance, report.criteria, i + 1)?.status === 'met') add(support, f.key, 'later_round');
        }
        for (const f of openTargets.values()) {
          const i = acceptance.indexOf(f.criterion);
          if (i >= 0 && ['not_met', 'blocked'].includes(reportRowOf(acceptance, report.criteria, i + 1)?.status)) {
            add(openSupport, f.key, 'later_round');
          }
        }
      }
    }
    return { support, openSupport, runningVerification };
  }
  async function undecidedOwnerBlockers(source, owner, signal, blockers = source.structured?.blockers) {
    const pending = new Set(ownerBlockerIds(blockers));
    try {
      for (let offset = 0; pending.size && offset !== null;) {
        const page = await conductor.list({ owner, also_owners: aliases.predecessors(owner), parent_job: source.job_id, limit: 100, offset }, signal);
        if (!Array.isArray(page?.jobs)) break;
        for (const { job_id } of page.jobs) {
          if (job_id === source.job_id) continue;
          const child = await conductor.waitJob(job_id, 0, signal);
          const decision = child.context?.continuation;
          if (!unknownState(child) && owns(owner, child.context?.owner) && decision?.parent_job_id === source.job_id) {
            for (const id of resolvedBlockerIds([...pending], decision)) pending.delete(id);
          }
          if (!pending.size) break;
        }
        offset = page.next_offset ?? null;
      }
    } catch { signal?.throwIfAborted(); }
    return [...pending];
  }
  async function ownerReviewProblem(source, prepared, owner, signal) {
    if (cfg.ownerDecisions !== 'planner' || !prepared.acceptedOpen.some(entry => !entry.owner_only)) return '';
    const ids = await undecidedOwnerBlockers(source, owner, signal);
    return ids.length ? `${source.job_id} 的报告有待决定的阻塞 ${ids.join('、')}（user_input/task_conflict）。` +
      `按所有者的常设授权由你决定：用 codex_continue ${source.job_id} 提交 answers（每个问题写选定方案、理由和放弃的方案）或 resolution 后继续；` +
      '只有不可逆删除或覆盖、对外发送或发布、花钱、账号或凭据、扩大安全边界这几类留给所有者——那样在对应条目写 owner_only: <原因>。' : '';
  }
  const statusQueries = new Map();
  function dampenStatus(value, exec, tool, seconds = 0) {
    const owner = exec?.agent?.id;
    if (!owner) return;
    const key = JSON.stringify([owner, tool, value.job_id]);
    if (value.status !== 'running' || unknownState(value) || value.output) {
      statusQueries.delete(key);
      return;
    }
    // 原生进度里的活动秒数和重试倒计时会变，阶段与实际活动不因此改变。
    const activity = value.last_activity?.replace(/，距上次活动 [^：]* 秒：/, '：').replace(/约 \d+ 秒后重试/g, '等待重试');
    const signature = JSON.stringify([value.status, value.phase, value.attempt, value.last_error_kind, value.retry_at,
      value.error_kind, value.error, activity, value.blocking, value.report, value.final_message,
      value.report_status, value.review_status, value.verification_status]);
    const now = Date.now();
    const previous = statusQueries.get(key);
    if (seconds === 0 && previous?.signature === signature && now - previous.at < 120_000) {
      return { job_id: value.job_id, status: 'running', unchanged: true,
        rendered: `任务 ${value.job_id} 仍在执行；自上次查询以来无实质变化。` +
          waitForJob(value.job_id) };
    }
    if (statusQueries.size >= 10_000) statusQueries.delete(statusQueries.keys().next().value);
    statusQueries.set(key, { signature, at: now });
  }

  // 用户设定的规划要求：作为系统提示词的一段，每次组装时现读文件，改完下一步就生效
  const plannerFile = cfg.plannerPromptFile ||
    (stateDirectory ? path.join(stateDirectory, 'planner-prompt.md') : '');
  // 后继会话也能读交接前任任务的产物；任一查询失败就整体按失败处理。
  const productReads = createProductReads(cfg, async (owner) => {
    const values = await Promise.all(aliases.owners(owner).map((id) => conductor.products(id)));
    return values.find((v) => v?.status !== 'completed' || !Array.isArray(v.paths)) ??
      { ...values[0], owner, paths: values.flatMap((v) => v.paths) };
  }, { plannerFile, handoverArchive: (owner) => {
    if (!stateDirectory || !owner) return;
    const links = aliases.links();
    const root = aliases.predecessors(owner, links).at(-1);
    if (root && links[owner]?.instructions?.root === root) return instructionArchivePath(stateDirectory, root);
  } });
  const productJobs = new Map();
  // 交接后后继会话也是前任会话任务的归属方；没有交接记录时只认本会话。
  const aliases = createAliases(stateDirectory);
  const owns = (id, owner) => Boolean(id && owner) && aliases.owners(id).includes(owner);
  const history = createHistoryTracker({ directory: stateDirectory,
    threshold: () => cfg.handoverSuggestMessages ?? 0, contextThreshold: () => cfg.handoverContextTokens ?? 0 });
  const parkedFile = stateDirectory && path.join(stateDirectory, 'parked-reviews.json');
  const parkedEvaluations = hostParkedReviews.get(parkedFile) ?? new Map();
  if (parkedFile) hostParkedReviews.set(parkedFile, parkedEvaluations);
  const parkedWarning = (error) => { ctx.logger?.warn?.(`[codex-conductor] 挂起复核处理失败：${error?.message ?? error}`); };
  const readParkedReviews = () => {
    try {
      if (parkedFile) {
        const entries = JSON.parse(readFileSync(parkedFile, 'utf8'));
        if (!Array.isArray(entries)) throw new Error('parked-reviews.json 格式无效');
        return entries;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') { parkedWarning(error); return null; }
    }
    return [];
  };
  const parkedFor = (owner) => (readParkedReviews() ?? []).filter(entry => !owner || owns(owner, entry.owner));
  const parkedGoalRefusal = (owner) => {
    if (!owner) return '';
    if (readParkedReviews() === null) return 'update_goal: 会话目标暂不能标记完成：挂起复核记录（parked-reviews.json）读不出来，稍后重试；一直读不出来请操作员检查该文件。';
    const entry = parkedFor(owner)[0] ?? [...parkedEvaluations.values()].find(e => e.pending && owns(owner, e.owner));
    return entry ? `update_goal: 会话目标暂不能标记完成。${entry.job_id} 有挂起复核，等待核验 ${entry.verification_id} 的复核处理结束。` : '';
  };
  const ledgerFile = stateDirectory && path.join(stateDirectory, 'accepted-open.json');
  const decisionsFile = stateDirectory && path.join(stateDirectory, 'owner-decisions.json');
  function readOwnerDecisions() {
    try {
      if (decisionsFile) {
        const { decisions } = JSON.parse(readFileSync(decisionsFile, 'utf8'));
        if (!Array.isArray(decisions)) throw new Error('格式无效');
        return decisions;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return [];
  }
  function recordOwnerDecision(session, job_id, { parent_job_id, resolves: blocker_ids, decided_at: at }) {
    try {
      const decisions = readOwnerDecisions();
      if (decisions.some(entry => entry.job_id === job_id)) return;
      if (decisionsFile) writeJsonAtomic(decisionsFile, { decisions: [...decisions, { session, job_id, parent_job_id, blocker_ids, at }].slice(-500) });
      countCloseout(session, 'owner_decisions_by_planner', blocker_ids.length);
    } catch (error) {
      ctx.logger?.warn?.(`[codex-conductor] 代所有者决定台账保存失败：${error.message}`);
    }
  }
  function sessionOwnerDecisions(owner) {
    try {
      const scope = aliases.owners(owner);
      return readOwnerDecisions().filter(entry => scope.includes(entry.session));
    } catch (error) {
      ctx.logger?.warn?.(`[codex-conductor] 代所有者决定台账不可读：${error.message}`);
      return null;
    }
  }
  const ownerDecisionLine = decisions => decisions
    ? `代所有者决定 ${decisions.reduce((n, entry) => n + entry.blocker_ids.length, 0)} 项（任务 ${ledgerJobIds(decisions).join('、') || '无'}）`
    : '代所有者决定台账不可读';
  const unreadableLedgerLine = '未完成项台账不可读';
  const readLedger = () => {
    try {
      if (ledgerFile) {
        const ledger = JSON.parse(readFileSync(ledgerFile, 'utf8'));
        if (!Array.isArray(ledger?.items) || !Array.isArray(ledger.completions) ||
            (ledger.cleared !== undefined && !Array.isArray(ledger.cleared))) throw new Error('格式无效');
        ledger.items = ledger.items.map(({ text_hash, applied_checks, ...item }) => item);
        return ledger;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        ctx.logger?.warn?.(`[codex-conductor] ${unreadableLedgerLine}：${error.message}`);
        return null;
      }
    }
    return { since: acceptOpenFrom, items: [], completions: [] };
  };
  const saveLedger = (ledger) => {
    // 未完成项不按条数截断：只有复核或核验能让它离开台账。复核时间只为挡住迟到的旧回执：留最近 2000 个任务，仍有条目的任务一律保留。
    const { items } = ledger;
    const keep = new Set([...items, ...(ledger.historical ?? [])].map(item => item.job_id));
    const times = Object.entries(ledger.review_times ?? {}).sort((a, b) => a[1] - b[1]);
    const review_times = Object.fromEntries(times.filter(([id], i) => keep.has(id) || i >= times.length - 2000));
    if (ledgerFile) writeJsonAtomic(ledgerFile, { ...ledger, items, completions: ledger.completions.slice(-500), review_times });
  };
  const parentOf = (job) => job?.parent_job_id ?? job?.context?.continuation?.parent_job_id ?? job?.context?.routing?.parent_job_id;
  const ledgerJobIds = (items) => [...new Set(items.map(item => item.job_id))];
  const ownerKeys = item => (item.blocker_ids?.length ? item.blocker_ids : ['']).map(id => JSON.stringify([item.unit, id]));
  const itemId = ({ job_id, key, at }) => JSON.stringify([job_id, key, at]);
  const laterRoundHint = (items) => {
    const marked = items.filter(item => item.later_met_by);
    const rounds = [...new Set(marked.map(item => item.later_met_by))];
    return marked.length ? `其中 ${marked.length} 项后续轮次已报告满足（${marked.map(item =>
      `${item.job_id}#${item.index}←${item.later_met_by}`).join('、')}）：记 ${rounds.join('、')} 的结案复核时把这些条目记 met 即可销项，` +
      `或用 codex_review 重记 ${ledgerJobIds(marked).join('、')}。` : '';
  };
  const ledgerLine = (ledger, showCleared = false) => {
    if (!ledger) return unreadableLedgerLine;
    const { items, completions, cleared, historical = [] } = ledger;
    return [`未完成但接受的条目（本会话含前任）：${items.length} 项（任务 ${ledgerJobIds(items).join('、') || '无'}）；` +
      `以未完成项完成目标 ${completions.length} 次（最近 ${completions.at(-1)?.open_count ?? 0} 项）`,
      `待所有者决定 ${items.filter(item => item.needs_owner).length} 项`, laterRoundHint(items),
      ...items.flatMap(item => {
        const label = `${item.job_id}#${item.index ?? `row${item.row}`}`;
        if (item.needs_owner) return [`${label} 待所有者决定（${item.needs_owner}，${item.asked ? '已问' : '未问'}）`];
        return item.blocker_kinds?.some(kind => kind === 'user_input' || kind === 'task_conflict') ? [`${label} 可由规划端决定后继续`] : [];
      }),
      ...(showCleared ? cleared.map(item => `${item.job_id}#${item.index} cleared by later round ${item.cleared_by}`) : []),
      ...historical.map(item => `${item.job_id}#${item.key} 历史证据不可补回（${item.historical_gap}）：${item.reason}`),
    ].filter(Boolean).join('\n');
  };

  function requireJobStatus(job, id) {
    if (job?.job_id !== id || unknownState(job) || !job.context?.owner) {
      throw new Error(`${id}：${job?.error ?? job?.error_kind ?? '任务状态不可用'}`);
    }
    return job;
  }

  async function laterRoundItems(round, items, status) {
    const acceptance = round.context?.acceptance;
    const report = round.structured ?? round.report;
    if (!parentOf(round) || round.context?.verification_of || !Array.isArray(acceptance) || !validReport(report)) return [];
    const owner = round.context.owner;
    const owners = aliases.owners(lastSuccessor(aliases, owner) ?? owner);
    const met = new Set();
    for (const { index } of items) {
      const text = acceptance[index - 1];
      if (Number.isInteger(index) && typeof text === 'string' &&
          acceptance.indexOf(text) === index - 1 && acceptance.lastIndexOf(text) === index - 1 &&
          reportRowOf(acceptance, report.criteria, index)?.status === 'met') met.add(index);
    }
    const candidates = items.filter(item => item.job_id !== round.job_id && met.has(item.index) && owners.includes(item.session));
    if (!candidates.length) return [];
    const matches = [];
    const seen = new Set([round.job_id]);
    for (let id = parentOf(round), hops = 0; id && hops < 10; hops++) {
      if (seen.has(id)) throw new Error(`${id}：父任务链形成循环`);
      const lookup = status(id);
      if (!lookup) break;
      const parent = requireJobStatus(await lookup, id);
      seen.add(id);
      const previous = parent.context.acceptance;
      if (owners.includes(parent.context.owner) && Array.isArray(previous) && previous.length === acceptance.length) {
        matches.push(...candidates.filter(({ job_id, index }) => {
          const text = acceptance[index - 1];
          return job_id === id && previous.indexOf(text) === index - 1 && previous.lastIndexOf(text) === index - 1;
        }));
      }
      id = parentOf(parent);
    }
    return matches;
  }

  async function ownerUnit(source, owner, signal) {
    let root = source;
    const status = jobStatusLookup(signal, 10);
    try {
      for (let hop = 0; hop < 10 && parentOf(root); hop++) {
        const parent = parentOf(root);
        const lookup = status(parent);
        if (!lookup) break;
        const job = await lookup;
        if (unknownState(job) || !owns(owner, job.context?.owner)) break;
        root = job;
      }
    } catch { signal?.throwIfAborted(); }
    return root.thread_id ? `thread:${root.thread_id}` : `job:${root.job_id}`;
  }

  function recordAcceptedOpen(source, acceptedOpen, at, owner, unit, historyOnly = false) {
    if (!ledgerFile || (!unit && !acceptedOpen.some(item => item.historical_gap) && beforeCutoff(source, acceptOpenFrom))) return {};
    const warning = '本次复核已写入，未能更新未完成项台账。';
    try {
      const ledger = readLedger();
      if (!ledger) return { ledgerWarning: warning };
      const jobId = source.job_id;
      const reviewTimes = ledger.review_times ?? {};
      if (reviewTimes[jobId] > at || ledger.items.some(item => item.job_id === jobId && item.at > at)) return {};
      const session = source.context.owner;
      const blockers = source.structured?.blockers;
      const blocker_kinds = Array.isArray(blockers) ? [...new Set(blockers.map(blocker => blocker?.kind).filter(Boolean))] : [];
      const blocker_ids = ownerBlockerIds(blockers);
      const previous = ledger.items.filter(item => item.needs_owner && owns(owner, item.session));
      const seen = new Set(previous.flatMap(ownerKeys));
      const asked = new Set(previous.filter(item => item.asked).flatMap(ownerKeys));
      const historical = acceptedOpen.filter(item => item.historical_gap).map(item => ({ session, job_id: jobId, ...item, at }));
      const fresh = acceptedOpen.filter(item => !item.historical_gap && (item.owner_only || !beforeCutoff(source, acceptOpenFrom)));
      const items = fresh.map(({ owner_only, ...entry }) => {
        const item = { session, job_id: jobId, ...entry, blocker_kinds, at };
        if (owner_only) Object.assign(item, { needs_owner: owner_only, unit, blocker_ids, asked: ownerKeys({ unit, blocker_ids }).every(key => asked.has(key)) });
        return item;
      });
      const newOwnerItems = items.filter(item => item.needs_owner && !previous.some(old => old.job_id === jobId && old.key === item.key));
      const askOwner = items.some(item => item.needs_owner && ownerKeys(item).some(key => !seen.has(key)));
      const remaining = ledger.items.filter(item => item.job_id !== jobId ||
        (historyOnly && !historical.some(entry => entry.key === item.key)));
      // 即使没有未完成项，也保留这次复核时间，防止迟到的旧回执恢复旧条目。
      saveLedger({ ...ledger, review_times: { ...reviewTimes, [jobId]: at }, items: [...remaining, ...items],
        ...(historical.length || ledger.historical ? { historical: [
          ...(ledger.historical ?? []).filter(item => !historical.some(entry => entry.job_id === item.job_id && entry.key === item.key)),
          ...historical,
        ] } : {}) });
      if (newOwnerItems.length) countCloseout(owner, 'needs_owner_open', newOwnerItems.length);
      return { askOwner: askOwner
        ? `任务 ${jobId} 有事项须由所有者决定${blocker_ids.length ? `（阻塞 ${blocker_ids.join('、')}）` : ''}。` +
          `用 ask_user_question 提问，intent 设为 owner_only，问题文字以 [owner_only] ${jobId} 开头。` : '' };
    } catch (error) {
      ctx.logger?.warn?.(`[codex-conductor] ${warning} ${error?.message ?? error}`);
      return { ledgerWarning: warning };
    }
  }

  function observeOwnerQuestion(exec) {
    const args = goalArguments(exec.arguments);
    const questions = Array.isArray(args?.questions) ? args.questions : [args];
    const marked = questions.filter(q => typeof q?.question === 'string' &&
      (q.intent === 'owner_only' || q.question.startsWith('[owner_only]')));
    if (!marked.length) return;
    try {
      const ledger = readLedger();
      const ownedItems = ledger?.items.filter(item => item.needs_owner && owns(exec.agent?.id, item.session)) ?? [];
      const pending = ownedItems.filter(item => !item.asked);
      const units = new Set(pending.map(item => item.unit));
      const asked = new Set();
      for (const { question } of marked) {
        const words = new Set(question.match(/[A-Za-z0-9_-]+/g));
        const named = ownedItems.filter(item => words.has(item.job_id));
        const items = named.length ? named : units.size === 1 ? pending : [];
        for (const key of items.flatMap(ownerKeys)) asked.add(key);
      }
      const items = pending.filter(item => ownerKeys(item).every(key => asked.has(key)));
      if (items.length) {
        for (const item of items) item.asked = true;
        saveLedger(ledger);
      }
    } catch (error) {
      ctx.logger?.warn?.(`[codex-conductor] 向所有者提问的状态保存失败：${error.message}`);
    }
  }

  async function clearLaterRoundItems(source, verification, owner, signal) {
    if (!ledgerFile || !parentOf(source)) return;
    try {
      const { time: at, criteria } = verification;
      const met = new Set((criteria ?? []).filter(item => item.status === 'met').map(item => item.index));
      if (!met.size) return;
      const initial = readLedger();
      if (!initial || initial.review_times?.[source.job_id] > at) return;
      const candidates = initial.items.filter(item => item.at < at && met.has(item.index));
      const matches = await laterRoundItems(source, candidates, jobStatusLookup(signal));
      if (!matches.length) return;
      const matched = new Set(matches.map(itemId));
      // 状态查询期间的重审可能已替换原条目或写入更新的后续轮次复核。
      const ledger = readLedger();
      if (!ledger || ledger.review_times?.[source.job_id] > at) return;
      const cleared = ledger.items.filter(item => matched.has(itemId(item)));
      if (!cleared.length) return;
      saveLedger({ ...ledger, items: ledger.items.filter(item => !matched.has(itemId(item))),
        cleared: [...(ledger.cleared ?? []), ...cleared.map(item =>
          ({ ...item, cleared_by: source.job_id, cleared_at: at }))].slice(-500) });
      countCloseout(owner, 'ledger_cleared_by_later_round', cleared.length);
    } catch (error) {
      ctx.logger?.warn?.(`[codex-conductor] 未能按后续轮次 ${source.job_id} 销项：${error?.message ?? error}`);
    }
  }

  async function acceptedOpenLedger(owner, signal) {
    const scope = aliases.owners(owner);
    const laterMet = new Map();
    const view = ({ since, items, completions, cleared = [], historical }) => ({ since,
      items: items.filter(item => scope.includes(item.session)).map(item => {
        const later = laterMet.get(itemId(item));
        return later ? { ...item, later_met_by: later } : item;
      }),
      completions: completions.filter(entry => scope.includes(entry.session)),
      cleared: cleared.filter(item => scope.includes(item.session)),
      ...(historical ? { historical: historical.filter(item => scope.includes(item.session)) } : {}) });
    const initial = readLedger();
    if (!initial) return null;
    const snapshot = initial.items.filter(item => scope.includes(item.session));
    if (!snapshot.length) return view(initial);
    const byJob = new Map(ledgerJobIds(snapshot).map(id => [id, []]));
    for (const item of snapshot) byJob.get(item.job_id).push(item);
    const resolved = new Set();
    try {
      const jobs = new Map();
      for (let offset = 0; offset !== null;) {
        const page = await conductor.list({ owner, also_owners: scope.slice(1), limit: 100, offset }, signal);
        if (page.error_kind || !Array.isArray(page.jobs)) throw new Error(page.error ?? page.error_kind ?? '任务列表不可用');
        for (const job of page.jobs) jobs.set(job.job_id, job);
        offset = page.next_offset ?? null;
      }
      const status = jobStatusLookup(signal);
      for (const job of jobs.values()) {
        const target = job.context?.verification_of;
        if (!target || job.execution_status !== 'completed') continue;
        const candidates = (byJob.get(target) ?? []).filter(item => job.finished_at > item.at && !resolved.has(itemId(item)));
        if (!candidates.length) continue;
        const full = await status(job.job_id);
        const acceptance = full.context?.acceptance;
        if (full.error_kind || !Array.isArray(acceptance) || !validReport(full.structured)) continue;
        const met = new Set(acceptance.flatMap((text, i) => {
          const key = verificationItemKey(text);
          return key && reportRowOf(acceptance, full.structured.criteria, i + 1)?.status === 'met' ? [key] : [];
        }));
        for (const item of candidates) if (met.has(item.key)) resolved.add(itemId(item));
      }
      const open = snapshot.filter(item => item.index && !resolved.has(itemId(item)));
      // 后续轮次提示每次读取最多查十个任务状态，父链与候选轮次共用额度。
      const laterStatus = jobStatusLookup(signal, 10);
      for (const job of jobs.values()) {
        if (!open.length || job.execution_status !== 'completed' || job.context?.verification_of || !parentOf(job)) continue;
        const lookup = laterStatus(job.job_id);
        if (!lookup) break;
        try {
          const full = requireJobStatus(await lookup, job.job_id);
          if ((full.execution_status ?? full.status) !== 'completed' || !scope.includes(full.context.owner)) continue;
          for (const item of await laterRoundItems(full, open, laterStatus)) {
            const key = itemId(item);
            if (!laterMet.has(key)) laterMet.set(key, job.job_id);
          }
        } catch (error) {
          signal?.throwIfAborted();
          ctx.logger?.warn?.(`[codex-conductor] 未能核对后续轮次 ${job.job_id}：${error?.message ?? error}`);
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      ctx.logger?.warn?.(`[codex-conductor] 未能回查已接受的未完成项：${error?.message ?? error}`);
    }
    // runner 查询期间可能有新的复核，只移除刚才核实的那一条记录。
    const ledger = readLedger();
    if (!ledger) return null;
    const items = ledger.items.filter(item => !resolved.has(itemId(item)));
    const next = { ...ledger, items };
    if (items.length !== ledger.items.length) {
      try { saveLedger(next); }
      catch (error) { ctx.logger?.warn?.(`[codex-conductor] 未能保存销项后的未完成项台账：${error?.message ?? error}`); }
    }
    return view(next);
  }
  const autoAnswer = registerAutoAnswer({ ctx, settings: cfg.autoAnswer, directory: stateDirectory });
  // 工作区（侧栏分组）、目标和会话都是可选的宿主服务，取不到时相应步骤降级。
  const workspaces = () => ctx.get?.('workspaceRegistry');
  const autoHandover = createAutoHandover({ directory: stateDirectory, settings: () => cfg.autoHandover, aliases, logger: ctx.logger,
    goals: () => ctx.get?.('goals'), agentOf: (id) => ctx.get?.('agents')?.get?.(id), workspaces,
    runningJobs: async (owner) => {
      const page = await conductor.list({ owner, also_owners: aliases.predecessors(owner), status: 'running', limit: 1 });
      if (!Number.isSafeInteger(page?.total)) throw new Error(page?.error ?? page?.error_kind ?? '任务列表不可用');
      return page.total;
    } });
  // 结案验收的结果分类：all_met（全部 met，自标未满足的有依据）、accepted_open（未满足但接受）、rejected_unsupported（缺独立依据被拒），
  // 按会话和总数累计到 closeout-stats.json，codex_runtime 显示。
  const closeoutStatsFile = stateDirectory && path.join(stateDirectory, 'closeout-stats.json');
  const countCloseout = (owner, kind, amount = 1, repeatJobId) => {
    if (!closeoutStatsFile) return;
    try {
      let stats;
      try { stats = JSON.parse(readFileSync(closeoutStatsFile, 'utf8')); } catch {}
      if (!stats || typeof stats !== 'object') stats = { since: new Date().toISOString(), total: {}, sessions: {} };
      if (repeatJobId) {
        // 同一笔写入保存任务号和计数，后台通知与热重载重读共用。
        const counted = stats.repeat_blocked_jobs ??= [];
        if (counted.includes(repeatJobId)) return;
        counted.push(repeatJobId);
      }
      stats.total[kind] = (stats.total[kind] ?? 0) + amount;
      const mine = stats.sessions[owner] ??= {};
      mine[kind] = (mine[kind] ?? 0) + amount;
      stats.updatedAt = new Date().toISOString();
      mkdirSync(path.dirname(closeoutStatsFile), { recursive: true });
      writeJsonAtomic(closeoutStatsFile, stats);
    } catch {}
  };
  // 新派活的验收标准条数：超过 acceptanceWarnAbove 时提醒一句（不拦截），并累计到 acceptance-stats.json 供日后对比。
  const acceptanceStatsFile = stateDirectory && path.join(stateDirectory, 'acceptance-stats.json');
  const acceptanceHint = (args) => {
    if (args?.resume || !Array.isArray(args?.acceptance)) return '';
    const items = args.acceptance.length;
    const limit = cfg.acceptanceWarnAbove ?? 0;
    const over = limit > 0 && items > limit;
    if (acceptanceStatsFile) try {
      let stats;
      try { stats = JSON.parse(readFileSync(acceptanceStatsFile, 'utf8')); } catch {}
      if (!stats || typeof stats !== 'object') stats = { since: new Date().toISOString(), dispatches: 0, items: 0, over: 0 };
      Object.assign(stats, { dispatches: stats.dispatches + 1, items: stats.items + items, over: stats.over + (over ? 1 : 0),
        threshold: limit, updatedAt: new Date().toISOString() });
      mkdirSync(path.dirname(acceptanceStatsFile), { recursive: true });
      writeJsonAtomic(acceptanceStatsFile, stats);
    } catch {}
    return over ? `[验收条数] 这单带了 ${items} 条验收标准（提醒阈值 ${limit}）。下次先按共同前置拆单，只留本轮可取证的必验结果；` +
      '偏好写进 task 正文。' : '';
  };
  // 超过阈值时给规划端一行提示，每个回合最多一次；规划端自己不发起交接。
  const hintedTurns = new Map();
  const handoverHint = (agent) => {
    const value = history.observe(agent);
    if (!value?.suggest) return '';
    const log = agent.session.log;
    let turn;
    for (let i = log.length - 1; i >= Math.max(0, log.length - 200) && turn === undefined; i--) turn = log[i]?.data?.turn;
    if (hintedTurns.get(agent.id) === turn) return '';
    if (hintedTurns.size > 500) hintedTurns.clear();
    hintedTurns.set(agent.id, turn);
    const why = value.contextFull ? `最近 20 次请求的上下文都在 ${value.floor} token 以上（阈值 ${value.contextThreshold}），压缩已降不下来`
      : `已有 ${value.messages} 条消息，超过 ${value.threshold} 条`;
    return `[建议交接] 本会话${why}，每一步都会变慢。请在给用户的汇报里说一句：` +
      '操作员可以把本会话交接到新会话继续。你不要自己发起交接。';
  };
  const restrictedReads = exec => cfg.plannerReads === 'products' && inWorkspace(sessionCwd(exec), cfg.roots);
  const rememberJob = (value, owner = value.context?.owner) => {
    if (!owner || !value.job_id) return;
    if (productJobs.size >= 10_000) productJobs.delete(productJobs.keys().next().value);
    productJobs.set(value.job_id, owner);
  };
  const rememberProducts = (value, owner = value.context?.owner) => {
    if (cfg.plannerReads === 'products') rememberJob(value, owner);
    if (cfg.plannerReads === 'products' && owner && !unknownState(value) && ['completed', 'failed', 'cancelled'].includes(value.status) &&
        (!value.context?.owner || owns(owner, value.context.owner))) productReads.add(owner, productPaths(value));
  };
  const checkJobOwner = (value, exec, tool) => {
    if (!unknownState(value)) rememberJob(value);
    if (!owns(exec?.agent?.id, value.context?.owner ?? productJobs.get(value.job_id)) || unknownState(value)) {
      throw new Error(`${tool}: 暂时无法确认任务属于本会话，不能读取它的产物；请用 codex_jobs 查本会话的任务。`);
    }
    rememberProducts(value, exec.agent.id);
  };
  async function ensureOwnJob(jobId, exec, tool) {
    if (!restrictedReads(exec) || owns(exec?.agent?.id, productJobs.get(jobId))) return;
    if (productJobs.has(jobId)) throw new Error(`${tool}: 任务不属于本会话，不能读取它的产物；请用 codex_jobs 查本会话的任务。`);
    const source = await conductor.waitJob(jobId, 0, exec?.signal);
    checkJobOwner(source, exec, tool);
    return source;
  }
  if (plannerFile && !existsSync(plannerFile)) try {
    mkdirSync(path.dirname(plannerFile), { recursive: true });
    writeFileSync(plannerFile, PLANNER_TEMPLATE);
  } catch {}
  // 给 Codex 的固定要求：每次派单时现读，改完下一单就生效
  cfg.executorPromptFile ||= plannerFile ? path.join(path.dirname(plannerFile), 'executor-prompt.md') : '';
  if (cfg.executorPromptFile && !existsSync(cfg.executorPromptFile)) try {
    mkdirSync(path.dirname(cfg.executorPromptFile), { recursive: true });
    writeFileSync(cfg.executorPromptFile, EXECUTOR_TEMPLATE);
  } catch {}
  // 面板里的 Gemini 写作记录：gemini_write 没有 runner 任务，单独留最近 200 条
  const geminiHistoryFile = stateDirectory ? path.join(stateDirectory, 'gemini-history.jsonl') : '';
  const recordGemini = (value, session) => {
    if (!geminiHistoryFile) return;
    try {
      const lines = existsSync(geminiHistoryFile) ? readFileSync(geminiHistoryFile, 'utf8').split('\n').filter(Boolean) : [];
      lines.push(JSON.stringify({ at: new Date().toISOString(), session: session ?? null, output: value.output ?? null, status: value.status,
        ...(value.background ? { id: value.id, background: true } : {}),
        chars: value.chars ?? value.before_rollback?.chars ?? null, attempts: value.attempts ?? null,
        error: typeof value.error === 'string' ? value.error.slice(0, 300) : null,
        draft_path: value.draft_path ?? null, duration_s: value.duration_s ?? null }));
      mkdirSync(path.dirname(geminiHistoryFile), { recursive: true });
      writeFileSync(geminiHistoryFile, `${lines.slice(-200).join('\n')}\n`);
    } catch {}
  };
  // 经 ctx.get 取服务（没列进 inject 时 ctx.systemPrompt 取不到），登记随插件卸载自动撤销。
  // 同名段已登记（新旧实例同时在）会抛错，这时只放弃注入，不连累其余功能；
  // 组装出错会让所有请求失败，所以 text 里不抛错（plannerPrompt 读不了就返回空）
  let plannerInjected = false;
  if (plannerFile) try {
    const engineGuide = !cfg.gemini ? '' : cfg.lockEngine ? `- ${engineGuidance(cfg)}`
      : plannerPrompt(fileURLToPath(new URL('./engine-prompt.md', import.meta.url)));
    ctx.get?.('systemPrompt')?.section({ name: 'codex-conductor:planner', order: 10100, interpolate: false,
      text: () => plannerSection([engineGuide, plannerPrompt(plannerFile)].filter(Boolean).join('\n\n')) });
    plannerInjected = Boolean(ctx.get?.('systemPrompt'));
  } catch (error) {
    ctx.logger?.warn?.(`[codex-conductor] 规划要求没能注入系统提示词：${error?.message ?? error}`);
  }
  // 这个 runner 任务仍在进行的 DSH 后台任务。按 DSH 任务表查而不记在插件内存里：
  // 插件热重载后旧的后台任务和它的等待循环仍在，内存记录却清空了，会重复登记、重复送回结果
  // 省略 jobId 时查询当前 agent 的任一 Codex 任务。
  function liveBackground(jobId, exec, includeSettled = false) {
    const owner = exec?.agent?.id;
    const jobs = owner === undefined ? undefined : ctx.get?.('jobs');
    // 标签是「Codex <job_id>」或后面再跟「 · 任务摘要」
    const base = `Codex ${jobId}`;
    const job = jobs?.list(owner).find((j) => j.owner === owner && j.kind === 'codex' &&
      (!jobId || j.label === base || j.label?.startsWith(`${base} · `)) &&
      (includeSettled || j.status === 'running' || j.status === 'stopping'));
    return job && { jobs, id: job.id, owner };
  }

  function outputEntry(jobId, logDir) {
    const dir = (logDir || (cfg.runnerHome && `${cfg.runnerHome}/jobs/${jobId}`)).replace(/\/$/, '');
    const paths = dir ? `完整报告：${dir}/last_message.txt\n完整结果：${dir}/result.json\n`
      : '完整路径尚未确认；可用 codex_output 的 result 查看 runner 返回的 log_dir。\n';
    return `\n--- 完整结果入口 ---\nrunner job_id: ${jobId}\n${paths}` +
      `可重复分页读取：codex_output ${JSON.stringify({ job_id: jobId, artifact: 'report', offset: 0, limit: 8000 })}\n` +
      '原始结果或原任务背景可将 artifact 改为 result 或 context；继续读取时使用返回的 next_offset。';
  }

  const jobService = ctx.get?.('jobs');
  const verificationState = hostVerifications.get(jobService) ?? { starts: new Map(), automatic: new Map() };
  if (jobService) hostVerifications.set(jobService, verificationState);
  const { starts: verificationStarts, automatic: autoVerifications } = verificationState;
  const automaticCandidate = (job) => job.job_id && job.context?.owner && job.context.write === true &&
    !job.context.verification_of && (job.execution_status ?? job.status) === 'completed' &&
    (job.verification_status == null || job.verification_status === 'unreviewed') && job.report_status !== 'invalid';
  const eligibleForAutoVerification = (value) => automaticCandidate(value) && value.verification_status === 'unreviewed' &&
    !beforeCutoff(value, autoVerifyFrom) && validReport(value.report) && (flaggedCriteria(value).length || value.context.must_verify?.length) &&
    !(cfg.autoVerifySkipQuestions && awaitingAnswers(value));
  const autoVerifyWarning = (error) => ctx.logger?.warn?.(`[codex-conductor] 补派自动核验失败：${error?.message ?? error}`);

  async function hasLaterRound(source) {
    const id = source.job_id;
    const owner = lastSuccessor(aliases, source.context?.owner) ?? source.context?.owner;
    const list = async filters => {
      const page = await conductor.list(cfg.verificationReuse ? { owner, also_owners: aliases.predecessors(owner), ...filters } : filters);
      if (page.error_kind || !Array.isArray(page.jobs)) {
        throw new Error(`无法核对后续轮次：${page.error ?? page.error_kind ?? '任务列表不可用'}`);
      }
      return cfg.verificationReuse ? { ...page, jobs: page.jobs.filter(job => owns(owner, job.context?.owner)) } : page;
    };
    const children = await list({ parent_job: id, limit: 1 });
    if (children.jobs.some(job => job.parent_job_id === id || job.context?.continuation?.parent_job_id === id)) return true;
    if (!source.thread_id || !Number.isFinite(source.started_at)) return false;
    for (let offset = 0; offset !== null;) {
      const page = await list({ thread_id: source.thread_id, limit: 100, offset });
      if (page.jobs.some(job => !job.context?.verification_of && job.job_id !== id &&
          job.thread_id === source.thread_id && job.started_at > source.started_at)) return true;
      offset = page.next_offset ?? null;
    }
    return false;
  }

  // 热重载后，旧实例里等任务结果的循环还在。它若自己派核验或接替，就按过时的配置派单：2026-11-22 配置改回 Neon Medium 后，
  // 旧实例仍按 High 自动派了一单核验。卸载后不再自动派单，核验由新实例的补扫（加载时和各会话下一次调用工具时）接上。
  let disposed = false;
  ctx.effect?.(() => () => { disposed = true; });
  async function withAutoVerification(value, exec, { source, catchup = false } = {}) {
    if (cfg.autoVerify === 'off' || disposed) return value;
    const id = value.job_id;
    if (!eligibleForAutoVerification(value)) return value;
    let pending = autoVerifications.get(id);
    if (catchup && pending) {
      const receipt = await pending;
      if (receipt?.auto_verify.job_id || autoVerifications.get(id) !== pending) return value;
      // 满额或启动失败的回执可在下次扫描时重试。
      pending = undefined;
    }
    if (!pending) {
      pending = (async () => {
        const originalOwner = value.context.owner;
        let owner = lastSuccessor(aliases, originalOwner) ?? originalOwner;
        const skipped = (reason, key = 'skipped') => {
          countCloseout(owner, 'auto_verify_skipped');
          if (catchup) autoVerifyWarning(`${id}：${reason}`);
          return { auto_verify: { [key]: reason }, line: `插件未自动派出对 ${id} 的核验：${reason}。之后可用 codex_verify ${id}。` };
        };
        try {
          const current = source ?? await conductor.waitJob(id, 0);
          if (unknownState(current)) return skipped(current.error ?? current.error_kind ?? current.status, 'error');
          if (!source && !eligibleForAutoVerification(withReport(current))) return;
          if (cfg.verificationReuse && withoutVerificationProduct(current)) {
            const reason = `任务 ${id} 受阻，未记录改动或可核验结果。先解除阻塞。`;
            return { auto_verify: { skipped: reason }, line: reason };
          }
          if (await hasLaterRound(current)) {
            return catchup ? undefined : skipped('已有后续轮次');
          }
          owner = lastSuccessor(aliases, current.context.owner) ?? current.context.owner;
          const agent = exec?.agent?.id === owner ? exec.agent : ctx.get?.('agents')?.get?.(owner) ?? { id: owner };
          const result = await verifyTool.execute({ job_id: id, wait_seconds: 0 }, { agent, [automaticVerification]: current });
          if (result.existing_verification) return catchup ? undefined : skipped(`已存在核验 ${result.job_id}（${result.status}）`);
          if (!result.job_id || unknownState(result)) return skipped(result.error ?? result.error_kind ?? result.status, 'error');
          countCloseout(owner, 'auto_verify_started');
          if (catchup) countCloseout(owner, 'auto_verify_catchup');
          const line = `插件已自动派出对 ${id} 的只读核验 ${result.job_id}` + (result.status === 'running'
            ? `，正在跑。现在就可以记 codex_review ${id}：报告标为未满足的条目照实保留并写 accepted（缺依据会挂起，核验结束后通知里给出判定和可直接提交的复核），然后可以去派与 ${id} 写入范围不重叠的下一单（收尾护栏照常核对）；不必等核验。`
            : `，状态 ${result.status}；核验结束后按结论记 codex_review ${id}。`);
          return { auto_verify: { job_id: result.job_id, status: result.status }, line };
        } catch (error) {
          return skipped(String(error?.message ?? error));
        }
      })();
      autoVerifications.set(id, pending);
    }
    const receipt = await pending;
    if (!receipt) {
      if (autoVerifications.get(id) === pending) autoVerifications.delete(id);
      return value;
    }
    return { ...value, auto_verify: receipt.auto_verify, next: [value.next, receipt.line].filter(Boolean).join('\n') };
  }

  const completionLedgerItems = (jobId, owner) => {
    const scope = aliases.owners(owner);
    return scope.length ? (readLedger()?.items ?? []).filter(item =>
      item.index && item.job_id !== jobId && scope.includes(item.session)) : [];
  };

  async function laterRoundNotices(value, exec, items) {
    if (value.context?.write !== true || (value.execution_status ?? value.status) !== 'completed' ||
        !parentOf(value) || !owns(exec?.agent?.id, value.context.owner)) return [];
    const id = value.job_id;
    try {
      const matches = await laterRoundItems(value, items ?? completionLedgerItems(id, exec.agent.id), jobStatusLookup(exec?.signal));
      return ledgerJobIds(matches).map(parent => {
        const indices = matches.filter(item => item.job_id === parent).map(item => item.index).sort((a, b) => a - b);
        return `${id} 报告了 ${parent} 第 ${indices.join('、')} 条已满足（${parent} 的这些条目仍记为未完成）；` +
          `记 ${id} 的结案复核时把它们记 met 即可同时销掉 ${parent} 的未完成项。`;
      });
    } catch (error) {
      ctx.logger?.warn?.(`[codex-conductor] 未能核对后续轮次 ${id} 的完成提示：${error?.message ?? error}`);
      return [];
    }
  }

  async function observeParkedReview(value) {
    const { job_id: verificationId } = value;
    // 核验记录已清理或损坏时也按已结束处理，挂起条目不会一直卡住。
    if (!['unknown_job', 'invalid_record'].includes(value.error_kind) && cancelUnconfirmed(value)) return;
    const prior = parkedEvaluations.get(verificationId);
    if (prior?.pending) return prior.result;
    const entry = readParkedReviews()?.find(e => e.verification_id === verificationId);
    if (!entry) return prior?.result;
    const evaluation = { job_id: entry.job_id, verification_id: verificationId, owner: entry.owner, pending: true };
    evaluation.result = evaluateParkedReview(entry).catch(parkedWarning).then(receipt => {
      evaluation.pending = false;
      if (!receipt) parkedEvaluations.delete(verificationId);
      return receipt;
    });
    parkedEvaluations.set(verificationId, evaluation);
    return evaluation.result;
  }

  async function evaluateParkedReview(entry) {
    const { job_id, owner: storedOwner, verification_id, review, park_support, at } = entry;
    const successor = () => lastSuccessor(aliases, storedOwner) ?? storedOwner;
    let prepared;
    const outcome = (outcome, line) => ({ parked_review: { job_id, outcome }, line: `${job_id} 的挂起复核${line}` });
    let source = await conductor.waitJob(job_id, 0);
    // runner 读不到 reviews.json 时 verification_status 为 invalid：暂时状态，留到下次再判。
    const unavailable = value => (value.error_kind !== 'unknown_job' && unknownState(value)) || value.verification_status === 'invalid';
    if (unavailable(source)) return;
    let owner = successor();
    let owned = source.error_kind !== 'unknown_job' && owns(owner, source.context?.owner);
    if (owned && !(source.verification?.time > at)) {
      const supports = await criterionSupport(source, owner, [], undefined, true, true);
      const openSupport = { ...supports.openSupport };
      for (const [key, kinds] of Object.entries(park_support)) openSupport[key] = [...new Set([...kinds, ...(openSupport[key] ?? [])])];
      prepared = prepareReview(review, { ...source, evidenceLevel: evidenceLevel(source), openLevel: openEvidenceLevel(source), ...supports, openSupport });
      const ownerProblem = await ownerReviewProblem(source, prepared, owner);
      if (ownerProblem) prepared.problems = [ownerProblem];
      // 依据查询期间可能已有人工复核。读到确定状态之后再认领。
      source = await conductor.waitJob(job_id, 0);
      if (unavailable(source)) return;
      owner = successor();
      owned = source.error_kind !== 'unknown_job' && owns(owner, source.context?.owner);
    }

    // 准备好结论后同步认领。核验期间重提时改为评估新条目。
    const entries = readParkedReviews();
    const current = entries?.find(e => e.job_id === job_id && e.verification_id === verification_id);
    if (!current) return;
    if (JSON.stringify(current) !== JSON.stringify(entry)) return evaluateParkedReview(current);
    writeJsonAtomic(parkedFile, entries.filter(e => e !== current));
    if (owned && source.verification?.time > at) return outcome('superseded', '已有更新的复核，已跳过。');
    if (owned && !prepared.problems.length) {
      countCloseout(owner, 'parked_ready');
      return outcome('ready', `按核验结论可以通过，原样提交即可：${JSON.stringify({ job_id, ...prepared.review })}`);
    }
    countCloseout(owner, 'parked_rejected');
    const reason = source.error_kind === 'unknown_job' ? '原任务已清理或不存在。'
      : owned ? reviewRejection(job_id, source, prepared) : '无法确认原任务归属。';
    return outcome('rejected', `按核验结论不能通过：${reason}`);
  }

  async function scanParkedReviews(owner, signal) {
    const entries = (readParkedReviews() ?? []).filter(e => !parkedEvaluations.get(e.verification_id)?.pending);
    const pending = [...parkedEvaluations.values()].filter(e => e.pending && (!owner || owns(owner, e.owner)));
    await Promise.all([...pending.map(e => e.result), ...entries.map(async ({ verification_id }) => {
      const value = await conductor.waitJob(verification_id, 0, signal);
      await observeParkedReview(value);
    })]);
  }

  // shortcut: 只记在内存里，重载插件即解除；重载后第一单 Codex 失败会重新记上。
  let codexQuota = 0;
  async function withCompletionNotices(value, exec, { allowFallback = true } = {}) {
    // 只认配置的那个模型通道报的额度：单次指定的其他通道用完，不该停掉所有 Codex。
    if (value.status === 'failed' && jobEngine(value) === 'codex' &&
        (!cfg.model || !value.task_options?.model || value.task_options.model === cfg.model)) {
      codexQuota = Math.max(codexQuota, codexQuotaUntil(value.error, value.finished_at));
    }
    const terminal = ['completed', 'failed', 'cancelled'].includes(value.status) && !unknownState(value);
    const blockLine = terminal && repeatBlockLine(value.repeat_guard?.blocks);
    const standingLine = terminal && repeatStandingLine(value.repeat_guard?.standing);
    const owner = value.context?.owner ?? exec?.agent?.id;
    if (blockLine && owner && value.job_id) countCloseout(owner, 'repeat_blocked', 1, value.job_id);
    const [result, notices, parked, fallback] = await Promise.all([withAutoVerification(value, exec), laterRoundNotices(value, exec),
      value.context?.verification_of && owns(exec?.agent?.id, value.context.owner) ? observeParkedReview(value).catch(parkedWarning) : undefined,
      allowFallback ? fallbackOnFailure(value, exec) : undefined]);
    const next = parked && !['executor_lost', 'verification_tree_changed', 'provider_permanent'].includes(value.error_kind)
      ? [parked.line] : [result.next, parked?.line];
    return notices.length || parked || blockLine || standingLine || fallback ? {
      ...result, ...(parked ? { parked_review: parked.parked_review } : {}), ...(fallback ? { fallback: fallback.receipt } : {}),
      next: [...next, blockLine, standingLine, ...notices, fallback?.line].filter(Boolean).join('\n') } : result;
  }

  const fallbacks = new Map();
  async function fallbackOnFailure(source, exec) {
    const { job_id: parent, context, task_options: options, sandbox } = source;
    if (disposed || !cfg.gemini?.command || cfg.geminiFallback === false || source.status !== 'failed' ||
        source.fallback_safe !== true || jobEngine(source) !== 'codex' || !parent || !context?.owner ||
        !owns(exec?.agent?.id, context.owner)) return;
    if (fallbacks.has(parent)) return fallbacks.get(parent);
    const attempt = (async () => {
      try {
        const continuation = { parent_job_id: parent, answers: context.continuation?.answers ?? [],
          resolution: context.continuation?.resolution ?? '' };
        const task = [previousRoundBrief(source), `Codex 终止类别：${source.error_kind ?? '未知'}。runner 核对没有观察到原任务写入。`,
          ...continuation.answers.map(({ id, answer }) => `已有答复 ${id}：${answer}`), continuation.resolution].filter(Boolean).join('\n\n');
        const agent = context.owner === exec.agent.id ? exec.agent : { id: context.owner };
        const child = await dispatch({
          engine: 'gemini', task, cwd: source.cwd, write: context.write, acceptance: context.acceptance,
          must_verify: context.must_verify, scope: source.scope_paths ?? source.scope ?? [],
          writable_roots: options?.writable_roots ?? [], host_access: sandbox === 'danger-full-access', wait_seconds: 0,
        }, { agent }, continuation, context.task, context.verification_of, undefined, undefined, { parent: source, fallbackOf: parent });
        if (!child.job_id || unknownState(child)) throw new Error(child.error ?? child.error_kind ?? child.status);
        if (child.error_kind === 'worker_start_failed') {
          return { receipt: { job_id: child.job_id, engine: 'gemini', status: child.status },
            line: `Gemini 接替任务 ${child.job_id} 未启动：${child.error}。可重新查询原任务触发接替。` };
        }
        return { receipt: { job_id: child.job_id, engine: 'gemini', status: child.status },
          line: `Codex 任务 ${parent} 因 ${source.error_kind ?? '上游失败'} 终止。已转交 Gemini 任务 ${child.job_id}。${waitForJob(child.job_id)}` };
      } catch (error) {
        return { receipt: { error: String(error?.message ?? error) }, line: `Gemini 接替未启动：${error?.message ?? error}。` };
      }
    })();
    fallbacks.set(parent, attempt);
    try { return await attempt; } finally { fallbacks.delete(parent); }
  }

  async function scanAutoVerifications(limit, owner) {
    const jobs = [];
    // 从截止时间前七天起扫描，覆盖长时间排队后跨过截止时间才结束的任务。
    const filters = { ...(owner ? { owner, also_owners: aliases.predecessors(owner) } : {}),
      started_between: [autoVerifyFrom - 7 * 86_400, Date.now() / 1000 + 86_400] };
    for (let offset = 0; offset !== null;) {
      const page = await conductor.list({ ...filters, limit: 100, offset });
      if (page.error_kind || !Array.isArray(page.jobs)) throw new Error(page.error ?? page.error_kind ?? '任务列表不可用');
      jobs.push(...page.jobs);
      offset = page.next_offset ?? null;
    }
    const byId = new Map(jobs.map(job => [job.job_id, job]));
    const currentOwners = new Map();
    const currentOwner = job => {
      const id = job.context?.owner;
      if (!currentOwners.has(id)) currentOwners.set(id, lastSuccessor(aliases, id) ?? id);
      return currentOwners.get(id);
    };
    const threadKey = job => cfg.verificationReuse ? JSON.stringify([currentOwner(job), job.thread_id]) : job.thread_id;
    const linked = new Set(jobs.flatMap(job => [parentOf(job), job.context?.verification_of].filter(id =>
      id && (!cfg.verificationReuse || (byId.has(id) && currentOwner(job) === currentOwner(byId.get(id)))))));
    const latestStart = new Map();
    for (const job of jobs) {
      if (job.thread_id && !job.context?.verification_of && Number.isFinite(job.started_at) &&
          job.started_at > (latestStart.get(threadKey(job)) ?? -Infinity)) latestStart.set(threadKey(job), job.started_at);
    }
    let started = 0;
    for (const job of jobs) {
      if (!automaticCandidate(job) || linked.has(job.job_id) || latestStart.get(threadKey(job)) > job.started_at ||
          (Number.isFinite(job.finished_at) && beforeCutoff(job, autoVerifyFrom))) continue;
      // 列表行不带 must_verify 和原报告，完整状态也供后续派单使用。
      const source = await conductor.waitJob(job.job_id, 0);
      if (unknownState(source)) {
        autoVerifyWarning(`${job.job_id}：${source.error ?? source.error_kind ?? source.status}`);
        continue;
      }
      const result = await withAutoVerification(withReport(source), undefined, { source, catchup: true });
      if (result.auto_verify?.job_id && ++started >= limit) return;
    }
  }

  const lastAutoVerifyScan = hostAutoVerifyScans.get(stateDirectory) ?? new Map();
  hostAutoVerifyScans.set(stateDirectory, lastAutoVerifyScan);
  async function catchUpAutoVerifications(owner) {
    if (!owner) return;
    const parkedScan = scanParkedReviews(owner).catch(parkedWarning);
    const now = Date.now();
    if (cfg.autoVerify === 'off' || now - (lastAutoVerifyScan.get(owner) ?? -Infinity) < 60_000) return parkedScan;
    lastAutoVerifyScan.set(owner, now);
    await Promise.all([parkedScan, scanAutoVerifications(1, owner).catch(autoVerifyWarning)]);
  }

  // log 通道只供原生面板观察，job_output 过滤它，模型只收到一次最终 result。
  async function watch(jobId, handle, finish, state, exec) {
    const publish = (value) => {
      const warning = value.status === 'monitor_failed' && state.cancelNotice ? `\n${state.cancelNotice}` : '';
      const lookup = value.status === 'monitor_failed'
        ? `codex_status ${JSON.stringify({ job_id: jobId })}`
        : `codex_output ${JSON.stringify({ job_id: jobId, artifact: value.report_status === 'valid' ? 'report' : 'result' })}`;
      const entry = value.error_kind === 'executor_lost' ? `\n--- 完整结果入口 ---\n${lookup}` : outputEntry(jobId, state.logDir);
      const text = render(value)[0].text + warning + entry;
      handle.append(`${text}\n`, { channel: 'log' });
      return { status: JOB_STATUS[value.status] ?? 'failed', detail: `${summaryLine(value)} · ${lookup}`, result: text };
    };
    let bridgeErrors = 0;
    const progress = (value) => {
      bridgeErrors = 0;
      if (value.log_dir) state.logDir = value.log_dir;
      const phase = { lock_wait: '排队等待目录写锁', engine_wait: '排队等待 Gemini 名额', router_check: '检查路由', codex_running: 'Codex 执行中', codex_reconnecting: 'Codex 正在重连模型服务', retry_wait: '等待重试', finalizing: '整理最终结果' }[value.phase] ?? value.phase;
      const stage = [phase, value.attempt > 0 && `第 ${value.attempt} 轮`,
        value.last_error_kind && `上次错误 ${value.last_error_kind}`,
        value.retry_at != null && `约 ${Math.max(0, Math.ceil(value.retry_at - Date.now() / 1000))} 秒后重试`]
        .filter(Boolean).join(' · ') || 'Codex 执行中';
      state.progress = value.phase === 'codex_reconnecting' ? stage
        : `${stage}，距上次活动 ${value.seconds_since_last_event ?? '?'} 秒：${value.last_activity ?? '启动中'}`;
      handle.updateProgress([state.cancelNotice, state.progress].filter(Boolean).join('\n'));
      const stageKey = JSON.stringify([value.phase, value.attempt, value.last_error_kind, value.retry_at]);
      if (stageKey !== state.lastStage) {
        handle.append(`${stage}\n`, { channel: 'log' });
        state.lastStage = stageKey;
      }
    };
    try {
      for (;;) {
        const value = withReport(await conductor.waitJob(jobId, BG_WAIT, undefined, progress));
        if (value.log_dir) state.logDir = value.log_dir;
        if (unknownState(value) && value.error_kind !== 'bridge_error') {
          throw new Error([value.error_kind ?? value.status, value.error].filter(Boolean).join(': '));
        }
        if (value.status === 'running') {
          progress(value);
          continue;
        }
        // 一次 wsl.exe 出错（含电脑睡眠唤醒、发行版重启瞬间）不代表任务结束，连续多次才放弃
        if (value.error_kind === 'bridge_error') {
          if (++bridgeErrors < 3) continue;
          throw new Error(value.error);
        }
        return publish(await finish(value, exec));
      }
    } catch (error) {
      const lost = withReport({ job_id: jobId, status: 'monitor_failed', error: String(error?.message ?? error) });
      lost.next = nextStep(lost, undefined, undefined, cfg);
      return publish(lost);
    } finally {
      state.settled = true;
    }
  }

  // 登记 DSH 后台任务（同一个 runner 任务只登记一个），结束后由 DSH 把结果送回会话；
  // 没有 jobs 服务、没有 agent 或登记失败时返回 undefined，调用方直接等待 runner。
  // label：任务表里这一行的标题，带上任务摘要才看得出是哪件事；codex_status 补登记时不知道任务，只用 job_id
  function background(jobId, exec, finish, label = `Codex ${jobId}`) {
    if (!exec?.agent) return undefined;
    try {
      const live = liveBackground(jobId, exec);
      if (live) return live;
      const jobs = ctx.get?.('jobs');
      if (!jobs) return undefined;
      const owner = exec.agent.id;
      const state = {};
      const id = jobs.start({
        owner, kind: 'codex', label, outputLimitBytes: 65536,
        run: (handle) => {
          const cancelNotice = (reason) => {
            if (state.settled) return;
            state.cancelNotice = `取消未确认 · runner job_id: ${jobId}：${reason}；` +
              `任务可能仍在运行，用 codex_jobs 核对正确 job_id，再用 codex_status 查询 ${jobId}，` +
              `或 codex_cancel 再取消 ${jobId}，不要重派。`;
            handle.updateProgress([state.cancelNotice, state.progress].filter(Boolean).join('\n'));
            handle.append(`${state.cancelNotice}\n`, { channel: 'log' });
          };
          return {
            done: watch(jobId, handle, finish, state, exec),
            cancel: () => {
              cancelNotice('正在请求 runner 取消');
              return conductor.cancel(jobId).then((value) => {
                if (cancelUnconfirmed(value)) {
                  cancelNotice([value.error_kind ?? value.status, value.error].filter(Boolean).join(': '));
                }
              }).catch((error) => cancelNotice(String(error?.message ?? error)));
            },
          };
        },
      });
      return { jobs, id, owner };
    } catch {
      return undefined;
    }
  }

  // 等 runner 任务的结果。有后台任务时经 DSH 任务表等：结算时这次等待算作已被等到，DSH 就不会再把同一结果作为通知补发
  async function collect(jobId, bg, seconds, signal) {
    seconds = Math.min(seconds, 86_400);
    if (bg) {
      let view;
      try {
        view = await queryWithTimeout((signal) => bg.jobs.wait(bg.id, Math.max(1, seconds * 1000), bg.owner, signal),
          signal, seconds * 1000 + QUERY_TIMEOUT_MS);
      } catch (error) {
        // 只撤销这次观察，后台任务及其空闲会话通知继续保留。
        if (signal?.aborted) {
          throw new Error(`Codex 任务 ${jobId} 的等待已被中止；仅停止观察，未取消任务。${waitForJob(jobId)}`);
        }
        throw error;
      }
      // 第一次刷新进度（约 20 秒）前 progress 还没有；DSH 要求工具结果是无损 JSON，不能带值为 undefined 的字段
      if (view.status === 'running' || view.status === 'stopping') {
        return { job_id: jobId, status: 'running', ...(view.progress ? { last_activity: view.progress } : {}) };
      }
      // 结算时存下的是 codex_run 渲染好的完整结果（含 acceptance 和 out_of_scope），runner 重查拿不到这些；
      // 这次等待已算作被等到，DSH 不会再作为通知送回，所以在这里原样交回（结果只给一次，再读就回退到 runner）
      const rendered = bg.jobs.read?.(bg.id, bg.owner)?.result;
      // 后台监控自己出错时存的只是「先查询」的提示，改查 runner 拿真实状态（仍在运行会重新登记）
      if (typeof rendered === 'string' && !rendered.startsWith('monitor_failed')) {
        return { job_id: jobId, status: /^\S+/.exec(rendered)?.[0], rendered };
      }
    }
    // 后台任务已结算时 runner 的结果文件已在，只查一次取完整结果
    return withReport(await conductor.waitJob(jobId, bg ? 0 : seconds, signal));
  }

  // 回执已消费，派核验不能占用状态查询的超时预算。
  async function verifyRendered(value, exec, source) {
    const { job_id: id, rendered } = value;
    let receipt = await autoVerifications.get(id);
    let parked = await parkedEvaluations.get(id)?.result;
    const items = value.status === 'completed' ? completionLedgerItems(id, exec?.agent?.id) : [];
    const auto = !receipt && cfg.autoVerify !== 'off';
    const checkParked = !parked && parkedFor(exec?.agent?.id).some(entry => entry.verification_id === id);
    const lines = [];
    if (auto || items.length || checkParked) {
      try {
        const current = source && source.status !== 'running' ? source : await conductor.waitJob(id, 0, exec?.signal);
        if (items.length) lines.push(...await laterRoundNotices(current, exec, items));
        if (checkParked) parked = await observeParkedReview(current).catch(parkedWarning);
        if (auto) {
          await withAutoVerification(withReport(current), exec, { source: current });
          receipt = await autoVerifications.get(id);
        }
      } catch (error) { autoVerifyWarning(error); }
    }
    if (receipt) lines.push(receipt.line);
    if (parked) lines.push(parked.line);
    return { ...value, ...(receipt ? { auto_verify: receipt.auto_verify } : {}),
      ...(parked ? { parked_review: parked.parked_review } : {}),
      rendered: [rendered, ...lines.filter(line => !rendered.includes(line))].join('\n') };
  }

  // 后台监控与本轮长等待共用同一任务；空闲会话仍能收到完成通知。
  const finishStatus = (value, exec) => {
    rememberProducts(value);
    return withCompletionNotices({ ...value, next: nextStep(value, undefined, undefined, cfg) }, exec);
  };

  function notifyOnDone(value, exec, finish) {
    if (value.status !== 'running' || !value.job_id) return value;
    const id = background(value.job_id, exec, finish)?.id;
    if (id === undefined) return value;
    const outputCall = `job_output(${JSON.stringify({ job_id: id })})`;
    return { ...value, background_job_id: id,
      note: `已登记为后台任务 ${id}。${waitForJob(value.job_id)}` +
        '会话空闲时，DSH 完成通知仍会唤醒会话。job_output 的 job_id 用 background_job_id；codex_status、codex_output 用 runner job_id。',
      next: `${waitForJob(value.job_id)}只有摘要、缺内容或截断时才用 ${outputCall} 补读，或用 codex_output 分页。` +
        '等待期间不要自己动手补做。' };
  }

  // 只有用过 conductor 的会话才查收尾：本实例加载后派过单，或会话记录里有派单调用；记录读不到时照查。
  const dispatchedSessions = new Set();
  const DISPATCH_TOOLS = /\b(?:codex_run|codex_continue|codex_verify)\b/;
  const usedConductor = (agent) => {
    const log = agent?.session?.log;
    return dispatchedSessions.has(agent?.id) || !Array.isArray(log) || log.some((e) => e?.type === 'tool/call' &&
      (DISPATCH_TOOLS.test(e.data?.name ?? '') || (e.data?.name === 'tool_call' && DISPATCH_TOOLS.test(String(e.data.arguments)))));
  };
  const goalArguments = (value) => {
    try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return undefined; }
  };
  // 收尾护栏：本会话有未收尾的已结束任务时返回拒绝说明，否则返回空串；读不到记录或判定出错时放行并记警告。
  // runner 任务号形如 YYYYMMDD-HHMMSS-xxxxxx，Codex 线程号是 UUID，两者不会重合。只读查询误传线程号时，
  // 解析为本会话（含交接前任）在该线程上最新的任务；验收、核验、续接、取消仍要求确切的任务号。
  const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  async function threadJob(id, exec, tool, signal) {
    if (!THREAD_ID.test(id)) return { jobId: id };
    const owner = exec?.agent?.id;
    const hint = `${tool}: ${id} 看起来是 Codex 线程号，不是任务号（job_id）；线程号只用于 codex_run 的 resume，任务号请用 codex_jobs 查。`;
    if (!owner) throw new Error(hint);
    const page = await conductor.list({ owner, also_owners: aliases.predecessors(owner), thread_id: id, limit: 1 }, signal);
    const latest = Array.isArray(page.jobs) ? page.jobs[0]?.job_id : undefined;
    if (!latest) throw new Error(`${hint}本会话没有这个线程上的任务。`);
    return { jobId: latest, note: `按线程 ${id} 解析为任务 ${latest}（本会话在该线程上最新的任务${page.total > 1 ? `，该线程共 ${page.total} 单` : ''}）；以后请直接传任务号。` };
  }

  // 续接时是否开新线程：回答阻塞问题是对话，始终沿用原线程；其余按 fresh 参数或原线程大小决定。
  // 新线程只拿到 prepareContinuation 写好的上轮交接内容（原任务、验收、上轮差距、核验意见、改动文件），不重发旧线程历史。
  async function continuationThread(plan, args, signal) {
    const thread = plan.args.resume;
    if (!thread) return null;
    // 回答阻塞问题默认沿用原线程（是对话）；规划端明确 fresh:true 时开新线程，回答写在交接内容里。
    if (plan.continuation.answers.length && args.fresh !== true) return { mode: 'resume', reason: 'answers', parent_thread_id: thread };
    if (args.fresh === false) return { mode: 'resume', reason: 'requested', parent_thread_id: thread };
    if (args.fresh === true) return { mode: 'fresh', reason: 'requested', parent_thread_id: thread };
    const limit = cfg.continueFreshAboveTokens ?? 0;
    if (!limit) return null;
    let size;
    try { size = (await conductor.threadSize(thread, signal))?.last_input_tokens; } catch { signal?.throwIfAborted(); }
    if (!Number.isSafeInteger(size)) return { mode: 'resume', reason: 'size_unknown', parent_thread_id: thread };
    return { mode: size > limit ? 'fresh' : 'resume', reason: 'size', parent_thread_id: thread, parent_last_input_tokens: size, threshold: limit };
  }

  // resume 指向的线程上本会话（含交接前任）最新的任务；这个任务若已被开新线程的续接接替，沿接替链走到最新的线程。
  async function threadHead(owner, thread, signal) {
    const also_owners = aliases.predecessors(owner);
    const latestOn = async (id) => (await conductor.list({ owner, also_owners, thread_id: id, limit: 1 }, signal))?.jobs?.[0];
    let job = await latestOn(thread);
    const superseded = [];
    for (let hop = 0; job && hop < 10; hop++) {
      const child = (await conductor.list({ owner, also_owners, parent_job: job.job_id, limit: 1 }, signal))?.jobs?.[0];
      if (!child?.thread_id || child.thread_id === job.thread_id) break;
      superseded.push(job.thread_id);
      job = (await latestOn(child.thread_id)) ?? child;
    }
    return { job, superseded };
  }

  // verify_previous：派这一单的同时核验一个已结束的任务。核验只读、不加锁；新单只读，或写入范围与被核验任务的产物和 scope
  // 互不包含时才允许，否则核验可能读到新单改到一半的文件。路径按 normPath 比较（/mnt 下不分大小写），任一方向包含即算重叠。
  function verificationWriteOverlap(source, args, exec) {
    const cwd = taskCwd(args, sessionCwd(exec), cfg.workspaces) ?? '';
    const mine = [...(args.scope?.length ? args.scope : ['.']), ...(args.writable_roots ?? [])].map((p) => taskScopePath(cwd, p));
    const scoped = source.scope_paths ?? source.scope;
    const theirs = [...(Array.isArray(scoped) && scoped.length ? scoped : ['.']), ...[...source.files_changed ?? [], ...source.write_paths ?? []]
      .map((file) => typeof file === 'string' ? file : file?.path).filter((file) => typeof file === 'string' && file.trim())]
      .map((p) => taskScopePath(source.cwd ?? '', p));
    return mine.filter((a) => theirs.some((b) => under(a, b) || under(b, a)));
  }
  function verificationOverlapRefusal(jobId, overlap, tool, running) {
    return `${tool}: 这一单的写入范围（${overlap.slice(0, 3).join('、')}）与任务 ${jobId} 的产物或 scope 重叠，不能边改边核验，未派出这一单。` +
      (running ? `任务 ${jobId} 的核验还在跑，等它结束、记完 codex_review 再派这一单` +
          (tool === 'codex_continue' ? '。' : '；或把这一单的写入范围改到不重叠的路径。')
        : `请先 codex_verify ${jobId} 并等它结束、记完 codex_review，再派这一单；或去掉 verify_previous。`);
  }
  async function verifyPreviousCheck(jobId, args, exec, tool, running = false) {
    if (jobId === undefined) return null;
    if (typeof jobId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(jobId)) throw new Error(`${tool}: verify_previous 必须是 runner job_id`);
    const source = withReport(await conductor.waitJob(jobId, 0, exec?.signal));
    if (unknownState(source) || !owns(exec?.agent?.id, source.context?.owner)) {
      throw new Error(`${tool}: verify_previous 的任务 ${jobId} 归属未知或不属于当前会话，未派出这一单。`);
    }
    if (source.context.verification_of) throw new Error(`${await verificationOnlyRefusal(tool, source, exec?.signal)}未派出这一单。`);
    const overlap = args.write === true ? verificationWriteOverlap(source, args, exec) : [];
    if (overlap.length) throw new Error(verificationOverlapRefusal(jobId, overlap, tool, running));
    if (!running && cfg.verificationReuse && withoutVerificationProduct(source)) {
      throw new Error(`${tool}: verify_previous 任务 ${jobId} 受阻，没有改动或可核验结果。先处理原阻塞，或去掉 verify_previous。`);
    }
    return { source, overlap };
  }
  async function startVerifyPrevious(jobId, exec) {
    try {
      const value = await verifyTool.execute({ job_id: jobId, wait_seconds: 0 }, exec);
      if (!value.job_id) throw new Error(value.error ?? value.error_kind ?? value.status);
      return { job_id: value.job_id, ...(value.background_job_id ? { background_job_id: value.background_job_id } : {}), status: value.status,
        line: value.existing_verification ? value.next
          : `已同时派出对 ${jobId} 的只读核验（任务 ${value.job_id}），结果由完成通知送达；拿到后按原验收用 codex_review 记录 ${jobId}。` +
            '核验若判 needs_changes，用 codex_continue 返工原任务（续接不受收尾护栏限制）。' };
    } catch (error) {
      return { error: String(error?.message ?? error), line: `对 ${jobId} 的核验没有派出：${error?.message ?? error}。这一单已经派出。` +
        (error?.code === 'VERIFICATION_UNNEEDED' ? '' : `之后再用 codex_verify ${jobId}。`) };
    }
  }

  // codex_run 带 resume：与 codex_continue 同一阈值决定是否开新线程；线程不认识、读不到大小或很小时照旧沿用。
  async function runThread(args, exec) {
    const owner = exec?.agent?.id;
    if (!args.resume || !owner) return null;
    const { job, superseded } = await threadHead(owner, args.resume, exec?.signal);
    if (!job?.job_id) return null;
    const base = { parent_thread_id: job.thread_id ?? args.resume, parent_job_id: job.job_id, ...(superseded.length ? { superseded_threads: superseded } : {}) };
    if (args.fresh === false) return { mode: 'resume', reason: 'requested', ...base };
    if (args.fresh === true) return { mode: 'fresh', reason: 'requested', ...base };
    const limit = cfg.continueFreshAboveTokens ?? 0;
    if (!limit) return { mode: 'resume', reason: 'disabled', ...base };
    let size;
    try { size = (await conductor.threadSize(base.parent_thread_id, exec?.signal))?.last_input_tokens; } catch { exec?.signal?.throwIfAborted(); }
    if (!Number.isSafeInteger(size)) return { mode: 'resume', reason: 'size_unknown', ...base };
    return { mode: size > limit ? 'fresh' : 'resume', reason: 'size', ...base, parent_last_input_tokens: size, threshold: limit };
  }

  async function previousJob(jobId, exec) {
    try {
      const value = withReport(await conductor.waitJob(jobId, 0, exec?.signal));
      if (!unknownState(value) && owns(exec?.agent?.id, value.context?.owner)) return value;
    } catch { exec?.signal?.throwIfAborted(); }
  }

  const taskIdentity = task => createHash('sha256').update(task.trim()).digest('hex');
  const orderedPaths = (cwd, paths) => [...new Set((paths ?? []).map(file => taskScopePath(cwd, file)))].sort();
  function attemptPremises(value) {
    const { context, cwd, sandbox, task_options } = value;
    if (!cwd || !Array.isArray(context?.acceptance) || typeof context.task !== 'string' || typeof context.write !== 'boolean') return;
    return JSON.stringify([context.routing?.convergence_task ?? taskIdentity(context.task),
      context.acceptance.map(text => text.trim()), [...new Set(context.must_verify ?? [])].sort(), normPath(cwd), context.write, sandbox,
      orderedPaths(cwd, value.scope_paths ?? value.scope), orderedPaths(cwd, task_options?.writable_roots),
      orderedPaths(cwd, context.routing?.required_writes), task_options?.use_user_config === true]);
  }

  async function convergenceRounds(owner, task, acceptance, cwd, parent, signal, resumeJobs) {
    const lookup = jobStatusLookup(signal);
    const prior = async job => {
      const id = job.context?.verification_of ?? parentOf(job);
      if (id) {
        const full = await lookup(id);
        return owns(owner, full.context?.owner) && !unknownState(full) ? full : undefined;
      }
      if (!job.thread_id) return;
      const related = [...resumeJobs.values()].filter(entry => entry.thread_id === job.thread_id && !entry.context?.verification_of);
      const rows = related.length ? related : (await conductor.list({
        owner, also_owners: aliases.predecessors(owner), thread_id: job.thread_id, limit: 2,
      }, signal)).jobs;
      if (rows?.[0]?.job_id !== job.job_id) return;
      const earlier = rows[1];
      if (earlier && owns(owner, earlier.context?.owner)) return lookup(earlier.job_id);
    };
    if (parent) {
      if (!owns(owner, parent.context?.owner)) return [];
      const latest = parent.context?.verification_of ? await prior(parent) : parent;
      if (!latest || !repeatedOutcome(latest)) return [latest].filter(Boolean);
      const earlier = await prior(latest);
      return [latest, earlier].filter(job => job && owns(owner, job.context?.owner) && !job.context.verification_of);
    }
    const filters = { owner, also_owners: aliases.predecessors(owner), cwd, task_key: taskIdentity(task), limit: 100 };
    const page = await conductor.list(filters, signal);
    const title = task.trim().split('\n')[0].slice(0, 160);
    const matches = [];
    for (const job of page.jobs ?? []) {
      if (!owns(owner, job.context?.owner) || job.context.verification_of || job.context.task !== title) continue;
      const full = await lookup(job.job_id);
      if (!owns(owner, full.context?.owner) || full.context.task?.trim() !== task.trim() ||
          JSON.stringify(full.context.acceptance) !== JSON.stringify(acceptance)) continue;
      matches.push(full);
      if (matches.length === 2) break;
    }
    return matches;
  }

  function convergenceDecision(tool, rounds, candidate, note, answers = []) {
    const [latest, earlier] = rounds;
    if (!latest) return {};
    const premises = attemptPremises(latest);
    if (!premises || premises !== attemptPremises(candidate)) return {};
    if ((latest.execution_status ?? latest.status) === 'running' && latest.context.routing?.convergence_override) {
      return { refusal: `${tool}: 交付链的变化重试 ${latest.job_id} 尚在运行。用 codex_status 查询该真实 job_id。` };
    }
    if (!earlier) return {};
    const outcome = repeatedOutcome(latest);
    if (!outcome || premises !== attemptPremises(earlier) ||
        JSON.stringify(outcome) !== JSON.stringify(repeatedOutcome(earlier))) return {};
    // 这次续接对卡住的问题给了与上一轮不同的答复，是新输入，不算原样重派；同一答复再提交一次仍按重复处理。
    const previous = latest.context.continuation?.answers ?? [];
    if (blockingState(latest).questions.some(({ id }) => answers.some(answer => answer.id === id &&
        !previous.some(old => old.id === id && old.answer.trim() === answer.answer.trim())))) return {};
    const exhausted = latest.context.routing?.convergence_override === true;
    if (!exhausted && note && note !== latest.context.routing?.change_fingerprint) return { override: true };
    const items = [...outcome.criteria.map(([index, status]) => `验收 ${index}=${status}`), ...outcome.blockers];
    const refusal = `${tool}: 交付链 ${latest.thread_id ? `thread_id=${latest.thread_id}，` : ''}job_id=${latest.job_id} ` +
      `连续两轮 ${earlier.job_id} → ${latest.job_id} 卡在 ${items.join('、')}，派单前提未变，未启动 Codex。` +
      (exhausted ? '上一轮仅凭变化说明放行后，结果依旧相同，已用完一次机会。'
        : '若环境或做法确有变化但无法在派单参数中体现，可用 rerun_after_change 说明并试一次。') +
      `对最新轮次 ${latest.job_id} 用 codex_review 记录有依据的接受偏差及理由，或上报需用户决定的事项。`;
    return { refusal };
  }

  function carryHistoricalCriteria(args, source, routing) {
    const closed = new Set(historicalCriteria(source));
    const indexes = args.acceptance.map((text, position) => ({ text, index: position + 1 }))
      .filter(({ text, index }) => !closed.has(text) || args.must_verify?.includes(index) ||
        args.acceptance.indexOf(text) !== args.acceptance.lastIndexOf(text));
    if (indexes.length === args.acceptance.length) return { args, routing: closed.size ? { ...routing, historical_criteria: [...closed] } : routing };
    const mapping = new Map(indexes.map(({ index }, position) => [index, position + 1]));
    const remap = values => values?.filter(index => mapping.has(index)).map(index => mapping.get(index));
    return { args: { ...args, acceptance: indexes.map(({ text }) => text), must_verify: remap(args.must_verify),
      expect_blocked: remap(args.expect_blocked), acceptance_needs: args.acceptance_needs
        ?.filter(({ index }) => mapping.has(index)).map(entry => ({ ...entry, index: mapping.get(entry.index) })),
      task: `${args.task}\n\n## 已结案的历史记录\n以下条目已记录为不可补回。即使旧任务正文、报告或线程出现同一条，本单也不采补或验收：${JSON.stringify([...closed])}` },
    routing: { ...routing, historical_criteria: [...closed] } };
  }

  // 本会话（含交接前任）在收尾截止时间之后开始的全部任务；runner 每页最多 100 条，逐页取全。
  async function sessionJobs(owner, signal) {
    const jobs = [];
    const until = Date.now() / 1000 + 86_400;
    for (let offset = 0; offset !== null;) {
      const page = await conductor.list({ owner, also_owners: aliases.predecessors(owner), started_between: [closeoutFrom, until], limit: 100, offset }, signal);
      if (!Array.isArray(page.jobs)) throw new Error(page.error ?? page.error_kind ?? '任务列表不可用');
      jobs.push(...page.jobs);
      offset = page.next_offset ?? null;
    }
    return jobs;
  }

  // plan（只有 codex_run 传）：{ args, exec, guard }。唯一的待验收任务正在核验时放行不重叠的新任务，guard.deferred 记下放行依据。
  async function closeoutCheck(owner, tool, signal, plan, goal) {
    if ((!goal && cfg.closeoutGuard === false) || !owner) return '';
    try {
      if (plan) await scanParkedReviews(owner, signal).catch(parkedWarning);
      const jobs = await sessionJobs(owner, signal);
      if (goal) goal.unreviewedWrites = jobs.filter(job => job?.context?.write === true && !job.context.verification_of &&
        job.execution_status === 'completed' && job.report_status === 'valid' && job.review_status === 'needs_verification' &&
        job.verification_status === 'unreviewed').map(job => job.job_id);
      if (cfg.closeoutGuard === false) return '';
      const pending = pendingCloseout(jobs, closeoutFrom, reworkFrom);
      const deferred = plan && closeoutDeferral(jobs, pending, plan.args.verify_previous);
      if (deferred) {
        // 核验已在跑：与 verify_previous 同一道重叠检查（verify_previous 的重叠在派单前已经查过）。
        if (deferred.via === 'running') {
          try { await verifyPreviousCheck(deferred.job_id, plan.args, plan.exec, tool, true); }
          catch (error) { return String(error?.message ?? error); }
        }
        plan.guard.deferred = deferred;
        plan.guard.parkedReview = parkedFor(owner).some(e => e.job_id === deferred.job_id);
        return '';
      }
      let refusal = closeoutRefusal(tool, pending);
      if (refusal) logRefusal({ session: owner, tool, unreviewed: pending.unreviewed, needs_changes: pending.needsChanges });
      if (refusal && cfg.actionableReceipts) refusal += await pendingReviewReceipts(owner, pending, signal);
      return refusal;
    } catch (error) {
      // 从不抛出：派单可能先于这里的结果结束；中止由调用方在等待后处理。
      if (!signal?.aborted) ctx.logger?.warn?.(`[codex-conductor] 收尾检查失败，已放行：${error?.message ?? error}`);
      return '';
    }
  }

  async function pendingReviewReceipts(owner, pending, signal) {
    const ids = [...new Set([...pending.unreviewed, ...pending.needsChanges])];
    const entries = await Promise.all(ids.map(async id => {
      try {
        const source = await conductor.waitJob(id, 0, signal);
        return !unknownState(source) && source.job_id === id && owns(owner, source.context?.owner)
          ? `\ncodex_review ${JSON.stringify(reviewSkeleton(id, source))}` : '';
      } catch { return ''; }
    }));
    return entries.join('');
  }

  // 收尾护栏拒绝时没有任务记录可写：把被点名的任务号（只有 ID）追加到 closeout-refusals.jsonl，供日后分析。保留最近 500 行。
  const refusalsFile = stateDirectory && path.join(stateDirectory, 'closeout-refusals.jsonl');
  function logRefusal(entry) {
    if (!refusalsFile) return;
    try {
      let lines = [];
      try { lines = readFileSync(refusalsFile, 'utf8').split('\n').filter(Boolean); } catch {}
      lines.push(JSON.stringify({ at: new Date().toISOString(), ...entry }));
      mkdirSync(path.dirname(refusalsFile), { recursive: true });
      writeFileSync(refusalsFile, lines.slice(-500).join('\n') + '\n');
    } catch {}
  }

  // routing：插件怎样派出这一单（续接方式、原线程、被接替的线程、同时核验的任务），写进任务 context 供日后从 runner 记录分析。
  const routingOf = (thread, verifyPrevious) => {
    const routing = {
      ...(thread ? { continuation_mode: thread.mode, continuation_reason: thread.reason, parent_thread_id: thread.parent_thread_id,
        ...(thread.parent_job_id ? { parent_job_id: thread.parent_job_id } : {}),
        ...(Number.isSafeInteger(thread.parent_last_input_tokens) ? { parent_last_input_tokens: thread.parent_last_input_tokens } : {}),
        ...(thread.superseded_threads ? { superseded_threads: thread.superseded_threads } : {}) } : {}),
      ...(verifyPrevious ? { verify_previous: verifyPrevious } : {}),
    };
    return Object.keys(routing).length ? routing : undefined;
  };

  function retainThreadModel(args, source, routing) {
    if (!cfg.modelAB.enabled || !source) return { args, routing };
    const previous = source.context?.routing;
    const model = previous?.thread_model ?? source.task_options?.model ?? '';
    const ab = previous?.thread_model !== undefined ? previous.thread_ab === true : previous?.ab === true;
    if (args.model !== undefined && args.model !== model) {
      // A one-off override does not change the thread's assignment or enter the comparison.
      return { args, routing: { ...routing, thread_model: model, thread_ab: ab } };
    }
    return { args: { ...args, model }, routing: ab ? { ...routing, ab: true, model } : routing };
  }

  async function dispatch(args, exec, continuation, originalTask = args.task, verificationOf, fresh, routing, guard = {}) {
    const reject = message => continuation ? continuationError(message) : new Error(message);
    try { validateRun(verificationOf && args.effort === '' ? { ...args, effort: undefined } : args); }
    catch (error) { throw continuation ? continuationError(error.message) : error; }
    if (args.expect_blocked !== undefined) {
      args = { ...args, expect_blocked: [...new Set(args.expect_blocked)] };
      routing = { ...routing, expect_blocked_count: args.expect_blocked.length };
    }
    let engine = runEngine(args, cfg);
    let quotaLine;
    const lockLine = cfg.lockEngine && args.engine !== undefined && args.engine !== engine
      ? `执行端已锁定为 ${engine === 'gemini' ? 'Gemini' : 'Codex'}，本单没有按 engine=${args.engine} 执行。` : undefined;
    // 额度用完后的 40 分钟里规划端又派了 8 单同样失败的 Codex 任务；恢复时间前不再启动 Codex。
    if (engine === 'codex' && Date.now() < codexQuota) {
      const until = new Date(codexQuota).toLocaleString('zh-CN', { hour12: false });
      // agy 只在主机访问下能写文件和运行命令，任务目录还得在 Windows 盘符下；做不了的不改派，直接说明原因。
      const takeover = cfg.gemini?.command && cfg.geminiFallback !== false && cfg.allowHostAccess === true &&
        (args.host_access ?? cfg.defaultHostAccess) === true &&
        /^(?:[A-Za-z]:[\\/]|\/mnt\/[A-Za-z]\/)/.test(taskCwd(args, sessionCwd(exec), cfg.workspaces) ?? '');
      if (!takeover || args.engine !== undefined || args.resume) {
        throw reject(`${continuation ? 'codex_continue' : 'codex_run'}: Codex 额度已用完，预计 ${until} 恢复，这期间不再派 Codex，未启动任务。` +
          (cfg.gemini?.command ? '改传 engine: "gemini" 交给 Gemini。' : '') + '额度提前恢复时，在“Codex 指挥”面板重新加载插件即可解除。');
      }
      engine = 'gemini';
      args = { ...args, engine, model: undefined, service_tier: undefined, use_user_config: undefined };
      quotaLine = `Codex 额度已用完（预计 ${until} 恢复），本单已改派 Gemini。`;
    }
    let effortLine;
    if (engine === 'gemini' && !continuation && !verificationOf && args.effort !== undefined) {
      effortLine = cfg.gemini?.executionEffort ? `本单 Gemini 使用配置的 effort=${cfg.gemini.executionEffort}。`
        : '本单 Gemini 由 agy 决定推理档位。';
      args = { ...args, effort: undefined };
    }
    if (engine === 'codex' && !continuation && !verificationOf && (args.effort !== undefined || args.effort_reason !== undefined)) {
      const { effort: requested, effort_reason: reason } = args;
      const configured = defaultEffort(cfg, args.write);
      const listed = EFFORT_REASONS.includes(reason);
      if (configured && requested !== undefined && requested !== configured && cfg.effortOverride === 'config') {
        effortLine = `effort=${requested} 未生效：effortOverride=config 下使用配置的推理强度，本单按默认 ${configured}`;
      } else if (configured && !listed && cfg.effortOverride === 'raise-only-listed' &&
          EFFORTS.indexOf(requested) > EFFORTS.indexOf(configured)) {
        effortLine = `effort=${requested} 未生效：effortOverride=raise-only-listed 下提高推理强度要带 effort_reason（${EFFORT_REASONS.join('、')}），本单按默认 ${configured}`;
      }
      const applied = effortLine ? configured : (requested ?? configured) || undefined;
      if (effortLine) args = { ...args, effort: applied };
      routing = { ...routing, ...(requested !== undefined ? { effort_requested: requested } : {}),
        ...(listed ? { effort_reason: reason } : {}), ...(applied !== undefined ? { effort_applied: applied } : {}) };
    }
    if ((args.host_access ?? cfg.defaultHostAccess) === true && cfg.allowHostAccess !== true) {
      throw reject('codex_run: 插件配置没有开启 allowHostAccess，不能传 host_access=true；Codex 只能在沙箱里运行，启动不了 Windows 程序');
    }
    const cwd = taskCwd(args, sessionCwd(exec), cfg.workspaces);
    if (!cwd) throw reject('codex_run: 当前会话没有工作区，请传 cwd');
    const tool = continuation ? 'codex_continue' : 'codex_run';
    if (cfg.dispatchConsistency && !verificationOf) {
      const conflicts = writeContradictions({ ...args, task: originalTask }, cwd, taskScopePath, under);
      if (conflicts.length) throw reject(`${tool}: ${conflicts.join('；')}。修正任务书后再派，未启动 Codex。`);
      if (args.required_writes?.length) routing = { ...routing, required_writes: args.required_writes };
    }
    // 只有 write=true 的任务加目录写锁；主机模式的只读任务不挡同目录的 gemini_write。
    const writer = cfg.gemini && args.write ? { cwd: normPath(cwd) } : null;
    if (writer && geminiWrites.has(writer.cwd)) throw reject('codex_run: 同一任务目录的 gemini_write 尚未结束，请先等它结束');
    const finish = (result) => {
      const outside = result.scope_paths ? result.out_of_scope : outOfScope(result, cwd, args.scope);
      const value = { ...result, acceptance: args.acceptance, ...(outside ? { out_of_scope: outside } : {}) };
      Object.assign(value, reviewState(value));
      value.blocking = blockingState(value);
      if (verificationOf) value.context = { ...value.context, verification_of: verificationOf };
      rememberProducts(value, exec?.agent?.id);
      const reminder = value.status === 'completed' && plannerPrompt(plannerFile)
        ? '\n规划下一次派活前，再对照系统提示词里的「派活给 Codex 前的规划要求」。' : '';
      return withCompletionNotices({ ...value, next: nextStep(value, args.acceptance, Boolean(args.resume),
        { ...cfg, readOnly: args.write !== true }) + reminder }, exec);
    };
    // 取得 job_id 后才响应中止，避免留下已启动却无人管理的 Codex。
    exec?.signal?.throwIfAborted();
    let started;
    let overrideSlot;
    let standingLine;
    let predispatch = [];
    dispatching++;
    dispatchGeneration++;
    if (writer) startingWrites.add(writer);
    try {
      const owner = exec?.agent?.id;
      if (owner) dispatchedSessions.add(owner);
      const log = exec?.agent?.session?.log ?? [];
      const preflightUnavailable = (reason, value) => reject(`${tool}: ${reason}，未启动 Codex。` +
        (value.error_kind === 'bridge_error' ? 'Windows 无法连接 WSL。先恢复 WSL，再核对任务状态；不要重复派活。' : ''));
      // 收尾护栏只拦开新工作的 codex_run。读不到记录或判定出错时放行并记警告。
      // 与其余预检查询并行，启动前再取结果；只多等最慢的一个查询，判定仍以本次派单时的记录为准。
      const closeout = cfg.closeoutGuard !== false && owner && !continuation && !args.resume && !verificationOf
        ? closeoutCheck(owner, tool, exec?.signal, { args, exec, guard }) : null;
      let latestOnThread;
      const resumeThread = args.resume;
      const resumeJobs = new Map();
      if (resumeThread && owner) {
        const plannerDecides = cfg.ownerDecisions === 'planner';
        const also_owners = aliases.predecessors(owner);
        for (let offset = 0; offset !== null;) {
          const history = await conductor.list({ owner, also_owners, thread_id: resumeThread, limit: 100, offset }, exec?.signal);
          exec?.signal?.throwIfAborted();
          if (!Array.isArray(history.jobs)) throw preflightUnavailable('无法核对待续接线程的任务', history);
          if (offset === 0) latestOnThread = history.jobs[0];
          let pending;
          for (const [index, job] of history.jobs.entries()) {
            if (args.write === true && job.job_id) resumeJobs.set(job.job_id, job);
            if (job.blocking?.next_action !== 'ask_user') continue;
            const latestRun = !continuation && offset === 0 && index === 0;
            if (!latestRun) {
              if (canAnswer(log, job, owner)) continue;
              if (plannerDecides && continuation?.parent_job_id === job.job_id) continue;
              const blockers = job.blocking.blockers;
              if (plannerDecides && ownerBlockerIds(blockers).length &&
                  !(await undecidedOwnerBlockers(job, owner, exec?.signal, blockers)).length) continue;
            }
            pending = job;
            break;
          }
          if (pending) throw reject(plannerDecides
            ? `${tool}: 原任务 ${pending.job_id} 有待决定的阻塞，未启动 Codex。按常设授权用 codex_continue 提交 answers 或 resolution。`
            : cfg.plannerAnswers
              ? `${tool}: 原任务 ${pending.job_id} 有待答问题，未启动 Codex。请用 codex_continue 提交 answers。${PLANNER_ANSWERS}`
            : `${tool}: 原任务 ${pending.job_id} 仍需用户回答，未启动 Codex。先向用户确认，再按最新任务状态用 codex_continue 处理。`);
          offset = history.next_offset ?? null;
        }
      }
      // 仓库所有者于 2026-11-10 明确决定：plannerAnswers 开启时不做此检查；要恢复硬拦截请关闭开关，不要在开启时加回。
      if (!cfg.plannerAnswers && !continuation && args.write && owner) {
        for (let offset = 0; offset !== null;) {
          const history = await conductor.list({ owner, scope_conflicts: true, limit: 100, offset }, exec?.signal);
          exec?.signal?.throwIfAborted();
          if (!Array.isArray(history.jobs)) throw preflightUnavailable('无法核对已有写入范围', history);
          for (const job of history.jobs) {
            if (job.blocking?.next_action !== 'ask_user' || !job.blocking.blockers?.some(b => b.kind === 'task_conflict') ||
                canAnswer(log, job, owner)) continue;
            const scope = job.scope_paths ?? job.scope;
            if (unknownState(job) || typeof job.cwd !== 'string' || !job.cwd.trim() ||
                (scope !== null && (!Array.isArray(scope) || scope.some(p => typeof p !== 'string' || !p.trim())))) {
              throw preflightUnavailable(`无法核对原任务 ${job.job_id} 的写入范围`, job);
            }
            if (widensOverlappingScope(job.cwd, scope, cwd, args.scope)) {
              throw new Error(`codex_run: 原任务 ${job.job_id} 的范围冲突仍需用户回答，未启动 Codex。请先向用户确认新增写入路径。`);
            }
          }
          offset = history.next_offset ?? null;
        }
      }
      if (cfg.maxSessionJobs != null && owner) {
        const mine = await conductor.list({ owner, limit: 1 }, exec?.signal);
        exec?.signal?.throwIfAborted();
        if (!Number.isSafeInteger(mine.total)) throw preflightUnavailable('无法核对本会话已派的任务数', mine);
        if (mine.total >= cfg.maxSessionJobs) {
          throw reject(`${tool}: 本会话已派 ${mine.total} 单，达到 maxSessionJobs=${cfg.maxSessionJobs} 的上限，未启动 Codex。` +
            '先向用户说明进度和还差什么，由用户决定是否调高上限；不要改为自己动手。');
        }
      }
      if (cfg.maxSessionTokens != null && owner) {
        const spent = await conductor.summary({ owner, limit: 1 }, exec?.signal);
        exec?.signal?.throwIfAborted();
        if (!Array.isArray(spent.groups)) throw preflightUnavailable('无法核对本会话已用的用量', spent);
        // 用量口径取 runner 汇总的 total_tokens，没有时用输入加输出；用量未知的任务不计入。
        const usage = spent.usage_total ?? {};
        const used = Number.isFinite(usage.total_tokens) ? usage.total_tokens : (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
        if (used >= cfg.maxSessionTokens) {
          throw reject(`${tool}: 本会话的 Codex 用量约 ${used} token，达到 maxSessionTokens=${cfg.maxSessionTokens} 的上限，未启动 Codex。` +
            '先向用户说明进度和还差什么，由用户决定是否调高上限；不要改为自己动手。');
        }
      }
      let runningTotal;
      if (cfg.maxRunningJobs != null) {
        const running = await conductor.list({ status: 'running', limit: 1 }, exec?.signal);
        runningTotal = running.total;
        exec?.signal?.throwIfAborted();
        if (!Number.isSafeInteger(running.total)) throw preflightUnavailable('无法核对正在运行的任务数', running);
        // 本进程里其他尚未拿到 job_id 的派单也计入。
        if (running.total + dispatching - 1 >= cfg.maxRunningJobs) {
          throw reject(`${tool}: 已有 ${running.total} 个 Codex 任务在运行或排队，达到 maxRunningJobs=${cfg.maxRunningJobs} 的上限，未启动 Codex。` +
            '用 codex_jobs（status="running"）查看，等其中一个结束后再派同一单，不要改为自己动手。');
        }
      }
      if (closeout) {
        const refusal = await closeout;
        exec?.signal?.throwIfAborted();
        if (refusal) throw new Error(refusal);
        // 靠本次 verify_previous 的核验放行时，新单和核验都要启动；运行数只够一单时不派，免得待验收任务没人核验。
        if (guard.deferred?.via === 'verify_previous' && runningTotal !== undefined && runningTotal + dispatching >= cfg.maxRunningJobs) {
          throw reject(`${tool}: 任务 ${guard.deferred.job_id} 还没有验收，靠本次 verify_previous 的核验放行新任务，但已有 ${runningTotal} 个任务在运行，` +
            `达到 maxRunningJobs=${cfg.maxRunningJobs}，新单和核验放不下两单，未启动 Codex。先 codex_verify ${guard.deferred.job_id}，或等运行中的任务结束。`);
        }
      }
      // 预检（待答问题、收尾护栏）按原线程做完后才换成新线程：规划端任务原文完整保留，前面附上一轮交接内容。
      if (fresh) {
        const { resume: _resumed, ...rest } = args;
        args = { ...rest, task: `${fresh.brief}\n\n## 本轮任务（规划端原文）\n${args.task}` };
      }
      const repeat = await conductor.repeatGuard(cwd, exec?.signal);
      exec?.signal?.throwIfAborted();
      if (cfg.repeatFailureGuard.enabled && repeat?.status === 'completed') standingLine = repeatStandingLine(repeat.standing);
      predispatch = predispatchWarnings(args, cwd, guard.parent ?? latestOnThread, repeat);
      if (args.rerun_after_change) routing = { ...routing, rerun_after_change: true };
      if (owner && args.write === true && (resumeJobs.size || guard.parent)) {
        if (guard.parent) resumeJobs.set(guard.parent.job_id, guard.parent);
        const refusal = await runningVerificationRefusal(args, exec, tool, resumeJobs, resumeThread);
        exec?.signal?.throwIfAborted();
        if (refusal) throw reject(refusal);
      }
      if (owner && !verificationOf && (cfg.convergenceGuard || cfg.historicalGapReview)) {
        const linked = guard.parent ?? ((latestOnThread?.review_status === 'needs_attention' ||
          ['needs_changes', 'accepted_deviations'].includes(latestOnThread?.verification_status))
          ? await previousJob(latestOnThread.job_id, exec) : undefined);
        let rounds = [];
        if (cfg.convergenceGuard) {
          if (linked || !resumeThread) {
            try { rounds = await convergenceRounds(owner, originalTask, args.acceptance, cwd, linked, exec?.signal, resumeJobs); }
            catch { exec?.signal?.throwIfAborted(); }
          }
          const previous = linked ?? rounds[0];
          const convergenceTask = continuation && linked
            ? linked.context.routing?.convergence_task ?? taskIdentity(linked.context.task) : taskIdentity(originalTask);
          const note = args.rerun_after_change && taskIdentity(args.rerun_after_change);
          const { refusal, override } = convergenceDecision(tool, rounds, { cwd, scope: args.scope,
            sandbox: (args.host_access ?? cfg.defaultHostAccess) === true ? 'danger-full-access' : args.write ? 'workspace-write' : 'read-only',
            task_options: { writable_roots: args.writable_roots, use_user_config: args.use_user_config },
            context: { task: originalTask, acceptance: args.acceptance, write: args.write, must_verify: args.must_verify,
              routing: { convergence_task: convergenceTask, required_writes: args.required_writes } } }, note, continuation?.answers);
          if (refusal) throw reject(refusal);
          if (!continuation && previous?.job_id && (linked || repeatedOutcome(previous))) {
            routing = { ...routing, parent_job_id: previous.job_id };
          }
          if (convergenceTask !== taskIdentity(originalTask)) routing = { ...routing, convergence_task: convergenceTask };
          if (note) routing = { ...routing, change_fingerprint: note };
          if (override) {
            const slot = JSON.stringify([cfg.runnerHome, rounds[0].job_id]);
            if (hostConvergenceStarts.has(slot)) throw reject(`${tool}: 交付链 ${rounds[0].job_id} 已在提交一次变化重试。`);
            hostConvergenceStarts.add(slot);
            overrideSlot = slot;
            routing = { ...routing, convergence_override: true };
          }
        }
        const previous = linked ?? rounds[0];
        if (cfg.historicalGapReview && previous) {
          ({ args, routing } = carryHistoricalCriteria(args, previous, routing));
          if (!args.acceptance.length) throw reject(`${tool}: ${previous.job_id} 的验收项已全部作为不可补回的历史记录结案，无需派单。`);
        }
      }
      started = await conductor.start(args, cwd, undefined, {
        owner: owner ?? null, task: originalTask, acceptance: args.acceptance, write: args.write,
        ...(args.must_verify?.length ? { must_verify: [...new Set(args.must_verify)] } : {}),
        dispatcher: { version: loadedIdentity.version, revision: loadedIdentity.revision, pid: process.pid },
        ...(continuation ?? fresh?.continuation ? { continuation: continuation ?? fresh.continuation } : {}),
        ...(verificationOf ? { verification_of: verificationOf } : {}),
        ...(guard.fallbackOf ? { fallback_of: guard.fallbackOf } : {}),
        ...(routing ? { routing } : {}),
      });
      if (owner && started.job_id && !unknownState(started) && continuation?.decided_by === 'planner') {
        recordOwnerDecision(owner, started.job_id, continuation);
      }
      if (owner && started.job_id && !unknownState(started)) {
        if (predispatch.length) countCloseout(owner, 'predispatch_warnings', predispatch.length);
        if (args.expect_blocked?.length) countCloseout(owner, 'expect_blocked_items', args.expect_blocked.length);
      }
      guard.onStarted?.(started);
      if (cfg.plannerReads === 'products') rememberJob(started, owner);
    } finally {
      dispatching--;
      if (writer) startingWrites.delete(writer);
      if (overrideSlot) hostConvergenceStarts.delete(overrideSlot);
    }
    if (exec?.signal?.aborted) {
      if (started.job_id) await conductor.cancel(started.job_id, exec.signal);
      exec.signal.throwIfAborted();
    }
    const label = `Codex ${started.job_id} · ${taskLine(args, 40)}`;
    let value;
    if (started.status === 'running' && started.job_id) {
      const bg = background(started.job_id, exec, finish, label);
      try {
        value = await collect(started.job_id, bg, bg ? 0 : (args.wait_seconds ?? cfg.waitSeconds), exec?.signal);
      } catch (error) {
        if (!bg && exec?.signal?.aborted) await conductor.cancel(started.job_id, exec.signal);
        throw error;
      }
    } else {
      value = withReport(started);
    }
    const shown = value.rendered ? await verifyRendered(value, exec) : notifyOnDone(await finish(value), exec, finish);
    const key = shown.rendered ? 'rendered' : 'next';
    const lines = [standingLine, lockLine, effortLine, quotaLine, ...predispatch].filter(line => line && !shown[key]?.includes(line));
    const renderedNext = [standingLine, ...predispatch].filter(Boolean).join('\n');
    return { ...shown, ...(shown.rendered && renderedNext ? { next: [shown.next, renderedNext].filter(Boolean).join('\n') } : {}),
      ...(lines.length ? { [key]: [shown[key], ...lines].filter(Boolean).join('\n') } : {}) };
  }

  const waitSecondsDescription = `未登记 Harness 后台任务时最多等待的秒数，默认 ${cfg.waitSeconds}。` +
    '登记成功时直接返回任务号；' + WAIT_GUIDANCE + '未登记后台时中止派单的同步等待仍会取消该 Codex 任务。';
  const engineParameter = cfg.lockEngine ? { ...ENGINE_PARAMETER, description: engineGuidance(cfg) } : ENGINE_PARAMETER;
  const runTool = {
    ...PRESENT.codex_run,
    presentCall: (args) => PRESENT.codex_run.presentCall({ host_access: cfg.defaultHostAccess === true, ...args }),
    name: 'codex_run',
    description: '把任务交给 Codex 或 Gemini。' + (cfg.lockEngine ? engineGuidance(cfg) : ENGINE_GUIDANCE + ` 新任务省略 engine 时用默认 ${cfg.defaultEngine}。`) + WAIT_GUIDANCE +
      '同一任务书连续失败时不要原样重派，先读失败回执，按失败类别处理。' +
      (cfg.convergenceGuard ? '同一交付链连续两轮卡在相同条目且参数未变时，仅凭 rerun_after_change 最多再试一次。' : '') +
      '一单一个可独立验收的结果，超过 8 条按共同前置拆单，勿为并行多拆单。路径、平台和参数适配在原授权内处理。' +
      '一单最关键、必须实测的 1–3 条写进 must_verify。' +
      '派单前核对授权。要交文件或启动会落盘的程序就用 write=true。scope 列全写入路径，沙箱模式下把 cwd 外的可写目录列入 writable_roots。' +
      '真机、网络和宿主能力列入前置条件，需主机访问时按配置和授权设置 host_access。' +
      '教程终检与补目录导航同单，write=true，scope 只含目录页，正文与素材只读。Codex 逐条回报验收，列出偏差和范围外改动。' +
      (cfg.plannerReads === 'products' ? 'completed 后先机械核对产物、出处和数字，内容是否属实用 codex_verify，' : 'completed 后你要逐条只读核验，') +
      (cfg.ownerDecisions === 'planner' ? '原任务有待决定阻塞时按常设授权用 codex_continue 提交 answers 或 resolution；'
        : cfg.plannerAnswers ? PLANNER_ANSWERS + '原任务有阻塞问题时用 codex_continue 提交 answers；' : '原任务需要用户回答时先询问，再用 codex_continue；') +
      (cfg.lockEngine && cfg.defaultEngine === 'gemini' ? '返工用 codex_continue(job_id)，不要传 resume。' : '其他返工可带 resume=工具真实返回的 thread_id；新任务省略 resume。') +
      (cfg.closeoutGuard !== false ? '待收尾事项会挡住新开 codex_run，含只读单；可核验或续接。仅一单待验收、无其他返工欠账且首次核验在跑或由本单 verify_previous 发起时，容量足够且写入不重叠才放行。' : '') + '同目录写锁被占用时会自动排队，用原 job_id 等待；codex_cancel 可取消排队，不要重复派活。' +
      '汇报格式由插件固定为 JSON，task/acceptance 里不要规定末行结论行之类的版式。' +
      'verify_previous 可在派这一单的同时只读核验上一单（写入范围重叠时拒绝）。' +
      (cfg.gemini ? '源码改动和素材笔记用 codex_run；教程、文档正文用 gemini_write，一章一章做。' : '') +
      (cfg.allowHostAccess === true
        ? (cfg.defaultHostAccess === true
          ? '当前默认以 danger-full-access 运行：省略 host_access 也没有沙箱，可以启动 Windows 程序及访问主机网络；resume 同样生效。host_access=false 可为单次任务恢复沙箱。'
          : '任务需要启动 Windows 程序（pwsh.exe、ssh.exe、Hyper-V 命令等）或连接 Hyper-V 虚拟机时传 host_access=true；不传时 WSL 里的 Codex 启动不了 Windows 程序。')
        : cfg.runnerMode === 'native' ? '当前使用 Windows 原生 Codex，命令仍受任务沙箱限制。'
        : 'WSL 里的 Codex 启动不了 Windows 程序（pwsh.exe、Hyper-V 命令等），不要把需要 Windows 运行时的检查写进 task/acceptance，这类检查你自己跑。'),
    parameters: {
      type: 'object',
      properties: {
        engine: engineParameter,
        task: { type: 'string', description: '完整任务：目标、相关文件路径、约束和背景。Codex 看不到本对话，必须写全。' },
        acceptance: { type: 'array', minItems: 1, items: { type: 'string' }, description: '至少 1 条，每条去除首尾空白后至少 4 个字符。只写结果、正常观测入口和预期值，只要求本轮可取得的证据。' +
          '哈希、校验和、逐文件枚举、纳秒时间戳、过程进度文件及全程零写入或零外发的证明，仅在涉及数据完整性、身份真实性、备份恢复或安全边界时要求，并写明用途。' },
        must_verify: { type: 'array', items: { type: 'integer', minimum: 1 }, description: '必须实测的验收条目编号（从 1 起）；记 met 前用 codex_verify 独立核验。' },
        acceptance_needs: ACCEPTANCE_NEEDS,
        expect_blocked: EXPECT_BLOCKED,
        ...(cfg.dispatchConsistency ? { required_writes: { type: 'array', items: { type: 'string' },
          description: '执行必须写入的文件或目录。插件对照 write、明确的只读约束和 scope；本字段不增加授权。' } } : {}),
        write: { type: 'boolean', description: '必填。true 允许 Codex 修改任务目录及 writable_roots 指定目录里的文件（使用沙箱时为 workspace-write）；' +
          'false 只读调查：新开的只读任务不留会话，事后不能 resume；带 resume 追问写任务线程时仍可续跑' +
          `${cfg.allowHostAccess === true ? '，带 host_access=true 时也会保留会话' : ''}。生成或删除文件、改变远端状态也需 true，按授权在 scope/task 写明目标。不得同时要求写入和禁止写入。` },
        ...(cfg.allowHostAccess === true ? { host_access: { type: 'boolean', default: cfg.defaultHostAccess === true,
          description: 'true 时 Codex 在沙箱外运行（danger-full-access），' +
          '可以通过 WSL interop 启动 Windows 程序（pwsh.exe、ssh.exe、Hyper-V 命令）、连接 Hyper-V 虚拟机；write 仍决定能否改动（文件、虚拟机、网络和系统状态）：' +
          '要启动/停止/新建虚拟机，或运行会建、改虚拟机的脚本，也要传 write=true，否则 Codex 只做只读调查。不再有沙箱，只靠提示约束。' +
          (cfg.defaultHostAccess === true ? '当前默认 true，新任务和 resume 都可省略；false 为本次任务恢复沙箱。' : '只在任务需要时传。') } } : {}),
        scope: { type: 'array', items: { type: 'string' }, description: '允许改动的文件或目录（相对任务目录或绝对路径）。覆盖获准的启动必写路径、临时脚本、备份和复制目的地等全部写入目标。必需写入超出授权时，先澄清再派单。' +
          '不展开通配符；动态命名的备份须在派活前确定具体文件名并列入 scope。' +
          '它不增加沙箱写权限；给了就写进约束，完成后在 out_of_scope 里列出范围外的改动。' },
        writable_roots: { type: 'array', items: { type: 'string' }, description: '本次任务在 cwd 以外需要写入的已有目录（Windows 路径或 /mnt/...）；需要 write=true。' +
          'workspace-write 沙箱会额外允许写入这些目录，scope 仍须列出所有允许修改的目标。仅对本次调用生效；host_access=true 时已无沙箱，不需要此参数。' },
        cwd: { type: 'string', description: '任务目录（Codex 在这里运行，write=true 时可写；沙箱内的额外可写目录用 writable_roots 指定），Windows 路径或 /mnt/... 都可以。' +
          '不传时：会话工作区属于配置里带 cwd 的 workspaces 条目，就用那个 cwd，否则用当前会话工作区。' +
          '只在 task 里写目标目录不会切换任务目录，要处理哪个目录就传哪个 cwd。' },
        resume: { type: 'string', description: '仅在继续已有 Codex 会话时填写工具真实返回的 thread_id；新任务省略，不要生成编号或填写 DSH 会话号、job_id。原任务补答阻塞问题时用 codex_continue(job_id)。' },
        rerun_after_change: RERUN_AFTER_CHANGE,
        fresh: { type: 'boolean', description: '只配合 resume：不传时原线程很大就开新线程（你的任务原文前附上一轮交接内容），否则沿用原线程；true 强制开新线程，false 强制沿用。' },
        verify_previous: { type: 'string', description: '可选：一个已结束任务的 job_id，派这一单的同时只读核验它；这一单可写且写入范围与它的产物或 scope 重叠时拒绝。' },
        use_user_config: { type: 'boolean', description: '加载 WSL Codex 自己配置的 MCP 和 hooks（任务要用到这些工具时），启动更慢。' },
        model: { type: 'string', description: '可选，显式指定本次任务的模型。' },
        effort: { type: 'string', enum: EFFORTS, description: `推理强度。默认：write=true 时 ${cfg.effort || 'Codex 配置里的值'}，只读时 ` +
          `${cfg.readOnlyEffort || cfg.effort || 'Codex 配置里的值'}${cfg.model ? `（模型 ${cfg.model}）` : ''}。简单任务可调低以加快速度。` },
        effort_reason: { type: 'string', enum: EFFORT_REASONS, description: '提高推理强度的原因：并发或锁、跨会话状态、安全边界、数据迁移、上一轮实现需返工。effortOverride=raise-only-listed 时提高强度必填。' },
        wait_seconds: { type: 'integer', description: waitSecondsDescription },
      },
      required: ['task', 'acceptance', 'write'],
    },
    output: OUTPUT,
    async execute(args, exec) {
      checkEngine(args?.engine);
      if (args?.resume && runEngine(args, cfg) === 'gemini') {
        throw new Error(cfg.lockEngine ? 'codex_run: 执行端已锁定为 Gemini，不能 resume Codex 线程。返工用 codex_continue(job_id)，插件会把上轮交接带给 Gemini。'
          : 'Gemini 续接请用 codex_continue(job_id)，由 runner 取得准确的 conversation_id');
      }
      if (Object.hasOwn(args ?? {}, 'host_access') && cfg.allowHostAccess !== true) {
        throw new Error('codex_run: 插件配置没有开启 allowHostAccess，不能传 host_access');
      }
      const unknown = Object.keys(args ?? {}).filter(key => !Object.hasOwn(runTool.parameters.properties, key));
      if (unknown.length) throw new Error(`codex_run: 未知参数 ${unknown.join(', ')}；codex_run 的任务正文写在 task，不是 prompt/message/content`);
      if (args.fresh !== undefined && typeof args.fresh !== 'boolean') throw new Error('codex_run: fresh 必须是布尔值');
      if (args.model !== undefined && (typeof args.model !== 'string' || !args.model.trim())) throw new Error('codex_run: model 必须是非空字符串');
      // 配置的模型带提供方前缀时，网关按前缀选通道；3 单裸名 gpt-6.2 被转到未登录的通道，各自重试了 10 分钟。
      if (args.model && runEngine(args, cfg) === 'codex' && cfg.model?.includes('/') && !args.model.includes('/')) {
        throw new Error(`codex_run: model 要带提供方前缀，例如 ${cfg.model.split('/')[0]}/${args.model}；裸模型名会被网关转到其他通道。省略 model 则用配置的 ${cfg.model}。`);
      }
      const verifyPrevious = args.verify_previous === undefined ? null : await verifyPreviousCheck(args.verify_previous, args, exec, 'codex_run');
      // resume 的线程若已被开新线程的续接接替，改接最新的线程；再按大小决定是否开新线程。查询失败时照旧沿用原线程。
      let thread = null;
      const threadLookedUp = args.resume && (cfg.modelAB.enabled || args.fresh !== undefined || (cfg.continueFreshAboveTokens ?? 0) > 0);
      if (threadLookedUp) {
        try { thread = await runThread(args, exec); } catch { exec?.signal?.throwIfAborted(); }
      }
      if (thread && thread.parent_thread_id !== args.resume) args = { ...args, resume: thread.parent_thread_id };
      const parent = thread?.parent_job_id && (thread.mode === 'fresh' || cfg.modelAB.enabled)
        ? await previousJob(thread.parent_job_id, exec) : undefined;
      let fresh;
      if (thread?.mode === 'fresh') {
        if (!parent) Object.assign(thread, { mode: 'resume', reason: 'parent_unreadable' });
        else fresh = { brief: previousRoundBrief(parent),
          continuation: { parent_job_id: thread.parent_job_id, answers: [], resolution: '' } };
      }
      const guard = { parent };
      const route = retainThreadModel(args, parent, routingOf(thread, verifyPrevious ? args.verify_previous : undefined));
      const value = await dispatch(route.args, exec, undefined, args.task, undefined, fresh, route.routing, guard);
      const deferred = guard.deferred && value.job_id ? guard.deferred : null;
      if (deferred) countCloseout(exec?.agent?.id, 'deferred_dispatch');
      const threadLine = !thread ? '' : thread.mode === 'fresh'
        ? `已开新线程（原线程 ${thread.parent_thread_id}，上一轮任务 ${thread.parent_job_id}${thread.parent_last_input_tokens ? `，原线程上次请求约 ${thread.parent_last_input_tokens} 输入 token` : ''}），` +
          `新任务 ${value.job_id ?? '（见上）'}；任务里附了上一轮交接内容。之后的返工请对新任务 ${value.job_id ?? ''} 调 codex_continue，不要再 resume 原线程。`
        : thread.superseded_threads ? `线程 ${thread.superseded_threads[0]} 已由新线程接续，本次改为接续线程 ${thread.parent_thread_id}（任务 ${thread.parent_job_id}）。` : '';
      const verify = verifyPrevious && value.job_id ? await startVerifyPrevious(args.verify_previous, exec) : null;
      const deferLine = !deferred ? '' : deferred.via === 'verify_previous' && verify?.error
        ? `任务 ${deferred.job_id} 还没有验收，本该由随本单派出的核验处理，但核验没有派出；再派新任务会被拒，先 codex_verify ${deferred.job_id}。`
        : guard.parkedReview ? `任务 ${deferred.job_id} 的挂起复核会在核验结束后判定，这一单先放行。`
        : `任务 ${deferred.job_id} 还没有验收，因为它的核验${deferred.via === 'running' ? '正在跑' : '随本单派出'}，这一单先放行；` +
          `核验结束后要先对 ${deferred.job_id} 记 codex_review（或记 needs_changes 并返工），才能再派新任务。`;
      const hints = [threadLine, verify?.line, deferLine, acceptanceHint(args), handoverHint(exec?.agent)].filter(Boolean).join('\n');
      const { line: _verifyLine, ...verifyResult } = verify ?? {};
      const shown = { ...value, ...(thread ? { continuation_thread: thread } : {}), ...(verify ? { verify_previous: verifyResult } : {}),
        ...(deferred ? { closeout_deferred: deferred } : {}) };
      return hints ? { ...shown, next: shown.next ? `${shown.next}\n${hints}` : hints } : shown;
    },
  };
  ctx.tools.register(runTool);

  async function* verificationJobs(owner, automatic, signal, target) {
    const filters = target && cfg.verificationReuse
      ? { owner, also_owners: aliases.predecessors(owner), verification_of: target }
      : automatic ? {} : { owner, also_owners: aliases.predecessors(owner), status: 'running' };
    for (let offset = 0; offset !== null;) {
      const page = await conductor.list({ ...filters, limit: 100, offset }, signal);
      if (page.error_kind || !Array.isArray(page.jobs)) {
        throw new Error(`codex_verify: 无法核对已有核验：${page.error ?? page.error_kind ?? '任务列表不可用'}`);
      }
      for (const job of page.jobs) {
        if (job.context?.verification_of && (target && cfg.verificationReuse
          ? owns(owner, job.context.owner) && job.context.verification_of === target
          : automatic || (job.execution_status ?? job.status) === 'running')) yield job;
      }
      offset = page.next_offset ?? null;
    }
  }
  async function findVerification(jobId, owner, automatic, signal) {
    for await (const job of verificationJobs(owner, automatic, signal)) {
      if (job.context.verification_of === jobId) return { job_id: job.job_id, status: job.execution_status ?? job.status };
    }
  }
  const verificationScope = (source, args, excluded) => JSON.stringify([args.focus?.trim() ?? '', args.samples ?? 8, excluded,
    cfg.historicalGapReview ? (source.verification?.report_rows ?? []).filter(item => item.historical_gap).map(item => item.row) : []]);
  const historicalIndexes = (source) => {
    if (!cfg.historicalGapReview) return [];
    const closed = new Set(historicalCriteria(source));
    return source.context.acceptance.flatMap((text, index) =>
      closed.has(text) && !source.context.must_verify?.includes(index + 1) ? [index + 1] : []);
  };
  async function verificationReuseCheck(source, args, owner, automatic, signal) {
    const scope = verificationScope(source, args, historicalIndexes(source));
    let completed;
    for await (const job of verificationJobs(owner, automatic, signal, source.job_id)) {
      const status = job.execution_status ?? job.status;
      if (automatic || status === 'running') return { job_id: job.job_id, status };
      if (!completed && status === 'completed' && job.report_status === 'valid' && job.verification_version && job.verification_scope === scope) completed = job;
    }
    if (completed) {
      const { verification_version } = await conductor.verificationVersion(source.job_id, signal).catch(() => ({}));
      signal?.throwIfAborted();
      if (verification_version === completed.verification_version) {
        throw Object.assign(new Error(`codex_verify: ${source.job_id} 的文件及核验范围未变，复用核验 ${completed.job_id}。` +
          `用 codex_status ${JSON.stringify({ job_id: completed.job_id })} 取回核验报告，再对 ${source.job_id} 提交 codex_review。`),
        { code: 'VERIFICATION_UNNEEDED' });
      }
    }
  }
  async function runningVerificationRefusal(args, exec, tool, chain, resumeThread) {
    const { signal, agent: { id: owner } } = exec;
    const warn = (error) => {
      signal?.throwIfAborted();
      ctx.logger?.warn?.(`[codex-conductor] ${tool} 核验查询失败，已放行：${error?.message ?? error}`);
    };
    const readStatus = async (id) => {
      try {
        const value = await conductor.waitJob(id, 0, signal);
        if (unknownState(value) || !['running', 'completed', 'failed', 'cancelled'].includes(value.execution_status ?? value.status)) {
          throw new Error(value.error ?? value.error_kind ?? `任务 ${id} 状态不可用`);
        }
        return value;
      } catch (error) { warn(error); }
    };
    const checks = new Map();
    try {
      for await (const job of verificationJobs(owner, false, signal)) {
        const id = job.context.verification_of;
        if (!checks.has(id)) checks.set(id, []);
        checks.get(id).push(job.job_id);
      }
    } catch (error) { warn(error); }
    const unmatched = new Set([...checks.keys()].filter(id => !chain.has(id)));
    const threads = new Set(resumeThread ? [resumeThread] : []);
    const ancestors = new Map();
    const also_owners = aliases.predecessors(owner);
    for (const [id, known] of chain) {
      if (!unmatched.size) break;
      const job = known ?? await readStatus(id);
      if (!known) ancestors.set(id, job);
      if (!job || (!known && !owns(owner, job.context?.owner))) continue;
      const parentId = parentOf(job);
      if (parentId && !chain.has(parentId)) {
        chain.set(parentId, null);
        unmatched.delete(parentId);
      }
      const thread = job.thread_id;
      if (!thread || threads.has(thread) || !unmatched.size) continue;
      threads.add(thread);
      try {
        for (let offset = 0; offset !== null && unmatched.size;) {
          const page = await conductor.list({ owner, also_owners, thread_id: thread, limit: 100, offset }, signal);
          signal?.throwIfAborted();
          if (page.error_kind || !Array.isArray(page.jobs)) throw new Error(page.error ?? page.error_kind ?? '任务列表不可用');
          for (const related of page.jobs) {
            if (related.job_id && !chain.get(related.job_id)) chain.set(related.job_id, related);
            unmatched.delete(related.job_id);
          }
          offset = page.next_offset ?? null;
        }
      } catch (error) { warn(error); }
    }
    for (const [id, verificationIds] of checks) {
      if (!chain.has(id)) continue;
      const source = ancestors.has(id) ? ancestors.get(id) : await readStatus(id);
      if (!source) continue;
      if (!owns(owner, source.context?.owner)) return `${tool}: 被核验任务 ${id} 归属未知或不属于当前会话，未派出这一单。`;
      const overlap = verificationWriteOverlap(source, args, exec);
      if (!overlap.length) continue;
      for (const verificationId of verificationIds) {
        const value = await readStatus(verificationId);
        if ((value?.execution_status ?? value?.status) === 'running') return verificationOverlapRefusal(id, overlap, tool, true);
      }
    }
  }
  const reuseVerification = (id, value) => {
    if (!value.job_id) return value;
    const next = value.status === 'running' ? `对 ${id} 的核验已在跑（任务 ${value.job_id}），不重复派` : undefined;
    return { ...value, existing_verification: true, ...(next ? { next } : {}) };
  };

  const verifyTool = {
    name: 'codex_verify',
    description: '独立核验本会话一个已结束的任务：新会话、只读，沿用原目录和主机访问。配置了 Gemini 时默认换另一引擎。核验只做一层，核验任务本身不能再核验。' +
      engineGuidance(cfg) +
      (cfg.verificationReuse ? '没有可核验产出的受阻任务不派核验。文件和核验范围都未变时复用上一份核验。' : '') +
      '回到出处抽查产物中的结论；结束后用 codex_review 记录原任务的验收。' + WAIT_GUIDANCE,
    presentCall: (a) => ({ card: 'generic', kind: 'execute', title: `独立核验 Codex ${a?.job_id ?? ''}` }),
    parameters: { type: 'object', properties: {
      job_id: { type: 'string', description: '本会话已结束的 runner job_id。' },
      engine: engineParameter,
      focus: { type: 'string', description: '可选，重点核对什么。' },
      samples: { type: 'integer', minimum: 1, maximum: 30, description: '默认抽查 8 条，最多 30 条。' },
      wait_seconds: { type: 'integer', minimum: 0, description: waitSecondsDescription },
    }, required: ['job_id'] },
    output: OUTPUT,
    async execute(args, exec) {
      checkEngine(args?.engine);
      if (typeof args?.job_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(args.job_id)) throw new Error('codex_verify: job_id 无效；请用 codex_jobs 找回 runner 任务编号');
      if (args.focus !== undefined && typeof args.focus !== 'string') throw new Error('codex_verify: focus 必须是字符串');
      if (args.samples !== undefined && (!Number.isInteger(args.samples) || args.samples < 1 || args.samples > 30)) throw new Error('codex_verify: samples 必须是 1–30 的整数');
      if (args.wait_seconds !== undefined && (!Number.isInteger(args.wait_seconds) || args.wait_seconds < 0)) throw new Error('codex_verify: wait_seconds 必须是非负整数');
      const owner = exec?.agent?.id;
      if (!owner) throw new Error('codex_verify: 当前调用没有会话 ID');
      const automatic = exec[automaticVerification];
      const source = automatic ?? await conductor.waitJob(args.job_id, 0, exec?.signal);
      if (unknownState(source) || !['running', 'completed', 'failed', 'cancelled'].includes(source.status)) throw new Error('codex_verify: 原任务状态未知，请先用 codex_status 确认');
      if (!owns(owner, source.context?.owner)) throw new Error('codex_verify: 原任务归属未知或不属于当前会话');
      if (source.context.verification_of) throw new Error(await verificationOnlyRefusal('codex_verify', source, exec?.signal));
      if (source.status === 'running') throw new Error(`codex_verify: 原任务还在运行。${waitForJob(args.job_id)}等它结束后再核验。`);
      if (cfg.verificationReuse && withoutVerificationProduct(source)) {
        throw new Error(`codex_verify: 原任务 ${source.job_id} 受阻，未记录改动或可核验结果。先处理原阻塞。`);
      }
      if (!source.cwd || !source.log_dir || typeof source.context.task !== 'string' || !Array.isArray(source.context.acceptance) || !source.context.acceptance.length ||
          !['read-only', 'workspace-write', 'danger-full-access'].includes(source.sandbox)) throw new Error('codex_verify: 原任务缺少目录、任务书、验收标准或执行设置，无法独立核验');
      const id = source.job_id;
      const pending = verificationStarts.get(id);
      if (pending) {
        const { value, error, existing } = await pending;
        exec?.signal?.throwIfAborted();
        if (error) throw error;
        if (existing && value.status !== 'running' && !automatic) return verifyTool.execute(args, exec);
        return reuseVerification(id, value);
      }
      const receipt = Promise.withResolvers();
      verificationStarts.set(id, receipt.promise);
      const release = () => { if (verificationStarts.get(id) === receipt.promise) verificationStarts.delete(id); };
      try {
        const existing = cfg.verificationReuse ? await verificationReuseCheck(source, args, owner, automatic, exec?.signal)
          : await findVerification(id, owner, automatic, exec?.signal);
        if (existing) {
          receipt.resolve({ value: existing, existing: true });
          return reuseVerification(id, existing);
        }
        return await dispatchVerification(source, args, exec, started => {
          receipt.resolve({ value: started });
          release();
        });
      } catch (error) {
        receipt.resolve({ error });
        throw error;
      } finally {
        release();
      }
    },
  };
  ctx.tools.register(verifyTool);

  // 核验只做一层：核验任务的报告已自动算作原任务的独立依据（criterionSupport），复核或再核验核验任务只会一层套一层，
  // 更深的核验也不算原任务的依据（2026-11-22 一单被套了 13 层、约 3.5 小时）。
  async function verificationOnlyRefusal(tool, source, signal) {
    let root = source.context.verification_of;
    // 旧版留下的核验链指向上一层核验，沿链找到原任务。
    for (let hops = 0; hops < 20; hops++) {
      const up = await conductor.waitJob(root, 0, signal).catch(() => undefined);
      if (!up || unknownState(up) || !up.context?.verification_of) break;
      root = up.context.verification_of;
    }
    return `${tool}: ${source.job_id} 是核验任务（核验对象 ${source.context.verification_of}）。核验只做一层：核验任务本身不复核、也不再核验，` +
      `它的报告已自动算作原任务的独立依据。直接用 codex_review 记录原任务 ${root}；对核验结论有疑问时，对 ${root} 再派 codex_verify 并在 focus 写明要复查哪条结论。`;
  }

  function dispatchVerification(source, args, exec, onStarted) {
    source = withReport(source);
    rememberProducts(source);
    const samples = args.samples ?? 8;
    const required = mustVerifyCriteria(source);
    const excluded = historicalIndexes(source);
    const historicalRows = cfg.historicalGapReview && ['accepted_deviations', 'needs_changes'].includes(source.verification?.status)
      ? new Set((source.verification.report_rows ?? []).filter(item => item.historical_gap).map(item => item.row)) : new Set();
    if (excluded.length === source.context.acceptance.length && !required.length) {
      throw new Error(`codex_verify: 原任务 ${source.job_id} 的验收全是已结案的不可补回历史证据，无需核验。`);
    }
    const engine = verifyEngine(args.engine, source, cfg);
    const same = engine === jobEngine(source);
    const options = source.task_options ?? {};
    return dispatch({ task: verificationTask(source, { ...args, samples }, required, excluded),
      acceptance: [...required.map(verifyCriterionItem), '读取原任务书、验收标准和已产出的文件，明确核验范围。',
        `独立抽查 ${samples} 条带出处的结论；不足时全部核对并说明实际条数。`,
        '每条写明核对的结论、出处、是否属实；不属实时给出实际情况，无法确认时说明缺口。',
        '全程保持项目和系统状态只读，测试的临时文件和缓存写入项目外。',
        // 原报告自标未满足的验收项逐条单列，核验结论可作为这些项的独立依据。
        ...flaggedCriteria(source).filter(item => !required.some(f => f.key === item.key) &&
          !excluded.includes(item.index) && !historicalRows.has(item.row)).map(verifyCriterionItem)],
      cwd: source.cwd, write: false, scope: [], writable_roots: [],
      engine,
      host_access: source.sandbox === 'danger-full-access',
      use_user_config: source.task_options?.use_user_config === true,
      // 核验只读：配置了 readOnlyEffort 时按它，否则沿用原任务的思考程度。
      ...(engine === 'codex' ? {
        effort: cfg.readOnlyEffort || (same ? options.effort : cfg.effort) || undefined,
        model: cfg.modelAB.enabled || !same ? cfg.model : options.model ?? '',
        service_tier: same ? options.service_tier ?? '' : cfg.serviceTier,
      } : same ? { model: options.model ?? undefined, effort: options.effort ?? undefined } : {}),
      ...(args.wait_seconds !== undefined ? { wait_seconds: args.wait_seconds } : {}),
    }, exec, undefined, undefined, source.job_id, undefined,
    cfg.verificationReuse ? { verification_scope: verificationScope(source, args, excluded) } : undefined, { onStarted });
  }

  ctx.tools.register({
    ...PRESENT.codex_status,
    name: 'codex_status',
    description: '每次只等待传入 job_id 对应的 Codex 任务。' + WAIT_GUIDANCE +
      '中止本工具或 job_output 只停止观察。取消用 codex_cancel 或后台任务的显式取消。运行中返回最近活动及距今秒数、阶段和尝试轮次。' +
      '用 codex_output 分段读取任务、验收标准和报告。',
    parameters: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: '派单返回的 runner job_id。' },
        wait_seconds: { type: 'integer', description: '传 3600 在本轮等待，超时续等仍在跑的任务。省略或 0 即时查询，勿重复轮询。中止等待不取消 Codex。' },
      },
      required: ['job_id'],
    },
    output: OUTPUT,
    async execute(args, exec) {
      if (typeof args?.job_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(args.job_id)) throw new Error('codex_status: job_id 无效；请用 codex_jobs 找回 runner 任务编号');
      if (args.wait_seconds !== undefined && (!Number.isInteger(args.wait_seconds) || args.wait_seconds < 0)) {
        throw new Error('codex_status: wait_seconds 必须是非负整数');
      }
      // 普通任务号不经过 await，保持原来的调用时序。
      const { jobId, note: threadNote } = THREAD_ID.test(args.job_id) ? await threadJob(args.job_id, exec, 'codex_status', exec?.signal) : { jobId: args.job_id };
      args = { ...args, job_id: jobId };
      const seconds = Math.min(args.wait_seconds ?? 0, 86_400);
      let source;
      const value = await queryWithTimeout(async (signal) => {
        const bg = liveBackground(args.job_id, exec);
        // 原生后台状态不一定带 runner 归属，热加载后的首次等待先查持久化任务。
        if (bg && restrictedReads(exec)) {
          source = await ensureOwnJob(args.job_id, exec, 'codex_status');
          signal.throwIfAborted();
        }
        const waitSignal = exec?.signal ? AbortSignal.any([signal, exec.signal]) : signal;
        return collect(args.job_id, bg, seconds, waitSignal);
      }, undefined, seconds * 1000 + QUERY_TIMEOUT_MS);
      if (restrictedReads(exec) && !value.rendered) checkJobOwner(value, exec, 'codex_status');
      const result = value.rendered ? await verifyRendered(value, exec, source) : notifyOnDone(await finishStatus(value, exec), exec, finishStatus);
      const shown = dampenStatus(result, exec, 'codex_status', seconds) ?? result;
      return !threadNote ? shown : typeof shown.rendered === 'string' ? { ...shown, rendered: `${threadNote}\n${shown.rendered}` }
        : { ...shown, next: shown.next ? `${threadNote}\n${shown.next}` : threadNote };
    },
  });

  ctx.tools.register({
    ...PRESENT.codex_cancel,
    name: 'codex_cancel',
    description: '按 runner job_id 取消任务，同时结束该任务的执行进程树。适用于 Codex 和 Gemini。',
    parameters: {
      type: 'object',
      properties: { job_id: { type: 'string', description: 'codex_run 返回的 job_id。' } },
      required: ['job_id'],
    },
    output: OUTPUT,
    async execute(args, exec) {
      if (typeof args?.job_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(args.job_id)) throw new Error('codex_cancel: job_id 无效；请用 codex_jobs 找回 runner 任务编号');
      await ensureOwnJob(args.job_id, exec, 'codex_cancel');
      const bg = liveBackground(args.job_id, exec);
      // open 模式也不取消别的会话的任务；本会话登记着的后台任务不用再查，归属未知的旧任务仍可取消。
      if (!bg && !restrictedReads(exec) && exec?.agent?.id) {
        const owner = (await conductor.waitJob(args.job_id, 0, exec.signal)).context?.owner;
        if (owner && !owns(exec.agent.id, owner)) {
          throw new Error(`codex_cancel: 任务 ${args.job_id} 属于另一个会话，未取消。确需取消时在该会话里操作，或由用户在设置的“Codex 指挥”面板取消。`);
        }
      }
      // 取消前先挂上等待：后台循环随后看到任务结束并结算，算作已被等到，DSH 不再另发一条结束通知。
      // 取消未确认时撤掉等待，免得吞掉任务之后真正结束时的通知。
      const stop = new AbortController();
      const settled = bg?.jobs.wait(bg.id, CANCEL_SETTLE_MS, bg.owner, stop.signal).catch(() => {});
      const value = await conductor.cancel(args.job_id);
      const unconfirmed = cancelUnconfirmed(value);
      if (unconfirmed) stop.abort();
      await settled;
      // 下一步要贴合「取消」这件事，不能套用重派话术
      const done = withReport({ job_id: args.job_id, ...value });
      let next;
      if (unconfirmed) {
        next = `取消未确认（${done.error_kind ?? done.status}），Codex 任务 ${args.job_id} 可能仍在运行：` +
          `用 codex_jobs 核对正确 job_id，再用 codex_status 查询 ${args.job_id}；需要取消时可再调用 codex_cancel，不要重派。`;
      } else if (done.status === 'completed') {
        // 取消没赶上：任务已经完成，改动已经留下，按完成处理
        next = `取消没有生效：任务在取消前已经完成，改动已经留下。先把这点告诉用户。\n${nextStep(done, undefined, undefined, cfg)}`;
      } else if (done.status === 'cancelled') {
        next = ['lock_wait', 'engine_wait'].includes(done.phase) ? nextStep(done, undefined, undefined, cfg)
          : '已按本次调用取消。可写任务可能已改了一部分且没有改动清单，核验或重派前先用 git status 或对比文件确认现状。';
      } else if (done.error_kind === 'repeated_failure') {
        next = nextStep(done, undefined, undefined, cfg);
      } else {
        next = `任务 ${args.job_id} 在取消前已经结束（${done.error_kind ?? done.status}），没有结束任何进程；是否重派或续跑由用户决定，不要自行重派。`;
      }
      return withCompletionNotices({ ...done, next }, exec, { allowFallback: false });
    },
  });

  async function historySelection(args, exec) {
    for (const key of ['cwd', 'session_id', 'thread_id', 'parent_job']) if (args[key] !== undefined &&
      (typeof args[key] !== 'string' || !args[key].trim())) throw new Error(`${key} 必须是非空字符串`);
    let owner = args.session_id === 'current' ? exec?.agent?.id : args.session_id;
    if (restrictedReads(exec)) {
      if (!exec.agent.id || (owner !== undefined && owner !== exec.agent.id)) throw new Error('只能读取本会话的任务记录；请用 session_id="current"。');
      owner = exec.agent.id;
    }
    if (args.session_id && owner === undefined) throw new Error('当前调用没有会话 ID');
    const cwd = args.cwd ?? (owner === undefined ? taskCwd({}, sessionCwd(exec), cfg.workspaces) : undefined);
    if (cwd === undefined && owner === undefined) throw new Error('请传 cwd 或 session_id');
    const historyOwner = owner ?? exec?.agent?.id;
    let events = historyOwner === exec?.agent?.id ? exec?.agent?.session?.log ?? [] : [];
    const query = owner !== undefined ? ctx.get?.('sessionQuery') : undefined;
    const observation = query ? await query.observeSession(owner, { projectionMode: 'none', signal: exec?.signal }) : undefined;
    let history, settled;
    try {
      events = observation?.events ?? events;
      const ownJobs = events.filter((e) => e.seq >= (observation?.inheritedEventCount ?? 0) &&
        (e.type === 'job/registered' || e.type === 'job/settled') && e.data.kind === 'codex' && e.data.owner === historyOwner);
      history = ownJobs.filter((e) => e.type === 'job/registered')
        .map((e) => ({ id: e.data.jobId, owner: e.data.owner, kind: e.data.kind, label: e.data.label }));
      settled = new Set(ownJobs.filter((e) => e.type === 'job/settled').map((e) => e.data.jobId));
    } finally { observation?.[Symbol.dispose](); }
    const native = (ctx.get?.('jobs')?.list(historyOwner) ?? []).filter((j) => j.owner === historyOwner);
    const linked = new Map([...history, ...native].filter((j) => j.kind === 'codex').flatMap((j) => {
      const match = /^Codex ([^\s·]+)/.exec(j.label ?? '');
      return match ? [[match[1], j]] : [];
    }));
    const filters = Object.fromEntries(['status', 'needs_attention', 'limit', 'offset', 'thread_id', 'parent_job']
      .filter((key) => args[key] !== undefined).map((key) => [key, args[key]]));
    return { owner, linked, settled, filters: { ...filters, ...(cwd !== undefined ? { cwd } : {}),
      ...(owner !== undefined ? { owner, also_owners: aliases.predecessors(owner),
        ...(!restrictedReads(exec) ? { job_ids: [...linked.keys()] } : {}) } : {}) } };
  }

  async function recoverBackground(agent) {
    const owner = agent?.id;
    const agents = ctx.get?.('agents');
    if (!owner || agents?.get(owner) !== agent || !ctx.get?.('jobs')) return;
    const exec = { agent };
    const { linked, settled } = await historySelection({ session_id: 'current' }, exec);
    const pending = new Map([...linked].filter(([, entry]) => entry.status === undefined && !settled.has(entry.id)));
    if (!pending.size) return;
    for (let offset = 0; offset !== null;) {
      const history = await conductor.list({ owner, job_ids: [...pending.keys()], limit: 100, offset });
      if (!Array.isArray(history.jobs)) throw new Error('无法核对原任务状态');
      for (const value of history.jobs) {
        const entry = pending.get(value.job_id);
        if (!entry || value.context?.owner !== owner || unknownState(value) ||
            !['running', 'completed', 'failed', 'cancelled'].includes(value.status)) continue;
        if (agents.get(owner) !== agent) return;
        if (!liveBackground(value.job_id, exec, true)) background(value.job_id, exec, finishStatus, entry.label);
      }
      offset = history.next_offset ?? null;
    }
  }

  ctx.tools.register({
    name: 'codex_jobs',
    description: '只读列出 Codex 和 Gemini 任务，找回 runner job_id、引擎、原会话编号和本会话的 Harness 后台任务编号。' +
      '默认查当前工作区，可用 session_id="current" 查当前会话，或传指定会话 ID；旧任务归属未知时按 cwd 查。' +
      '可按执行状态或 needs_attention 筛选；新任务带派单版本和进程号，有在线后台记录时同时显示 Harness 后台状态。' +
      'completed 只表示执行结束，自报全部满足仍需独立核验。不会启动或恢复任务。',
    presentCall: () => ({ card: 'generic', kind: 'read', title: 'Codex 任务历史' }),
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '任务工作目录，省略且未指定会话时使用当前工作区。' },
        session_id: { type: 'string', description: 'Harness 会话 ID；current 表示当前会话。' },
        status: { type: 'string', enum: ['running', 'completed', 'cancelled', 'failed', 'unknown'], description: '按执行状态筛选。' },
        needs_attention: { type: 'boolean', description: '仅列出失败、取消、报告异常、受阻或有未解决事项的任务。' },
        thread_id: { type: 'string', description: '仅查指定 Codex 线程。' },
        parent_job: { type: 'string', description: '仅查从这个 runner job_id 续接的后续轮次。' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: '每页条数，默认 20。' },
        offset: { type: 'integer', minimum: 0, description: '分页起点，默认 0。' },
      },
    },
    output: DATA_OUTPUT,
    async execute(args = {}, exec) {
      if (args.status !== undefined && !['running', 'completed', 'cancelled', 'failed', 'unknown'].includes(args.status)) throw new Error('codex_jobs: status 无效');
      if (args.needs_attention !== undefined && typeof args.needs_attention !== 'boolean') throw new Error('codex_jobs: needs_attention 必须是布尔值');
      if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)) throw new Error('codex_jobs: limit 必须是 1–100 的整数');
      if (args.offset !== undefined && (!Number.isInteger(args.offset) || args.offset < 0)) throw new Error('codex_jobs: offset 必须是非负整数');
      return queryWithTimeout(async (signal) => {
        const { filters, linked, owner } = await historySelection(args, { ...exec, signal });
        signal.throwIfAborted();
        const value = await conductor.list(filters, signal);
        if (!Array.isArray(value.jobs)) return value;
        const hint = handoverHint(exec?.agent);
        return { ...value, jobs: value.jobs.map((job) => {
          const bg = linked.get(job.job_id);
          return { ...listedJob(job), ...(bg ? { background_job_id: bg.id, owner: bg.owner,
            ...(bg.status ? { background_status: bg.status } : {}) } : {}) };
        }), ...(owner !== undefined ? { note: '无法从会话历史或任务元数据确认归属的旧任务，可用 cwd 按工作区找回；完整结果用 codex_output 读取。' } : {}),
          ...(hint ? { handover_hint: hint } : {}) };
      }, exec?.signal);
    },
  });

  ctx.tools.register({
    name: 'codex_output',
    description: '只读、可重复地分段读取 Codex 或 Gemini 的完整原始报告、runner 结果、任务书与验收标准或诊断日志。' +
      'job_output 截断或已经消费结果时，用本工具找回；不会消费报告、启动或恢复任务。' +
      'offset 和 next_offset 按 Unicode 字符计算，按 next_offset 接着读取，直至 eof=true。',
    presentCall: (a) => ({ card: 'generic', kind: 'read', title: `Codex 完整结果 ${a?.job_id ?? ''}` }),
    parameters: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'runner job_id；可用 codex_jobs 找回，不是 Harness 的 background_job_id。' },
        artifact: { type: 'string', enum: ['report', 'result', 'context', 'review', 'stderr', 'events', 'diff'], description: 'report 原始全文；result 执行结果；context 原任务和验收标准；review 独立核验历史；stderr 标准错误日志；events JSONL 事件日志；diff 本单在 git 仓库里的改动（可写任务，结果里 diff_status 为 captured 时有）。默认 report。' },
        offset: { type: 'integer', minimum: 0, description: 'Unicode 字符起点，默认 0。' },
        limit: { type: 'integer', minimum: 1, maximum: 8000, description: '每段最多字符数，默认 4000。' },
      },
      required: ['job_id'],
    },
    output: DATA_OUTPUT,
    async execute(args, exec) {
      if (typeof args?.job_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(args.job_id)) throw new Error('codex_output: job_id 无效；请用 codex_jobs 找回 runner 任务编号');
      if (args.artifact !== undefined && !['report', 'result', 'context', 'review', 'stderr', 'events', 'diff'].includes(args.artifact)) throw new Error('codex_output: artifact 无效');
      if (args.offset !== undefined && (!Number.isInteger(args.offset) || args.offset < 0)) throw new Error('codex_output: offset 必须是非负整数');
      if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 8000)) throw new Error('codex_output: limit 必须是 1–8000 的整数');
      // 普通任务号不经过 await，保持原来的调用时序。
      const { jobId, note: threadNote } = THREAD_ID.test(args.job_id) ? await threadJob(args.job_id, exec, 'codex_output', exec?.signal) : { jobId: args.job_id };
      args = { ...args, job_id: jobId };
      await ensureOwnJob(args.job_id, exec, 'codex_output');
      const value = { ...await conductor.output(args.job_id, args, exec?.signal), ...(threadNote ? { thread_note: threadNote } : {}) };
      return value.error_kind === 'artifact_pending' || (value.status === 'pending' && !value.error_kind && !value.error)
        ? { ...value, note: `任务还在运行，报告尚未生成；${waitForJob(args.job_id)}` }
        : value;
    },
  });

  const continuations = new Map();
  ctx.tools.register({
    name: 'codex_continue',
    description: (cfg.ownerDecisions === 'planner' || cfg.plannerAnswers ? '在规划端回答阻塞问题或环境条件已改变后续接原任务；' : '在用户回答阻塞问题或环境条件已改变后续接原任务；') +
      '先核对原归属，保留原 cwd、验收、write、scope 和权限。默认续接原引擎；显式切换引擎时开新会话并附上轮交接。' + engineGuidance(cfg) +
      (cfg.historicalGapReview ? '已结案的不可补回历史项不再带入验收。' : '') +
      (cfg.convergenceGuard ? '同一交付链同一阻塞连续两轮且参数未变时，仅凭变化说明最多再试一次。' : '') +
      (cfg.ownerDecisions === 'planner' ? '按所有者常设授权提交 answers 或 resolution，写选定方案、理由和放弃的方案。不可逆或对外动作、花钱、账号凭据及扩大安全边界留给所有者；'
        : cfg.plannerAnswers ? 'answers 用阻塞问题的 id，可由规划端回答；' + PLANNER_ANSWERS : 'answers 用阻塞问题的 id，须来自原会话中的实际用户回复；') +
      '缺回答时只返回问题。resolution 说明环境变化或旧报告解除阻塞的事实。原任务运行中、状态未知或已取消时不重派。' +
      '已有后续轮次时返回该轮次，不从同一个父任务重复派活。后续修正请用最新 job_id。verify_previous 可在续接的同时只读核验另一单。' + WAIT_GUIDANCE,
    presentCall: (a) => ({ card: 'generic', kind: 'execute', title: `续接 Codex ${a?.job_id ?? ''}` }),
    parameters: { type: 'object', properties: {
      job_id: { type: 'string' },
      engine: engineParameter,
      answers: { type: 'array', items: { type: 'object', additionalProperties: false,
        properties: { id: { type: 'string' }, answer: { type: 'string' } }, required: ['id', 'answer'] } },
      resolution: { type: 'string', description: '已满足环境条件或查明旧阻塞的具体事实，不是授权扩大范围。' },
      acceptance_needs: ACCEPTANCE_NEEDS,
      expect_blocked: EXPECT_BLOCKED,
      rerun_after_change: RERUN_AFTER_CHANGE,
      fresh: { type: 'boolean', description: '不传时由插件决定：不带 answers 且原线程很大时开新线程（附上轮交接内容），否则沿用原线程。' +
        'true 强制开新线程，false 强制沿用原线程；带 answers 的续接默认沿用原线程。' },
      verify_previous: { type: 'string', description: '可选：另一个已结束任务的 job_id，续接的同时只读核验它；续接可写且写入范围与它的产物或 scope 重叠时拒绝。' },
      wait_seconds: { type: 'integer', minimum: 0, description: waitSecondsDescription },
    }, required: ['job_id'] },
    output: OUTPUT,
    async execute(args, exec) {
      checkEngine(args?.engine);
      if (typeof args?.job_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(args.job_id)) throw continuationError('codex_continue: job_id 无效；请先用 codex_jobs 找回原任务的 runner 编号，再对它续接，不要因为这个报错另开新单');
      const owner = exec?.agent?.id;
      if (!owner) throw continuationError('codex_continue: 当前调用没有会话 ID');
      if (args.wait_seconds !== undefined && (!Number.isInteger(args.wait_seconds) || args.wait_seconds < 0)) throw continuationError('wait_seconds 必须是非负整数');
      if (args.fresh !== undefined && typeof args.fresh !== 'boolean') throw continuationError('fresh 必须是布尔值');
      if (args.rerun_after_change !== undefined && (typeof args.rerun_after_change !== 'string' || !args.rerun_after_change.trim())) {
        throw continuationError('rerun_after_change 必须是非空字符串');
      }
      const key = `${owner}:${args.job_id}`;
      if (continuations.has(key)) return continuations.get(key);
      const pending = (async () => {
        const source = withReport(await conductor.waitJob(args.job_id, 0));
        exec?.signal?.throwIfAborted();
        if (!owns(owner, source.context?.owner)) throw continuationError('codex_continue: 原任务归属未知或不属于当前会话');
        const children = await conductor.list({ owner, also_owners: aliases.predecessors(owner), parent_job: args.job_id, limit: 1 }, exec?.signal);
        if (!Array.isArray(children.jobs)) throw continuationError(`codex_continue: 无法核对已有续接：${children.error ?? children.status}`);
        if (children.jobs.length) {
          const child = withReport(await conductor.waitJob(children.jobs[0].job_id, 0));
          const bg = liveBackground(child.job_id, exec);
          return { ...child, reused: true, reused_existing_child: true, submitted: false, ...(bg ? { background_job_id: bg.id } : {}),
            next: `本次 answers/resolution 未应用，继续使用 job ${child.job_id}；要补充新内容请对 ${child.job_id} 调 codex_continue。\n${nextStep(child, undefined, undefined, cfg)}` };
        }
        // 归属已按交接别名核对；交给 prepareContinuation 的是原任务自己的归属方。
        const plannerDecides = cfg.ownerDecisions === 'planner';
        const plan = prepareContinuation(source, args, source.context.owner, plannerDecides);
        const log = exec.agent.session?.log ?? [];
        const needsReply = plan.ready && plan.blocking.questions.length > 0 &&
          !plannerDecides && !canAnswer(log, source, owner);
        if (!plan.ready || needsReply) return { ...source, continuation_ready: false, blocking: plan.blocking,
          ...(cfg.actionableReceipts && plan.blocking.questions.length ? { resubmit: continuationSubmission(source, args.answers) } : {}),
          remaining_questions: needsReply ? plan.blocking.questions : plan.remaining_questions,
          next: cfg.plannerAnswers && plan.blocking.questions.length ? plan.next + PLANNER_ANSWERS : needsReply
            ? '原会话尚未收到这些问题产生后的用户回复。先向用户确认，等实际回答后再用 codex_continue 提交 answers。' : plan.next };
        const blockerIds = ownerBlockerIds([...(source.report?.blockers ?? []), ...plan.blocking.blockers]);
        const resolves = resolvedBlockerIds(blockerIds, plan.continuation);
        if (plannerDecides && resolves.length && !hasUserReply(log, source, owner, cfg.autoResume.message)) {
          Object.assign(plan.continuation, { decided_by: 'planner', decision_basis: 'standing_authorization',
            decided_at: Date.now() / 1000, resolves });
        }
        const verifyPrevious = args.verify_previous === undefined ? null : await verifyPreviousCheck(args.verify_previous, plan.args, exec, 'codex_continue');
        const sourceEngine = jobEngine(source);
        const engine = cfg.lockEngine ? runEngine({}, cfg) : args.engine ?? sourceEngine;
        plan.args.engine = engine;
        if (engine !== sourceEngine) {
          for (const key of ['resume', 'conversation_id', 'agy_home', 'model', 'service_tier', 'effort', 'use_user_config']) delete plan.args[key];
        }
        if (args.fresh === true) delete plan.args.conversation_id;
        const thread = engine === 'codex' ? await continuationThread(plan, args, exec?.signal) : null;
        if (thread?.mode === 'fresh') delete plan.args.resume;
        const route = retainThreadModel(plan.args, engine === 'codex' && engine === sourceEngine ? source : undefined,
          routingOf(thread, verifyPrevious ? args.verify_previous : undefined));
        const value = await dispatch({ ...route.args, rerun_after_change: args.rerun_after_change,
          ...(cfg.dispatchConsistency ? { required_writes: source.context.routing?.required_writes } : {}),
          acceptance_needs: args.acceptance_needs, expect_blocked: args.expect_blocked,
          ...(args.wait_seconds !== undefined ? { wait_seconds: args.wait_seconds } : {}) },
          exec, plan.continuation, plan.task, undefined, undefined, route.routing, { parent: source });
        const verify = verifyPrevious && value.job_id ? await startVerifyPrevious(args.verify_previous, exec) : null;
        if (verify) {
          const { line: verifyLine, ...verifyResult } = verify;
          Object.assign(value, { verify_previous: verifyResult, next: value.next ? `${value.next}\n${verifyLine}` : verifyLine });
        }
        if (engine !== sourceEngine && value.job_id) {
          value.next = [`已从 ${sourceEngine} 切换为 ${engine}，新任务 ${value.job_id} 已带上轮交接。`, value.next].filter(Boolean).join('\n');
        }
        if (!thread) return value;
        const line = thread.mode === 'fresh'
          ? `已开新线程续接（原线程 ${thread.parent_thread_id}${thread.parent_last_input_tokens ? ` 上次请求约 ${thread.parent_last_input_tokens} 输入 token` : ''}），新任务 ${value.job_id ?? '（见上）'}，任务里附了上轮交接内容；之后的返工对新任务 ${value.job_id ?? ''} 调 codex_continue，不要再 resume 原线程。`
          : '';
        return { ...value, continuation_thread: thread, ...(line ? { next: value.next ? `${line}\n${value.next}` : line } : {}) };
      })();
      continuations.set(key, pending);
      try { return await pending; } finally { continuations.delete(key); }
    },
  });

  const ACCEPTED_FIELD = { type: 'string', minLength: 1, description: '只用于 accepted_deviations 里保留 not_met/blocked 的条目：为什么接受这一条未满足。其他情况省略。' };
  const OWNER_ONLY_FIELD = { type: 'string', enum: OWNER_ONLY_REASONS, description: '只用于有 accepted 的未满足条目，注明须由所有者决定的原因。' };
  const historicalGapField = cfg.historicalGapReview ? { historical_gap: { type: 'string', enum: HISTORICAL_GAP_KINDS,
    description: '原报告未满足、客观无法补回的历史记录。在 accepted 写原因。must_verify、安全及数据完整性项不得使用。' } } : {};
  async function submitReview(job_id, source, prepared, level, owner, signal) {
    const { review } = prepared;
    const previousTime = source.verification?.time ?? -Infinity;
    const unit = prepared.acceptedOpen.some(entry => entry.owner_only) ? await ownerUnit(source, owner, signal) : undefined;
    const result = await conductor.review(job_id, review, owner, signal);
    // runner 返回作业状态，执行时的错误会和新写入的复核一起返回。
    const appended = result?.verification_status === review.status &&
      Number.isFinite(result.verification?.time) && result.verification.time > previousTime && !unknownState(result);
    let ledger = {};
    if (appended && ['verified', 'accepted_deviations'].includes(review.status)) {
      // 自标未满足的条目在 planner / off 级别下记成 met，单独计数，不混进有依据的 all_met。
      const flaggedMet = flaggedCriteria(source).some((f) => (f.row ? review.report_rows ?? [] : review.criteria)
        .some((c) => (f.row ? c?.row === f.row : c?.index === f.index) && c.status === 'met'));
      countCloseout(owner, openAccepted(review) ? 'accepted_open'
        : flaggedMet && level !== 'independent' ? 'met_planner_level' : 'all_met');
      ledger = recordAcceptedOpen(source, prepared.acceptedOpen, result.verification.time, owner, unit);
      if (!ledger.ledgerWarning) await clearLaterRoundItems(source, result.verification, owner, signal);
    } else if (appended && prepared.acceptedOpen.some(item => item.historical_gap)) {
      ledger = recordAcceptedOpen(source, prepared.acceptedOpen, result.verification.time, owner, unit, true);
    }
    // 无 job_id 的参数错误属于复核调用，不能按 Codex 执行结果补状态。
    if (result?.error_kind === 'bad_arguments' && !result.job_id) {
      const message = `codex_review: 复核操作失败：${result.error}。请先处理这项复核错误再重新提交；` +
        `用 codex_status 查询原任务 ${job_id}，不要仅因此重新派活。`;
      throw new Error(message + (cfg.actionableReceipts ? `\ncodex_review ${JSON.stringify(reviewSkeleton(job_id, source, review))}` : ''));
    }
    if (prepared.inferred && appended) countCloseout(owner, 'accepted_inferred');
    return { appended, result, ...ledger };
  }

  ctx.tools.register({
    name: 'codex_review',
    description: '规划端独立检查后记录逐条验收证据，保留 Codex 原报告。verified=全部核验通过，needs_changes=仍需修正，' +
      (cfg.plannerAnswers ? 'accepted_deviations=逐条通过且规划端按用户原始目标和已有事实接受原报告偏差或范围外改动。' + PLANNER_ANSWERS
        : 'accepted_deviations=逐条通过且原会话用户已明确接受原报告偏差或范围外改动。') +
      '不能把 Codex 自报 met 当作独立核验。审计/核对类任务逐项判断是否完成核对：已完成记 met；被审正文的缺陷写入 notes/结论，不因此记 needs_changes。' +
      '全 met、无活动 blocker 且无报告偏差或范围外改动时，拒绝 needs_changes。' +
      '被拒时回执附一份可直接修改提交的骨架，只需替换其中的占位。' +
      'verified 不能与原报告矛盾：报告自标 not_met/blocked 的条目要写你自己的核验证据；报告的未决项和阻塞须在 notes 逐项写「unresolved#N: 依据」「blocker:<id>: 依据」。' +
      'accepted_deviations 可以把核实后仍未满足的条目保留 not_met/blocked，并在该条目的 accepted 写接受原因。' +
      (cfg.historicalGapReview ? '客观无法补回的历史记录可用 historical_gap 分类，仍须在 accepted 写明原因。' : '') +
      'Codex 因正文有错把已完成核对标为 not_met 时，按原验收纠正。只能记录当前会话拥有的任务。核验任务不复核：核验结论记在原任务上。',
    presentCall: (a) => ({ card: 'generic', kind: 'execute', title: `记录 Codex 核验 ${a?.job_id ?? ''}` }),
    parameters: { type: 'object', additionalProperties: false, properties: {
      job_id: { type: 'string' }, status: { type: 'string', enum: ['verified', 'needs_changes', 'accepted_deviations'] },
      criteria: { type: 'array', items: { type: 'object', additionalProperties: false,
        properties: { index: { type: 'integer', minimum: 1 }, status: { type: 'string', enum: ['met', 'not_met', 'blocked'] },
          evidence: { type: 'string', minLength: 1 }, accepted: ACCEPTED_FIELD, owner_only: OWNER_ONLY_FIELD, ...historicalGapField }, required: ['index', 'status', 'evidence'] } },
      report_rows: { type: 'array', description: 'Codex 报告行数与验收条数不同时，报告自标 not_met/blocked 又对不上任何验收原文的行，按报告行号（从 1 起）逐行记录；规则与 criteria 相同。没有这种行时省略。',
        items: { type: 'object', additionalProperties: false, properties: { row: { type: 'integer', minimum: 1 },
          status: { type: 'string', enum: ['met', 'not_met', 'blocked'] }, evidence: { type: 'string', minLength: 1 }, accepted: ACCEPTED_FIELD, owner_only: OWNER_ONLY_FIELD, ...historicalGapField },
        required: ['row', 'status', 'evidence'] } },
      notes: { type: 'string', description: '没有补充说明可省略。' },
      accepted_deviations: { type: 'array', description: cfg.plannerAnswers
        ? '规划端按用户原始目标和已有事实接受偏差或范围外改动时，逐项记录决定依据；没有时可省略。' + PLANNER_ANSWERS
        : '原会话用户在作业结束后明确接受偏差或范围外改动时，逐项记录确认依据；没有时可省略。', items: { type: 'object', additionalProperties: false,
        properties: { kind: { type: 'string', enum: ['reported', 'scope'] }, index: { type: 'integer', minimum: 1 },
          evidence: { type: 'string', minLength: 1 } }, required: ['kind', 'index', 'evidence'] } },
      blockers: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string' }, kind: { type: 'string', enum: ['user_input', 'task_conflict', 'environment', 'implementation'] },
        message: { type: 'string' }, question: { type: 'string' }, resolution: { type: 'string' },
      }, required: ['id', 'kind', 'message', 'question', 'resolution'] } },
    }, required: ['job_id', 'status', 'criteria'] },
    output: REVIEW_OUTPUT,
    async execute(args, exec) {
      const owner = exec?.agent?.id;
      const noSuchJob = async message => {
        if (!cfg.actionableReceipts || !owner) return message;
        const jobs = await sessionJobs(owner, exec?.signal).catch(() => []);
        const pending = pendingCloseout(jobs, closeoutFrom, reworkFrom);
        return message + await pendingReviewReceipts(owner, pending, exec?.signal);
      };
      if (typeof args?.job_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(args.job_id)) {
        throw new Error(await noSuchJob('codex_review: job_id 无效；请用 codex_jobs 找回 runner 任务编号'));
      }
      const source = await conductor.waitJob(args.job_id, 0);
      if (cfg.actionableReceipts && (source.error_kind === 'unknown_job' ||
          (unknownState(source) && !source.context?.owner))) {
        throw new Error(await noSuchJob(`codex_review: 未找到任务 ${args.job_id}；请核对本会话真实的 runner job_id。`));
      }
      if (!owns(owner, source.context?.owner)) throw new Error('codex_review: 原任务归属未知或不属于当前会话');
      if (source.context.verification_of) throw new Error(await verificationOnlyRefusal('codex_review', source, exec?.signal));
      exec?.signal?.throwIfAborted();
      const { job_id } = args;
      const level = evidenceLevel(source);
      const openLevel = openEvidenceLevel(source);
      const checkOpen = openLevel !== 'off' && args.status === 'accepted_deviations';
      let supports;
      const closing = ['verified', 'accepted_deviations'].includes(args.status);
      const log = exec.agent.session?.log ?? [];
      if (closing && (checkOpen || level === 'independent' || source.context?.must_verify?.length)) {
        try { supports = await criterionSupport(source, owner, log, exec?.signal, checkOpen); } catch { exec?.signal?.throwIfAborted(); }
      }
      const plannerDecides = cfg.ownerDecisions === 'planner' && ['accepted_deviations', 'needs_changes'].includes(args.status);
      const prepared = prepareReview(args, { ...source, evidenceLevel: level, openLevel, historicalGapReview: cfg.historicalGapReview, ...supports });
      const ownerProblem = await ownerReviewProblem(source, prepared, owner, exec?.signal);
      if (ownerProblem) throw new Error(reviewRejection(job_id, source, { ...prepared, problems: [ownerProblem] }));
      const { review } = prepared;
      const opened = prepared.acceptedOpen;
      const mayClose = canAnswer(log, source, owner) || (plannerDecides && !review.accepted_deviations?.length && opened.length > 0 &&
        (ownerBlockerIds(source.structured?.blockers).length > 0 || opened.every(entry => entry.owner_only || entry.historical_gap)));
      if (!prepared.openUnsupported && (review.accepted_deviations?.length || openAccepted(review)) && !mayClose) {
        const message = '原会话尚未收到作业结束后的用户确认，未写入核验记录。不要替用户接受偏差。';
        throw new Error(cfg.actionableReceipts ? reviewRejection(job_id, source, { ...prepared, problems: [...prepared.problems, message] })
          : `codex_review: ${message}`);
      }
      if (prepared.problems.length) {
        const verification_id = supports?.runningVerification;
        // 只有结案复核仅缺保留开放项的依据、没有缺依据的 met，且用户确认已过关，才挂起等待本任务正在跑的核验。
        if (parkedFile && closing && verification_id && prepared.problems.length === prepared.openUnsupported &&
            prepared.unsupported === 0 && mayClose) {
          exec?.signal?.throwIfAborted();
          const entries = readParkedReviews();
          if (entries) {
            const entry = { job_id, owner, verification_id, review, park_support: supports.openSupport, at: Date.now() / 1000 };
            writeJsonAtomic(parkedFile, [...entries.filter(e => e.job_id !== job_id), entry]);
            countCloseout(owner, 'review_parked');
            const verification = await conductor.waitJob(verification_id, 0).catch(parkedWarning);
            const settled = verification && await observeParkedReview(verification).catch(parkedWarning);
            if (settled) return { status: settled.parked_review.outcome, job_id, verification_id,
              parked_review: settled.parked_review, next: settled.line };
            return { status: 'parked', job_id, verification_id,
              next: `${job_id} 的复核已挂起：核验 ${verification_id} 结束后，插件在 ${verification_id} 的完成通知里给出按依据规则的判定和可直接提交的复核，` +
                `那时再提交一次 codex_review ${job_id}。挂起期间可以去派与 ${job_id} 写入范围不重叠的下一单（收尾护栏照常核对）。` };
          }
        }
        if (prepared.unsupported) countCloseout(owner, 'rejected_unsupported');
        if (prepared.openUnsupported) countCloseout(owner, 'rejected_open_unsupported');
        const running = verification_id && prepared.unsupported && !prepared.openUnsupported ? `核验 ${verification_id} 正在跑，等它结束再记；` : '';
        throw new Error(running + reviewRejection(job_id, source, prepared));
      }
      const { appended, result, ledgerWarning, askOwner } = await submitReview(job_id, source, prepared, level, owner, exec?.signal);
      const value = withReport(result);
      const fixed = appended && prepared.fixed.length;
      const fixedLine = fixed ? `插件已按你的意图修正后写入：${prepared.fixed.join('；')}。` : '';
      return { ...value, ...(fixed ? { review_fixes: prepared.fixed } : {}),
        next: [fixedLine, nextStep(value, undefined, undefined, cfg), ledgerWarning, askOwner].filter(Boolean).join('\n') };
    },
  });

  ctx.tools.register({
    name: 'codex_summary',
    description: '只读汇总当前会话的多轮 Codex 任务；相同 thread_id 归为一组，无线程的独立列出。' +
      '上下文压缩或接手后先调 codex_summary，再按需读具体 job。' +
      '显示最新验收、待办、交付文件、累计已结束耗时、用量及筛选范围内的错误分类统计。thread_total 是线程累计值，不把每轮累计值重复相加。' +
      '可传 cwd 查一个项目，或 session_id 查指定会话；默认每页 10 组，用 limit 和 offset 翻页。不会启动或继续任务。',
    presentCall: () => ({ card: 'generic', kind: 'read', title: 'Codex 多轮任务汇总' }),
    parameters: { type: 'object', properties: {
      cwd: { type: 'string' }, session_id: { type: 'string' }, thread_id: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 100, description: '每页线程组数，默认 10。' },
      offset: { type: 'integer', minimum: 0, description: '从第几组开始，默认 0；下一页用 next_offset。' },
    } },
    output: { schema: DATA_OUTPUT.schema, render: (_args, value) => [{ type: 'text', text: Array.isArray(value.groups)
      ? [`Codex 汇总：${value.total} 组，${value.total_jobs} 轮；本页 ${value.groups.length} 组。` +
        (value.next_offset == null ? '' : `沿用筛选和每页条数，传 offset=${value.next_offset} 查看下一页。`) +
        '执行结束与独立验收分别显示。',
        `错误分类（全部匹配任务）：${value.error_kinds ? Object.entries(value.error_kinds).map(([kind, count]) => `${kind}=${count}`).join('、') || '无' : '未知'}`,
        ...value.groups.map((g) =>
        [`${g.thread_id ?? g.group_id} · ${g.total_rounds} 轮 · 最新 ${g.latest_job_id} · 执行 ${g.latest_job?.execution_status ?? g.latest_job?.status ?? 'unknown'} · 独立核验 ${g.verification_status ?? 'unknown'}`,
          `目标：${taskLine(g.latest_job?.context, 160)}`, `最新结果：${g.summary ?? ''}`,
          ...(g.repeat_guard?.standing?.length ? [repeatStandingLine(g.repeat_guard.standing)] : []),
          `涉及文件（含历史改动）：${g.files_changed.join('、') || '无'}`, `未闭环事项：${JSON.stringify(g.open_items)}`,
          `已结束轮次耗时合计：${typeof g.finished_duration_s === 'number' ? `${Math.round(g.finished_duration_s)} 秒` : '未知'}；用量（${g.usage_scope}）：${g.usage == null ? '未知（原始用量不完整）' : JSON.stringify(g.usage)}`,
          ...(g.rounds_truncated ? ['只展示最新轮次明细；总轮数、文件集合与耗时按全部匹配记录计算。'] : []),
        ].join('\n')), ...(value.owner_decisions === undefined ? [] : [ownerDecisionLine(value.owner_decisions)]),
        ...(value.accepted_open_ledger === undefined ? [] : [ledgerLine(value.accepted_open_ledger, true)])].join('\n\n')
      : [JSON.stringify(value, null, 2), value.owner_decisions !== undefined && ownerDecisionLine(value.owner_decisions),
        value.accepted_open_ledger !== undefined && ledgerLine(value.accepted_open_ledger, true)].filter(Boolean).join('\n') }] },
    async execute(args = {}, exec) {
      const selected = args.cwd !== undefined || args.session_id !== undefined ? args : { session_id: 'current', ...args };
      const { filters } = await historySelection(selected, exec);
      const [summary, ledger] = await Promise.all([
        conductor.summary(filters, exec?.signal), acceptedOpenLedger(exec?.agent?.id, exec?.signal),
      ]);
      return { ...summary, accepted_open_ledger: ledger, owner_decisions: sessionOwnerDecisions(exec?.agent?.id) };
    },
  });

  ctx.tools.register({
    name: 'codex_watch',
    description: '为当前会话登记安静的原生后台观察：attention 仅在失败、受阻、报告异常等重要变化时通知；all 也通知开始/正常完成。' +
      '空闲时只观察 Harness 内存任务表，不反复启动 Codex 或唤醒模型。首次符合条件的变化后结束，需要继续观察可再调用。' +
      '停止这个观察任务只停止观察，不取消 Codex。任务本身原有的结束通知仍保留。',
    presentCall: () => ({ card: 'generic', kind: 'read', title: '安静观察 Codex' }),
    parameters: { type: 'object', properties: { mode: { type: 'string', enum: ['attention', 'all'] } } },
    output: DATA_OUTPUT,
    async execute({ mode = 'attention' } = {}, exec) {
      if (!['attention', 'all'].includes(mode)) throw new Error('codex_watch: mode 无效');
      const jobs = ctx.get?.('jobs');
      const owner = exec?.agent?.id;
      if (!jobs || !owner) throw new Error('codex_watch: 需要 Harness 原生后台任务服务与当前会话 ID');
      const label = `Codex 安静观察 · ${mode}`;
      const existing = jobs.list(owner).find((j) => j.owner === owner && j.kind === 'codex-watch' && j.label === label && ['running', 'stopping'].includes(j.status));
      if (existing) return { status: 'watching', background_job_id: existing.id, reused: true, mode };
      const snapshot = () => new Map(jobs.list(owner).filter((j) => j.owner === owner && j.kind === 'codex').flatMap((j) => {
        const id = /^Codex ([^\s·]+)/.exec(j.label ?? '')?.[1];
        return id ? [[j.id, { job_id: id, status: j.status }]] : [];
      }));
      let baseline = snapshot();
      const id = jobs.start({ owner, kind: 'codex-watch', label, outputLimitBytes: 32768,
        run(handle) {
          let stopped = false;
          let timer;
          let wake;
          const done = (async () => {
            handle.updateProgress('等待重要状态变化；无变化不唤醒模型');
            while (!stopped) {
              const current = snapshot();
              const changes = [...current].filter(([id, item]) => baseline.get(id)?.status !== item.status);
              for (const [id, item] of baseline) if (!current.has(id)) changes.push([id, { ...item, status: 'no_longer_listed' }]);
              baseline = current;
              const alerts = [];
              for (const [backgroundId, item] of changes) {
                if (mode === 'attention' && ['running', 'stopping'].includes(item.status)) continue;
                // 当前查询有界完成后再退出观察；不取消正在执行的 Codex。
                const value = withReport(await conductor.waitJob(item.job_id, 0));
                const closed = ['verified', 'accepted_deviations'].includes(value.verification_status);
                const attention = !closed && (!['running', 'completed', 'cancelled'].includes(value.status) ||
                  (value.status === 'completed' && (value.review_status === 'needs_attention' ||
                    ['needs_changes', 'invalid'].includes(value.verification_status))));
                if (mode === 'all' || attention) alerts.push({ job_id: item.job_id, background_job_id: backgroundId,
                  status: value.status, summary: value.report?.summary ?? value.error ?? summaryLine(value),
                  blocking: value.blocking, verification_status: value.verification_status, next: nextStep(value, undefined, undefined, cfg) });
              }
              if (stopped) break;
              if (alerts.length) return { status: 'completed', detail: `${alerts.length} 个重要状态变化`,
                result: JSON.stringify({ changes: alerts, note: '观察已结束；完整结果用 codex_output，多轮汇总用 codex_summary。' }, null, 2) };
              await new Promise((resolve) => { wake = resolve; timer = setTimeout(resolve, 1000); });
              wake = undefined;
            }
            return { status: 'killed', detail: '已停止观察，Codex 继续运行', result: '仅停止观察；没有取消任何 Codex 任务。' };
          })();
          return { done, cancel: () => { stopped = true; clearTimeout(timer); wake?.(); } };
        },
      });
      return { status: 'watching', background_job_id: id, mode, note: '无变化不通知；停止该后台观察不会取消 Codex。' };
    },
  });

  const runtime = registerRuntimeTool({ ctx, conductor, moduleUrl: import.meta.url, loadedIdentity,
    profileFile: cfg.runtimeProfileFile,
    loadedFile: stateDirectory ? path.join(stateDirectory, 'loaded.json') : '',
    activeDispatches: () => dispatching, dispatchGeneration: () => dispatchGeneration });
  registerPanel({ ctx, cfg, selftestDirectory: stateDirectory ?? '', conductor, runtime, plannerFile, plannerInjected, executorFile: cfg.executorPromptFile, geminiHistoryFile,
    history: () => history.snapshot(), handover: () => {
      const { sessions, threshold } = history.snapshot();
      return autoHandover.snapshot(sessions, threshold);
    }, autoAnswer,
    answerHandover: async (id, accept) => {
      const value = autoHandover.answer(id, accept);
      // 会话此刻正停着（没有回合在跑）就不等下一个回合边界，马上按自动交接的流程走。
      const agent = accept ? ctx.get?.('agents')?.get?.(id) : undefined;
      if (agent?.status === 'idle') await autoHandover.observe(agent, history.observe(agent));
      return value;
    } });

  const geminiText = (value) => {
    let summary = '';
    if (value.status === 'failed') {
      const reason = String(value.timeout_kind || value.error || value.last_event_type || value.status)
        .replace(/^gemini_write: /, '').replace(/\s+/g, ' ').slice(0, 160);
      summary = `Gemini 写作失败（${reason}），` + (!value.rolled_back
        ? `目标未确认回滚。下一步：${value.next}`
        : value.draft_path
          ? `目标已回滚；草稿已保留在 ${value.draft_path}。下一步：gemini_write(reuse_draft=${JSON.stringify(value.draft_path)}, output=..., sources=..., 同样的写作要求) 复用这份草稿重新校验落盘；不要改用别的工具把草稿当普通文件搬运。`
          : '目标已回滚；没有可复用草稿。下一步：处理 error 后，按同样的写作要求重新 gemini_write。');
    }
    return (summary ? `${summary}\n` : '') + JSON.stringify(value, null, 2);
  };
  if (cfg.gemini) ctx.tools.register({
    name: 'gemini_write',
    description: '把教程、文档正文交给本机官方 agy 的 Gemini 写入单个文件，一章一章做；源码改动和素材笔记用 codex_run。' +
      '插件读取并内联 sources，内容会发送给 Google；同目录有可写 Codex 任务运行或排队、或任务查询失败时拒绝。' +
      'max_chars 是正文硬上限，目标为上限的 80% 向下取整；首次超限自动压缩一次，两次调用共用 timeoutSeconds 预算，仍超限时请拆章。' +
      '正文增量或 write_file 事件后才启用 idleTimeoutSeconds，之后任意 stdout 字节续期；启动和思考阶段只受 timeoutSeconds 总上限约束。回执含 stdout_bytes/event_count/event_types/last_event_type/last_progress_s/timeout_kind，不记录事件正文。' +
      'reuse_draft 仅接受插件草稿目录内 .md，跳过 agy，沿用校验与回滚，超限直接拒绝；成功正文禁止规划端读取或搜索，交 Codex 核对。' +
      '返回 attempts 和每次正文字数 attempt_chars；最终 failed 时恢复目标原内容，原先不存在则删除目标。' +
      '可选 frontmatter 由插件校验、生成并去除模型重复块，不计入字数。结束后列出快照改动与范围外写入；completed 后仍需对照素材核对内容。',
    presentCall: (args) => ({ card: 'generic', kind: 'execute', title: `Gemini 写作 · ${args?.output ?? ''}` }),
    parameters: { type: 'object', properties: {
      prompt: { type: 'string', minLength: 10, description: '本章的写作要求，至少 10 个字符。' },
      sources: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' },
        description: '1–20 个已有素材文件，绝对路径或相对任务目录；总大小最多 1 MiB，由插件读取并内联。' },
      output: { type: 'string', description: '唯一目标文件，绝对路径或相对任务目录；必须在任务目录内且不能与素材相同。' },
      cwd: { type: 'string', description: '任务目录，解析规则同 codex_run；Windows 路径或 /mnt/<盘符>/...。' },
      model: { type: 'string', description: cfg.gemini.forceModel ? `配置已固定为 ${cfg.gemini.model}，传入值会被忽略。` : `默认 ${cfg.gemini.model}。` },
      effort: { type: 'string', enum: ['low', 'medium', 'high'], description: cfg.gemini.forceEffort ? `配置已固定为 ${cfg.gemini.effort || '模型名自带的档位'}，传入值会被忽略。`
        : `默认 ${cfg.gemini.effort || '不传，由模型名决定'}。` },
      max_chars: { type: 'integer', minimum: 1, description: '正文 Unicode 码点硬上限，含标题、Markdown 标记、标点、空白及换行；目标为 floor(上限 × 0.8)，首次超限自动压缩一次；传 frontmatter 时元数据不计数。' +
        (cfg.gemini.defaultMaxChars ? `不传时默认 ${cfg.gemini.defaultMaxChars}。` : '') },
      overwrite: { type: 'boolean', description: '目标已存在时必须显式传 true；默认不覆盖。' },
      background: { type: 'boolean', description: '默认后台：登记为 Harness 后台任务后立即返回 background_job_id，写完由完成通知或 job_output 送回同样的回执，期间可以继续规划。传 false 才前台等到写完再返回；没有后台任务服务或同目录正忙时也按前台执行。' },
      reuse_draft: { type: 'string', description: '失败回执的 draft_path：只接受插件 gemini-drafts 目录内 .md，与 output/sources 分开；跳过 agy，按本次参数重新校验、落盘，超 max_chars 直接拒绝，不自动压缩。' },
      frontmatter: { type: 'object', additionalProperties: false, required: ['title', 'tags'],
        description: '启用后由插件生成七字段 YAML；title 和至少一个非空 tags 必填，单值最多 200 个 Unicode 字符且禁止换行和控制字符；仅 tags/aliases 可用字符串数组，aliases 允许空数组；不传则保留原有正文处理。',
        properties: {
          created: { type: 'string', maxLength: 200, description: '缺省当前本地时间 YYYY-MM-DDTHH:MM。' },
          updated: { type: 'string', maxLength: 200, description: '缺省当前本地时间 YYYY-MM-DDTHH:MM。' },
          title: { type: 'string', minLength: 1, maxLength: 200, description: '必填的非空笔记标题。' },
          type: { type: 'string', enum: ['daily-note', 'project', 'topic', 'moc', 'resource', 'inbox', 'archive'], description: '缺省 resource。' },
          status: { type: 'string', enum: ['active', 'draft', 'review', 'done', 'archived'], description: '缺省 draft。' },
          tags: { anyOf: [{ type: 'string', minLength: 1, maxLength: 200 },
            { type: 'array', minItems: 1, items: { type: 'string', minLength: 1, maxLength: 200 } }], description: '必填，至少一个非空标签。' },
          aliases: { anyOf: [{ type: 'string', maxLength: 200 },
            { type: 'array', items: { type: 'string', maxLength: 200 } }], description: '缺省 []，允许空数组。' },
        } },
    }, required: ['prompt', 'sources', 'output'] },
    output: { schema: DATA_OUTPUT.schema, render: (_args, value) => [{ type: 'text', text: geminiText(value) }] },
    async execute(input, exec) {
      const { background, ...args } = input ?? {};
      const cwd = taskCwd(args, sessionCwd(exec), cfg.workspaces);
      const account = cfg.gemini.accountPool
        ? poolAccount(cfg.gemini.accountPool, cfg.gemini.forceModel ? cfg.gemini.model : args.model ?? cfg.gemini.model) : null;
      const gemini = account ? { ...cfg.gemini, home: account.dir, proxy: account.proxyUrl || cfg.gemini.proxy } : cfg.gemini;
      const key = normPath(cwd);
      const busy = geminiWrites.has(key) ? '同一任务目录的 gemini_write 尚未结束，请先等它结束'
        : [...startingWrites].some((writer) => writer.cwd === key) ? '同一任务目录的可写 Codex 任务正在启动，请先等它结束' : '';
      // 查询与启动之间也占住本实例的入口，避免规划端同时派入另一种写任务。
      if (!busy) geminiWrites.add(key);
      const owner = exec?.agent?.id;
      const write = (signal, extra = {}) => geminiWrite(gemini, { ...args, cwd,
        ...(args.max_chars === undefined && cfg.gemini.defaultMaxChars ? { max_chars: cfg.gemini.defaultMaxChars } : {}) }, conductor,
        { signal, stateDirectory: cfg.stateDir || undefined, busy,
          // products 模式下规划端不能读原料，也就不能把工作区外的文件当素材发给 Gemini。
          ...(restrictedReads(exec) && !cfg.roots.includes('*')
            ? { sourceRoots: [...cfg.roots, ...cfg.plannerReadAllow.map(normPath)] } : {}) }, launchGemini)
        .then((value) => {
          if (value.status === 'completed') productReads.addGemini(owner, [value.output]);
          recordGemini({ ...value, ...extra }, owner);
          return value;
        }).finally(() => { if (!busy) geminiWrites.delete(key); });
      // 默认后台：登记 DSH 后台任务后立即返回，写完由完成通知送回同样的回执；没有 jobs 服务或目录正忙时照常前台执行。
      const jobs = background !== false && !busy && owner ? ctx.get?.('jobs') : undefined;
      if (!jobs) return write(exec?.signal);
      const id = randomUUID().slice(0, 8);
      const stop = new AbortController();
      let backgroundId;
      let launched = false;
      try {
        backgroundId = jobs.start({ owner, kind: 'gemini', label: `Gemini ${id} · ${path.basename(String(args.output ?? ''))}`, outputLimitBytes: 65536,
          run: (handle) => ({
            done: (launched = true, write(stop.signal, { id, background: true })).then((value) => {
              const text = geminiText(value);
              handle.append(`${text}\n`, { channel: 'log' });
              return { status: value.status === 'completed' ? 'completed' : stop.signal.aborted ? 'killed' : 'failed',
                detail: `${value.status} · ${value.chars ?? '?'} 字 · ${Math.round(value.duration_s ?? 0)} s`, result: text };
            }, (error) => ({ status: 'failed', detail: 'gemini_write 出错', result: String(error?.message ?? error) })),
            cancel: () => stop.abort(),
          }) });
      } catch (error) {
        // 写作已经开始就不能再起一份；还没开始（run 没被调用）才退回前台执行。
        if (launched) throw error;
        ctx.logger?.warn?.(`[codex-conductor] gemini_write 后台登记失败，改为前台执行：${error?.message ?? error}`);
        return write(exec?.signal);
      }
      return { status: 'running', write_id: id, background_job_id: backgroundId, output: args.output,
        next: `已登记为后台任务 ${backgroundId}，Gemini 正在写作。留在本轮可用 job_output(${JSON.stringify({ job_id: backgroundId, wait: true })}) 等回执；` +
          '会话空闲时完成通知会唤醒会话。写完前不要对同一任务目录派可写的 codex_run 或再次 gemini_write；回执到手后按其中的 next 处理。' };
    },
  });

  // 宿主重开会清空内存任务表；只接回本会话已经登记、但未收到结算的 runner 作业。
  const recoverAgent = (agent) => { void recoverBackground(agent).catch((error) => {
    ctx.logger?.warn?.(`[codex-conductor] 无法接回后台任务：${error?.message ?? error}`);
  }); };
  ctx.on('agent/created', ({ agent }) => recoverAgent(agent));
  for (const agent of ctx.get?.('agents')?.list?.() ?? []) recoverAgent(agent);
  // 已交接出去的会话不再被任务通知唤醒，由后继会话查询这些任务。
  registerAutoWake({ ctx, enabled: cfg.autoWakeBlockedInbox, retired: (id) => Boolean(aliases.successor(id)) });
  // 会话回到空闲时按 autoHandover 判定是否提醒、询问或自动交接。
  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return;
    try { void autoHandover.observe(agent, history.observe(agent)).catch(() => {}); } catch {}
  });
  // 一跑几个小时不结束的回合等不到空闲：到了该自动交接的时候，在下一个模型步骤之前结束回合（宿主记为 blocked），
  // 会话转为空闲后由上面那个处理函数交接。带着新消息的步骤不拦：宿主拒绝时会丢掉这一步认领的消息。
  ctx.on('agent/pre-step', async (step, next) => {
    try {
      if (!step.messages?.length && autoHandover.due(step.agent, history.observe(step.agent))) {
        ctx.logger?.info?.(`[codex-conductor] 会话 ${step.agent.id} 的回合一直没有结束，已在第 ${step.step} 步之前结束它，转为空闲后自动交接。`);
        return { kind: 'reject' };
      }
    } catch {}
    return next();
  });
  // 交接出去的会话收到 Codex 任务结束通知时转给继任会话，前任这一回合不调用模型就结束。
  ctx.on('agent/pre-step', async (step, next) => {
    let forwarded;
    try {
      forwarded = await forwardRetiredNotices({ agent: step.agent, messages: step.messages, aliases, jobs: ctx.get?.('jobs'),
        resolve: async (id) => ctx.get?.('agents')?.get?.(id) ?? (await ctx.get?.('sessionController')?.resolveAgent?.(id))?.agent });
    } catch (error) { ctx.logger?.warn?.(`[codex-conductor] 转交任务通知失败：${error?.message ?? error}`); }
    if (forwarded) ctx.logger?.info?.(`[codex-conductor] 会话 ${step.agent?.id} 的 ${forwarded.forwarded} 条任务通知已转给 ${forwarded.successor}` +
      `${forwarded.delivered ? '' : '（继任会话不可用，未送达）'}。`);
    return forwarded?.reject ? { kind: 'reject' } : next();
  });

  // 防虚报：每个回合最多提醒一次，提醒会让这一回合继续，由它补调用或更正说法
  const nudged = new Set();
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    try { history.observe(agent); } catch {}
    try {
      if (!inWorkspace(agent?.session?.header?.cwd, cfg.roots) || liveBackground(undefined, { agent })) return;
      const key = `${agent.id}:${turn}`;
      if (nudged.has(key)) return;
      const { text, tools } = turnSummary(agent.session.log ?? [], turn);
      if (!DISPATCH_CLAIM.test(text) || tools.some((n) => ['codex_run', 'codex_verify', 'codex_continue', 'codex_status', 'codex_cancel'].includes(n))) return;
      if (nudged.size > 500) nudged.clear();
      nudged.add(key);
      agent.steer({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: NUDGE }], source: { kind: `plugin:${name}` } });
    } catch {}
  });

  const guardError = (exec, error) => inWorkspace(sessionCwd(exec), cfg.roots)
    ? cfg.plannerReads === 'products' ? `[codex-conductor] 护栏判定出错。${PRODUCT_DENY_HINT}`
      : `[codex-conductor] 护栏判定出错，已拒绝：${error?.message ?? error}` : undefined;
  const productReadLocation = (exec) => {
    const cwd = ctx.get?.('workingDirectory')?.get(exec.agent.session) ?? sessionCwd(exec);
    const location = ctx.get?.('sessionPersistence')?.locate?.(exec.agent.session.header);
    return [cwd, location?.kind === 'jsonl' && typeof location.path === 'string' ? [path.dirname(location.path)] : []];
  };
  // 已交接出去的会话收到用户消息时，在第一步之前附一条说明，免得规划端照常干活、到调用工具才被拒。
  // 每条用户消息只附一次；任何异常都放行原决定。
  const retiredNotified = new Set();
  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const decision = await next();
    try {
      if (decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return decision;
      const fresh = (messages ?? []).filter((m) => m?.source?.kind === 'user' && !retiredNotified.has(m.id));
      if (!fresh.length) return decision;
      const successor = aliases.successor(agent?.id);
      if (!successor) return decision;
      if (retiredNotified.size > 1000) retiredNotified.clear();
      for (const m of fresh) retiredNotified.add(m.id);
      const at = aliases.links()[successor]?.at;
      const text = `[codex-conductor] 本会话已于 ${at ?? '（时间未知）'} 交接给会话 ${successor}。这里的 Codex 派活、续接、核验、验收和取消工具都已停用，只能查看记录。` +
        `请直接告诉用户：到会话 ${successor} 继续这项工作，然后结束本回合，不要在这里继续推进。`;
      return { ...decision, messages: [...decision.messages, { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: `plugin:${name}` } }] };
    } catch {
      return decision;
    }
  });

  // tools/execute 在同步 guard 之后；所有受限调用执行前重查，未恢复的登记最多等 3 秒。
  ctx.on('tools/execute', async (exec, next) => {
    // 规划端用 update_goal(action=complete) 完成会话目标；与新派活同样的收尾条件下拒绝。用户在界面上完成目标不经过这里。
    // 已交接出去的会话只能读，不能再派活、验收或取消，避免两个会话同时处理同一批任务。
    if (['codex_run', 'codex_continue', 'codex_verify', 'codex_review', 'codex_cancel', 'gemini_write'].includes(exec.name)) {
      const successor = aliases.successor(exec.agent?.id);
      if (successor) {
        const message = `${exec.name}: 本会话已交接给 ${successor}，任务改由新会话处理；这里只能查看记录。` +
          `请告诉用户到会话 ${successor} 继续，本会话不要再派活或验收。`;
        return { isError: true, error: { message }, content: [{ type: 'text', text: `Error: ${message}` }] };
      }
    }
    let goal;
    const goalArgs = exec.name === 'update_goal' && goalArguments(exec.arguments);
    if (goalArgs?.action === 'complete') {
      goal = {};
      // 宿主冻结参数对象，但工具体在中间件之后从 exec 读取参数。
      const { acknowledge_open_items, ...nativeArgs } = goalArgs;
      if (Object.hasOwn(goalArgs, 'acknowledge_open_items')) {
        exec.arguments = typeof exec.arguments === 'string' ? JSON.stringify(nativeArgs) : nativeArgs;
      }
      const owner = exec.agent?.id;
      const parked = parkedGoalRefusal(owner);
      let refusal = parked || (usedConductor(exec.agent)
        ? await closeoutCheck(owner, 'update_goal', exec.signal, undefined, goal) : '');
      const ledger = parked ? undefined : await acceptedOpenLedger(owner, exec.signal);
      refusal = parked || parkedGoalRefusal(owner) || refusal;
      const items = ledger?.items;
      if (!refusal) {
        goal.ledgerUnreadable = ledger === null;
        if (items?.length) {
          const jobIds = ledgerJobIds(items);
          const listing = jobIds.map(id => `${id}（${[...new Set(items.filter(item => item.job_id === id).map(item => item.status))].join('、')}）`);
          const userConfirmed = cfg.plannerAnswers || hasUserReply(exec.agent.session?.log ?? [],
            { finished_at: Math.max(...items.map(item => item.at)) }, owner, cfg.autoResume.message);
          if (!userConfirmed || acknowledge_open_items !== true) {
            refusal = `update_goal: 本会话含前任仍有 ${items.length} 项未完成但接受的条目：${listing.join('、')}。` +
              (userConfirmed ? '' : '请先由用户确认这些未完成项，收到用户回复后再继续。') +
              '原任务的核验或后续轮次确认条目已满足时，用 codex_review 重记原任务即可销项；否则请在 update_goal(action=complete) 中传 acknowledge_open_items: true。';
          } else {
            goal.completion = { session: owner, open_count: items.length, job_ids: jobIds,
              acknowledged_by: cfg.plannerAnswers ? 'planner' : 'user' };
          }
        }
      }
      if (refusal) {
        refusal = [refusal, laterRoundHint(items ?? [])].filter(Boolean).join('\n');
        return { isError: true, error: { message: refusal }, content: [{ type: 'text', text: `Error: ${refusal}` }] };
      }
    }
    if (inWorkspace(sessionCwd(exec), cfg.roots)) {
      let denied;
      try { denied = await productReads.check(exec, ...productReadLocation(exec)); }
      catch (error) { denied = guardError(exec, error); }
      if (goal && denied === undefined) denied = parkedGoalRefusal(exec.agent?.id) || undefined;
      if (denied !== undefined) return { isError: true, error: { message: denied },
        content: [{ type: 'text', text: `Error: ${denied}` }] };
    }
    if ((parkedFile || cfg.autoVerify !== 'off') && exec.name?.startsWith('codex_')) {
      // 先让验收或续接落盘，补派时才能看到这次调用的结果。
      const execute = next;
      next = async () => {
        // 补派不占这次工具调用的返回时间。
        try { return await execute(); }
        finally { void catchUpAutoVerifications(exec.agent?.id); }
      };
    }
    // codex_runtime 给操作员看本会话的历史长度和是否建议交接。
    if (exec.name === 'codex_runtime') {
      const result = await next();
      const value = history.observe(exec.agent);
      if (result.isError || !value) return result;
      const [ledger, repeat] = await Promise.all([acceptedOpenLedger(exec.agent?.id, exec.signal), conductor.repeatGuard(undefined, exec.signal)]);
      const decisions = sessionOwnerDecisions(exec.agent?.id);
      let acceptance;
      try { acceptance = acceptanceStatsFile && JSON.parse(readFileSync(acceptanceStatsFile, 'utf8')); } catch {}
      let closeouts;
      try { closeouts = closeoutStatsFile && JSON.parse(readFileSync(closeoutStatsFile, 'utf8')); } catch {}
      const mineCloseouts = closeouts?.sessions?.[exec.agent?.id] ?? {};
      const repeatLine = repeat?.status === 'completed' && repeat.totals
        ? `\n重复失败拦截：本会话 ${mineCloseouts.repeat_blocked ?? 0} 次 / 全部 ${repeat.totals.blocked} 次，估计少花 ${minutes(repeat.totals.seconds_avoided)} 分钟（runner 统计）`
        : '';
      const parked = exec.agent?.id ? parkedFor(exec.agent.id).length : 0;
      const closeoutLine = closeouts ? `结案验收（自 ${closeouts.since} 起，本会话 / 全部）：全部满足 ${mineCloseouts.all_met ?? 0} / ${closeouts.total.all_met ?? 0}，` +
        `未满足但接受 ${mineCloseouts.accepted_open ?? 0} / ${closeouts.total.accepted_open ?? 0}（其中按 evidence 推定接受原因 ${mineCloseouts.accepted_inferred ?? 0} / ${closeouts.total.accepted_inferred ?? 0}），` +
        `缺独立依据被拒 ${mineCloseouts.rejected_unsupported ?? 0} / ${closeouts.total.rejected_unsupported ?? 0}，` +
        `接受未完成项缺依据被拒 ${mineCloseouts.rejected_open_unsupported ?? 0} / ${closeouts.total.rejected_open_unsupported ?? 0}，` +
        `自标未满足按 planner 级别记 met ${mineCloseouts.met_planner_level ?? 0} / ${closeouts.total.met_planner_level ?? 0}；` +
        `由后续轮次销项 ${mineCloseouts.ledger_cleared_by_later_round ?? 0} / ${closeouts.total.ledger_cleared_by_later_round ?? 0}；` +
        `核验中放行新任务 ${mineCloseouts.deferred_dispatch ?? 0} / ${closeouts.total.deferred_dispatch ?? 0}；` +
        `自动核验派出 ${mineCloseouts.auto_verify_started ?? 0} / ${closeouts.total.auto_verify_started ?? 0}，` +
        `其中补派 ${mineCloseouts.auto_verify_catchup ?? 0} / ${closeouts.total.auto_verify_catchup ?? 0}，` +
        `跳过 ${mineCloseouts.auto_verify_skipped ?? 0} / ${closeouts.total.auto_verify_skipped ?? 0}；` +
        `派单前提醒 ${mineCloseouts.predispatch_warnings ?? 0} / ${closeouts.total.predispatch_warnings ?? 0}，` +
        `预标受阻 ${mineCloseouts.expect_blocked_items ?? 0} / ${closeouts.total.expect_blocked_items ?? 0}；` +
        `closeoutEvidence=${cfg.closeoutEvidence}，acceptOpenEvidence=${cfg.acceptOpenEvidence}`
        : `结案验收：尚无记录；closeoutEvidence=${cfg.closeoutEvidence}，acceptOpenEvidence=${cfg.acceptOpenEvidence}`;
      const line = `本会话消息数 ${value.messages}（建议交接阈值 ${value.threshold || '已关闭'}）` +
        (value.suggest ? '：建议由操作员交接到新会话。' : '') +
        (acceptance?.dispatches ? `\n新派活验收标准：${acceptance.dispatches} 单，平均 ${(acceptance.items / acceptance.dispatches).toFixed(1)} 条，` +
          `${acceptance.over} 单超过提醒阈值（自 ${acceptance.since} 起）` : '') + `\n${closeoutLine}${repeatLine}\n挂起复核（本会话含前任）：${parked} 单\n${ownerDecisionLine(decisions)}\n${ledgerLine(ledger)}`;
      return { ...result, ...(result.value && typeof result.value === 'object'
        ? { value: { ...result.value, session_history: value, accepted_open_ledger: ledger, owner_decisions: decisions, parked_reviews: parked, ...(acceptance ? { acceptance_stats: acceptance } : {}),
          ...(closeouts ? { closeout_stats: closeouts } : {}) } } : {}),
        content: [...(result.content ?? []), { type: 'text', text: line }] };
    }
    if (goal?.unreviewedWrites?.length || goal?.completion || goal?.ledgerUnreadable) {
      const result = await next();
      if (result.isError) return result;
      const content = [...(result.content ?? [])];
      if (goal.unreviewedWrites?.length) content.push({ type: 'text',
        text: `以下写入任务报告无异常，尚未经过 codex_review：${goal.unreviewedWrites.join('、')}。` });
      if (goal.completion) {
        const ledger = readLedger();
        if (ledger) {
          ledger.completions.push({ ...goal.completion, at: Date.now() / 1000 });
          // 目标已经完成，记录写失败只提示，不把完成改报成错误。
          try { saveLedger(ledger); } catch (error) { ctx.logger?.warn?.(`[codex-conductor] 未能记录以未完成项完成目标：${error?.message ?? error}`); }
          content.push({ type: 'text', text: `目标以 ${goal.completion.open_count} 项未完成项完成：${goal.completion.job_ids.join('、')}` });
        } else {
          goal.ledgerUnreadable = true;
        }
      }
      if (goal.ledgerUnreadable) content.push({ type: 'text', text: `${unreadableLedgerLine}，未核对未完成项` });
      return { ...result, content };
    }
    if (exec.name === 'ask_user_question') {
      const result = await next();
      if (result && !result.isError) observeOwnerQuestion(exec);
      return result;
    }
    // 先执行原生 job_output，保留 ownership、消费与实时状态语义，再缩短回执。
    if (exec.name !== 'job_output' || exec.arguments?.wait === true || !exec.agent?.id) return next();
    const result = await next();
    if (result.isError) return result;
    const value = result.value;
    const job = value?.job;
    if (!job || typeof value.text !== 'string') return result;
    const owned = ctx.get?.('jobs')?.list(exec.agent.id).find((item) => item.id === job.id && item.owner === exec.agent.id &&
      item.kind === 'codex' && /^Codex [^\s·]+(?: · |$)/.test(item.label ?? ''));
    if (!owned) return result;
    const runnerId = /^Codex ([^\s·]+)/.exec(owned.label)[1];
    const short = dampenStatus({ job_id: runnerId, status: job.status, last_activity: job.detail,
      output: value.text, background_job_id: job.id }, exec, 'job_output');
    if (!short) return result;
    return { ...result, value: { ...value, text: short.rendered, job: { ...job, detail: '状态无实质变化' } },
      content: [{ type: 'text', text: short.rendered }] };
  });

  if (cfg.roots.length) {
    ctx.tools.guard((exec) => {
      try {
        const denied = decide(exec, cfg);
        if (denied || !inWorkspace(sessionCwd(exec), cfg.roots)) return denied;
        // 记下白名单模式下不会放行的工具名，面板据此提示切换前要补进 allowTools 的名字。
        if (cfg.seenTools.size < 200 && typeof exec?.name === 'string' && !knownTool(exec.name, cfg)) cfg.seenTools.add(exec.name);
        // null 是内部延后判定；上面的中间件必须判定通过后才调用 next()。
        return productReads.checkSync(exec, ...productReadLocation(exec)) ?? undefined;
      } catch (error) {
        return guardError(exec, error);
      }
    });
  }
  ctx.logger?.info?.(`[codex-conductor] active v${loadedIdentity.version ?? '?'}；护栏工作区 ${cfg.roots.join(', ') || '(未配置)'}`);
  // 桌面宿主日志不落盘，留一个加载标记，便于确认插件是否在运行中的 DSH 里生效
  // 没有 LOCALAPPDATA（Linux 上跑测试）时不写，免得落到当前目录
  let previousLoad;
  if (stateDirectory) try {
    const dir = stateDirectory;
    mkdirSync(dir, { recursive: true });
    const loadedFile = path.join(dir, 'loaded.json');
    const { record } = loadedRecord(loadedFile);
    if (record) previousLoad = { pid: record.pid, at: Date.parse(record.loadedAt) };
    if (!record || record.pid === process.pid || pidReused(record.pid, record.loadedAt)) writeFileSync(loadedFile,
      JSON.stringify({ ...loadedIdentity, loadedAt: new Date().toISOString(), pid: process.pid, module: import.meta.url, workspaces: cfg.roots,
        ...(cfg.unknownConfig.length ? { unknownConfig: cfg.unknownConfig } : {}),
        tools: ['codex_run', 'codex_verify', 'codex_status', 'codex_cancel', 'codex_jobs', 'codex_output', 'codex_continue', 'codex_review', 'codex_summary', 'codex_watch', 'codex_runtime',
          ...(cfg.gemini ? ['gemini_write'] : [])],
        allowHostAccess: cfg.allowHostAccess === true, defaultHostAccess: cfg.defaultHostAccess === true,
        plannerAnswers: cfg.plannerAnswers === true,
        ownerDecisions: cfg.ownerDecisions,
        autoWakeBlockedInbox: cfg.autoWakeBlockedInbox,
        autoResume: { enabled: cfg.autoResume.enabled, maxAgeHours: cfg.autoResume.maxAgeHours, excludeCount: cfg.autoResume.exclude.length,
          delaySeconds: cfg.autoResume.delaySeconds, reloadDelaySeconds: cfg.autoResume.reloadDelaySeconds },
        autoHandover: cfg.autoHandover,
        autoAnswer: { enabled: cfg.autoAnswer.enabled, afterMinutes: cfg.autoAnswer.afterMinutes, subagents: cfg.autoAnswer.subagents,
          excludeCount: cfg.autoAnswer.excludeSessions.length, riskyPatternEnabled: cfg.autoAnswer.riskyPattern !== '',
          customFreeText: cfg.autoAnswer.freeText !== AUTO_ANSWER_DEFAULTS.freeText },
        plannerReads: cfg.plannerReads, plannerReadAllowCount: cfg.plannerReadAllow.length,
        toolPolicy: cfg.toolPolicy, mcpWriteAllow: cfg.mcpWriteAllow, jobDiff: cfg.jobDiff !== false, closeoutGuard: cfg.closeoutGuard !== false,
        serviceTier: cfg.serviceTier || null, ...loadedGateway(cfg),
        plannerPromptFile: plannerFile, plannerPromptInjected: plannerInjected, executorPromptFile: cfg.executorPromptFile }, null, 1));
  } catch {}
  // 每 2 秒把排队或进行中的交接写进 handover-pending.json（只在变化时写），看门狗据此不去打扰这些会话。
  if (stateDirectory) ctx.effect?.(() => {
    let last;
    const timer = setInterval(() => {
      try {
        const sessions = handoverPendingSessions(stateDirectory);
        const key = sessions.join(',');
        if (key === last) return;
        mkdirSync(stateDirectory, { recursive: true });
        writeJsonAtomic(path.join(stateDirectory, 'handover-pending.json'), { updatedAt: new Date().toISOString(), sessions });
        last = key;
      } catch {}
    }, 2_000);
    timer.unref?.();
    return () => clearInterval(timer);
  });
  if (stateDirectory) ctx.inject?.(['agents', 'sessionController', 'sessionQuery', 'sessionPersistence', 'goals', 'appReady'], (resumeCtx) => {
    registerResumeRequests({ ctx: resumeCtx, directory: stateDirectory, autoResume: cfg.autoResume, pluginFiber: ctx.fiber, previousLoad,
      // 自动兜底和热重载续接都跳过已交接和已归档的会话。
      retired: (id) => Boolean(aliases.successor(id)),
      archived: (id) => Boolean(ctx.get?.('workspaceRegistry')?.archivedSessionIds?.includes?.(id)) });
    registerHandoverRequests({ ctx: resumeCtx, directory: stateDirectory, aliases, since: closeoutFrom,
      sessionJobs: (owner) => sessionJobs(owner), pendingOf: (jobs) => pendingCloseout(jobs, closeoutFrom, reworkFrom),
      disableAutoContinue: cfg.autoHandover.disableAutoContinue,
      // 交接时通过宿主设置服务关掉旧会话在 dsh-client-auto-continue 里的自动继续；没装该插件时什么都不做。
      autoContinue: (id) => autoContinueFromSettings(ctx.get?.('settings'), outsideHmr(ctx.get?.('hmr')))(id),
      // 交接单里“最近的用户指令”排除重启续接的固定话术；有 session_read 工具时写上回看旧会话的用法。
      autoMessage: cfg.autoResume.message, sessionRead: () => Boolean(ctx.tools?.get?.('session_read')),
      workspaces, onResult: (result) => autoHandover.settled(result), withRunningJobs: cfg.autoHandover.withRunningJobs,
      // 绑着 LoopX 线程的会话：交接时把绑定挪给继任会话。每次交接都先查绑定；没装 loopx 时调用失败，交接照常。
      loopx: (args, cwd) => new Promise((resolve, reject) => {
        execFile(process.env.LOOPX_BIN || 'loopx', ['--registry', '.loopx/registry.json', '--format', 'json', ...args],
          { cwd, timeout: 30_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
            if (error) return reject(new Error(`loopx ${args[0]}: ${error.code ?? error.message}`));
            try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`loopx ${args[0]}: unreadable output`)); }
          });
      }) });
  });
  // 旧版本交接出的继任会话落在“未分组”、标题是固定的交接标题：工作区服务可用后对每条现存链接修复一次。
  if (stateDirectory) ctx.inject?.(['workspaceRegistry', 'sessionController'], (repairCtx) => {
    void repairLinks({ registry: repairCtx.get('workspaceRegistry'), controller: repairCtx.get('sessionController'), aliases,
      directory: stateDirectory, logger: ctx.logger }).catch((error) => ctx.logger?.warn?.(`[codex-conductor] 旧交接修复失败：${error?.message ?? error}`));
  });
  if (parkedFile || cfg.autoVerify !== 'off') void Promise.resolve().then(() => Promise.all([
    scanParkedReviews().catch(parkedWarning), cfg.autoVerify !== 'off' && scanAutoVerifications(2).catch(autoVerifyWarning),
  ]));
}
