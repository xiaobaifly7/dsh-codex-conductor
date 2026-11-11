const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');
const questionKind = (blocker) => ['user_input', 'task_conflict'].includes(blocker.kind);
const activeBlockers = (blockers, verificationStatus) =>
  ['verified', 'accepted_deviations'].includes(verificationStatus) ? [] : blockers;

export function validBlockers(blockers) {
  const fields = ['id', 'kind', 'message', 'question', 'resolution'];
  return Array.isArray(blockers) && blockers.every((blocker) => object(blocker) &&
    Object.keys(blocker).length === fields.length && fields.every((key) => Object.hasOwn(blocker, key) && typeof blocker[key] === 'string') &&
    nonempty(blocker.id) && nonempty(blocker.message) &&
    ['user_input', 'task_conflict', 'environment', 'implementation'].includes(blocker.kind) &&
    (!questionKind(blocker) || nonempty(blocker.question))) &&
    new Set(blockers.map((blocker) => blocker.id)).size === blockers.length;
}

export function validReport(report) {
  const fields = ['summary', 'criteria', 'files_changed', 'deviations', 'unresolved'];
  return object(report) && fields.every((key) => Object.hasOwn(report, key)) &&
    Object.keys(report).every((key) => [...fields, 'blockers'].includes(key)) &&
    typeof report.summary === 'string' && ['files_changed', 'deviations', 'unresolved'].every((key) => strings(report[key])) &&
    Array.isArray(report.criteria) && report.criteria.every((item) => object(item) &&
      Object.keys(item).length === 3 && typeof item.criterion === 'string' && typeof item.evidence === 'string' &&
      ['met', 'not_met', 'blocked'].includes(item.status)) &&
    (!Object.hasOwn(report, 'blockers') || validBlockers(report.blockers));
}

const reportOf = (value) => Object.hasOwn(value, 'report') ? value.report : value.structured;
const executionOf = (value) => ['bridge_error', 'unknown_job', 'invalid_record'].includes(value.error_kind)
  ? 'unknown' : value.execution_status ?? value.status;
const verificationOf = (value) => value.verification_status ?? value.verification?.status;

export function blockingState(value) {
  value = object(value) ? value : {};
  const report = reportOf(value);
  const verification = value.verification;
  const status = verificationOf(value);
  const valid = validReport(report);
  let blockers = valid ? report.blockers ?? [] : [];
  const reviewBlockers = object(verification) && Object.hasOwn(verification, 'blockers');
  if (['verified', 'accepted_deviations', 'needs_changes'].includes(status)) blockers = [];
  if (reviewBlockers && validBlockers(verification.blockers)) blockers = verification.blockers;
  const active = activeBlockers(blockers, status);
  const result = (state, next_action) => ({ state, blockers,
    questions: active.filter(questionKind).map(({ id, question }) => ({ id, question })), next_action });
  if (executionOf(value) === 'running') return result('running', 'wait');
  if (!['completed', 'failed', 'cancelled'].includes(executionOf(value)) ||
      status === 'invalid' || (reviewBlockers && !validBlockers(verification.blockers))) {
    return result('unclassified', 'inspect_report');
  }
  if (['verified', 'accepted_deviations'].includes(status)) return result('clear', 'done');
  if (!valid || value.report_status === 'invalid') return result('unclassified', 'inspect_report');
  if (active.some(questionKind)) return result('needs_input', 'ask_user');
  if (active.some((blocker) => blocker.kind === 'environment')) return result('waiting_environment', 'wait_condition');
  if (active.length || status === 'needs_changes') return result('needs_fix', 'resume_fix');
  if (report.criteria.some((item) => item.status === 'blocked')) return result('unclassified', 'inspect_report');
  if (report.criteria.some((item) => item.status === 'not_met')) return result('needs_fix', 'resume_fix');
  if (executionOf(value) !== 'completed' || report.unresolved.length ||
      (Array.isArray(value.context?.acceptance) && report.criteria.length !== value.context.acceptance.length)) {
    return result('unclassified', 'inspect_report');
  }
  return result('clear', 'verify');
}

