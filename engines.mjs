export const ENGINE_GUIDANCE = 'Codex 适合常规工程执行和原 Codex 线程续接。Gemini 使用 Windows Antigravity，适合已授权的 Windows 工程任务和独立交叉核验；需配置 gemini.command。';
export const ENGINE_PARAMETER = { type: 'string', enum: ['codex', 'gemini'], description: ENGINE_GUIDANCE };

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

export function geminiArgv(args, cfg) {
  if (!cfg.gemini?.command) throw new Error('Gemini 执行需要在插件中配置 gemini.command');
  const effort = args.effort ?? cfg.gemini.effort ?? 'high';
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error('Gemini effort 必须是 low、medium、high、xhigh 或 max');
  return ['--engine', 'gemini', '--agy-command', cfg.gemini.command, '--effort', effort,
    '--model', args.model || cfg.gemini.executionModel || cfg.gemini.model || 'gemini-4-carbon',
    ...(cfg.gemini.proxy ? ['--agy-proxy', cfg.gemini.proxy] : []),
    ...(cfg.maxGeminiRunningJobs == null ? [] : ['--max-engine-running', String(cfg.maxGeminiRunningJobs)])];
}