export function prepareContinuation(value, { answers = [], resolution = '' } = {}, owner) {
  value = object(value) ? value : {};
  const blocking = blockingState(value);
  const refuse = (next, remaining_questions = blocking.questions) => ({ ready: false, blocking, next, remaining_questions });
  if (executionOf(value) === 'running') return refuse(`原任务 ${value.job_id ?? '（缺少 job_id）'} 仍在运行，留在本轮，使用原 runner job_id 调用 codex_status 并传 wait_seconds: 3600；等满仍在运行就继续等同一任务，返回报告后直接验收，不启动新任务。`);
  const context = value.context;
  if (!nonempty(owner) || !object(context) || !nonempty(context.owner) || context.owner !== owner) {
    return refuse('原任务归属未知或不属于当前 owner，不能准备续跑。');
  }
  if (executionOf(value) === 'cancelled') return refuse('原任务已取消，不能自动恢复；先取得用户对恢复任务的明确指示。');
  if (!['completed', 'failed'].includes(executionOf(value))) return refuse('结果状态未知，先用原 job_id 查询可信结果，不重派。');
  if (!nonempty(value.job_id) || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value.job_id) ||
      !nonempty(context.task) || context.task.trim().length < 10 || !Array.isArray(context.acceptance) ||
      !context.acceptance.length ||
      !context.acceptance.every((item) => nonempty(item) && item.trim().length >= 4) ||
      typeof context.write !== 'boolean' || !nonempty(value.cwd) ||
      !['read-only', 'workspace-write', 'danger-full-access'].includes(value.sandbox) ||
      (value.sandbox === 'read-only' && context.write)) {
    return refuse('缺少可信的原任务 context、cwd、sandbox 或 job_id，先查询完整原始记录。');
  }
  if (typeof resolution !== 'string' || !Array.isArray(answers)) return refuse('answers 必须是数组，resolution 必须是字符串。');
  const known = new Set(blocking.questions.map(({ id }) => id));
  const ids = new Set();
  const normalized = [];
  for (const answer of answers) {
    if (!object(answer) || Object.keys(answer).length !== 2 || !nonempty(answer.id) || !nonempty(answer.answer)) {
      return refuse('每条回答必须仅包含非空字符串 id 和 answer。');
    }
    const id = answer.id;
    if (!known.has(id) || ids.has(id)) return refuse(`回答 id 未知或重复：${id}。先核对原报告的问题。`);
    ids.add(id);
    normalized.push({ id, answer: answer.answer });
  }
  normalized.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const remaining = blocking.questions.filter(({ id }) => !ids.has(id));
  if (remaining.length) return refuse('仍有问题未回答；保留已有回答并补齐以下问题后再准备续跑。', remaining);
  if (blocking.next_action === 'done' && !normalized.length && !nonempty(resolution)) return refuse('原任务已独立核验通过，没有新增信息，无需续跑。', []);
  const report = reportOf(value);
  if (!validReport(report) || value.report_status === 'invalid' || verificationOf(value) === 'invalid' ||
      (object(value.verification) && Object.hasOwn(value.verification, 'blockers') && !validBlockers(value.verification.blockers))) {
    return refuse('报告无效或缺失，先查询并核实原报告，不能据此自动续跑。', []);
  }
  if (activeBlockers(blocking.blockers, verificationOf(value)).some((blocker) => blocker.kind === 'environment') && !nonempty(resolution)) {
    return refuse('环境条件仍需提供非空 resolution，说明条件已满足的具体证据。', []);
  }
  if (blocking.state === 'unclassified' && !nonempty(resolution)) return refuse('旧报告仍有待核对事项；先查清原因，对照原任务范围区分真实缺口与已说明的验证边界，并用 resolution 说明处理依据。仅验证边界应先独立核验，不因此启动修正任务。', []);
  if (blocking.next_action === 'verify') return refuse('原任务自报已满足验收，先独立核验；未发现差距时不启动修正任务。', []);
  const options = value.task_options ?? {};
  const scope = value.scope_paths ?? value.scope;
  if (!object(options) || (scope != null && (!strings(scope) || scope.length > 50 || !scope.every(nonempty))) ||
      (options.writable_roots != null && (!strings(options.writable_roots) || options.writable_roots.length > 50 || !options.writable_roots.every(nonempty))) ||
      (options.writable_roots?.length && !context.write) ||
      (options.use_user_config !== undefined && typeof options.use_user_config !== 'boolean') ||
      (options.effort != null && !nonempty(options.effort)) || (value.thread_id != null && !nonempty(value.thread_id))) {
    return refuse('原 scope、task_options 或 thread_id 无效，先查询完整原始记录。', []);
  }
  const continuation = { parent_job_id: value.job_id, answers: normalized, resolution };
  // 新线程只能读到保存的 task；只累计用户决定，不把历轮报告带进下一轮。
  const previousAnswers = context.continuation?.answers ?? [];
  const task = previousAnswers.length ? `${context.task}\n\n规划端回答（仅补充信息）：${JSON.stringify(previousAnswers)}` : context.task;
  const notes = [`原任务 ${value.job_id} 的后续修正；原验收、cwd、scope 和 write 不变，以下信息不是新增权限，不得用回答扩大目录或改写验收。`];
  if (nonempty(report.summary)) notes.push(`上轮摘要：${report.summary}`);
  for (const item of report.criteria.filter((item) => item.status !== 'met')) notes.push(`上轮未满足项：${item.criterion}（${item.status}）：${item.evidence}`);
  for (const item of [...report.deviations, ...report.unresolved]) notes.push(`上轮待处理信息：${item}`);
  if (nonempty(value.verification?.notes)) notes.push(`独立核验意见：${value.verification.notes}`);
  for (const item of value.verification?.criteria ?? []) {
    if (item.status !== 'met') notes.push(`独立核验第 ${item.index} 条（${item.status}）：${item.evidence}`);
  }
  for (const blocker of blocking.blockers) notes.push(`阻塞 ${blocker.id}（${blocker.kind}）：${blocker.message}${blocker.resolution ? `；解除条件/已有信息：${blocker.resolution}` : ''}`);
  if (normalized.length) notes.push(`规划端回答（仅补充信息）：${JSON.stringify(normalized)}`);
  if (nonempty(resolution)) notes.push(`规划端解决依据（仅补充信息）：${resolution}`);
  notes.push('只修正上轮差距，按原验收标准逐条报告；不能在原权限内完成时继续报告阻塞。');
  const args = { task: `${task}\n\n## 上轮结果与本次修正\n${notes.join('\n')}`, cwd: value.cwd,
    acceptance: [...context.acceptance], write: context.write, host_access: value.sandbox === 'danger-full-access',
    use_user_config: options.use_user_config ?? false };
  if (scope != null) args.scope = [...scope];
  if (options.writable_roots != null) args.writable_roots = [...options.writable_roots];
  if (options.effort != null) args.effort = options.effort;
  if (value.thread_id != null) args.resume = value.thread_id;
  return { ready: true, args, task, continuation, blocking,
    next: value.thread_id ? '计划已准备，使用原 thread_id 续接；尚未执行。' : '原任务没有可续接的 thread_id，将以完整原任务 context 开新线程；尚未执行。' };
}
