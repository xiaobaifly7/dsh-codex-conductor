import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validBlockers, blockingState, prepareContinuation } from './workflow.mjs';

const blocker = (id, kind, extra = {}) => ({ id, kind, message: `处理 ${id}`,
  question: ['user_input', 'task_conflict'].includes(kind) ? `请决定 ${id}` : '', resolution: '', ...extra });
function job(blockers = [], status = 'blocked') {
  return { job_id: 'job-123', status: 'completed', cwd: '/work/project', sandbox: 'workspace-write', thread_id: 'thread-original',
    scope: ['src'], scope_paths: ['/work/project/src'],
    context: { owner: 'owner-a', task: '修复项目中的 CSV 解析错误并保留现有数据', acceptance: ['CSV 解析测试通过'], write: true },
    task_options: { writable_roots: ['/work/cache'], use_user_config: true, effort: 'high' },
    report: { summary: 'CSV 路径已检查，等待后续处理', criteria: [{ criterion: 'CSV 解析测试通过', status, evidence: 'node --test 显示一项待处理' }],
      files_changed: [], deviations: [], unresolved: [], blockers } };
}
const plan = (value, input = {}, owner = 'owner-a') => prepareContinuation(value, input, owner);

test('blocker validation enforces exact fields, kinds, unique IDs and required questions', () => {
  assert.equal(validBlockers([]), true);
  const item = blocker('choose', 'user_input');
  assert.equal(validBlockers([item, blocker('fix', 'implementation')]), true);
  for (const value of [null, {}, 'x', [null], [{ ...item, extra: '' }], [{ ...item, id: ' ' }],
    [{ ...item, message: '' }], [{ ...item, kind: 'network' }], [{ ...item, resolution: null }],
    [{ ...item, question: ' ' }], [item, { ...item }]]) assert.equal(validBlockers(value), false);
  const missing = { ...item };
  delete missing.resolution;
  assert.equal(validBlockers([missing]), false);
  assert.equal(validBlockers([blocker('conflict', 'task_conflict', { question: '' })]), false);
});

test('blocking priority keeps all blockers and does not mutate the raw report', () => {
  const value = job([blocker('fix', 'implementation'), blocker('network', 'environment'), blocker('choose', 'user_input')]);
  const original = structuredClone(value);
  assert.deepEqual(blockingState(value), { state: 'needs_input', blockers: value.report.blockers,
    questions: [{ id: 'choose', question: '请决定 choose' }], next_action: 'ask_user' });
  value.report.blockers.pop();
  assert.equal(blockingState(value).state, 'waiting_environment');
  value.report.blockers.pop();
  assert.equal(blockingState(value).state, 'needs_fix');
  assert.deepEqual(value.context, original.context);
  assert.deepEqual(value.report.criteria, original.report.criteria);
  assert.equal(value.status, 'completed');
});

test('running always waits, even when a previous report or review is present', () => {
  const value = { ...job(), execution_status: 'running', verification_status: 'verified' };
  assert.equal(blockingState(value).next_action, 'wait');
  const result = plan(value);
  assert.equal(result.ready, false);
  assert.match(result.next, /job-123.*codex_status/);
  assert.equal(result.args, undefined);
});

test('not_met is repairable; unclassified historical blocked text is never guessed', () => {
  const value = job([], 'blocked');
  delete value.report.blockers;
  value.report.criteria[0].evidence = 'pwsh.exe network user permission environment';
  assert.equal(blockingState(value).state, 'unclassified');
  assert.equal(plan(value).ready, false);
  assert.match(plan(value).next, /先查清原因/);
  const prepared = plan(value, { resolution: '已核查：这是实现中的路径错误，按原验收修复。' });
  assert.equal(prepared.ready, true);
  assert.equal(prepared.args.host_access, false);
  value.report.criteria[0].status = 'not_met';
  assert.equal(blockingState(value).state, 'needs_fix');
  assert.equal(plan(value).ready, true);
});

test('all-met reports require independent verification and registered closure finishes the workflow', () => {
  const value = job([], 'met');
  assert.equal(blockingState(value).next_action, 'verify');
  assert.equal(plan(value).ready, false);
  for (const status of ['verified', 'accepted_deviations']) {
    const reviewed = { ...value, verification_status: status, verification: { status, criteria: [], notes: '已核验' } };
    assert.equal(blockingState(reviewed).next_action, 'done');
    assert.equal(plan(reviewed).ready, false);
    assert.match(plan(reviewed).next, /已独立核验通过/);
    assert.equal(plan(reviewed, { resolution: '补充的复现证据已提交，请按原验收再次核实。' }).ready, true);
  }
});

test('needs_changes uses independent verification blockers and evidence rather than stale self-report', () => {
  const value = job([blocker('old', 'user_input')]);
  value.verification = { status: 'needs_changes', blockers: [], notes: 'CSV 空字段仍解析错误',
    criteria: [{ index: 1, status: 'not_met', evidence: '输入 a,,c 得到两列，应为三列' }] };
  assert.equal(blockingState(value).state, 'needs_fix');
  const result = plan(value);
  assert.equal(result.ready, true);
  assert.match(result.args.task, /CSV 空字段仍解析错误/);
  assert.match(result.args.task, /输入 a,,c/);
  value.verification.blockers = [blocker('api', 'environment')];
  assert.equal(blockingState(value).state, 'waiting_environment');
  assert.equal(plan(value).ready, false);
});

test('registered reviews supersede old questions even when they omit blockers', () => {
  const value = job([blocker('stale', 'user_input')]);
  value.verification = { status: 'verified', criteria: [], notes: '已独立解决并核验' };
  assert.equal(blockingState(value).next_action, 'done');
  assert.deepEqual(blockingState(value).questions, []);
  assert.match(plan(value).next, /已独立核验通过/);
  value.verification.status = 'needs_changes';
  assert.equal(blockingState(value).state, 'needs_fix');
  assert.deepEqual(blockingState(value).questions, []);
  assert.equal(plan(value).ready, true);
});

test('partial answers retain the actual remaining questions; unknown, duplicate and empty answers are rejected', () => {
  const value = job([blocker('b', 'user_input'), blocker('a', 'task_conflict')]);
  const partial = plan(value, { answers: [{ id: 'b', answer: '使用现有 CSV 格式' }] });
  assert.equal(partial.ready, false);
  assert.deepEqual(partial.remaining_questions, [{ id: 'a', question: '请决定 a' }]);
  assert.equal(partial.continuation, undefined);
  for (const answers of [[{ id: 'unknown', answer: 'ok' }], [{ id: 'a', answer: '' }],
    [{ id: 'a', answer: 'ok' }, { id: 'a', answer: 'again' }], [{ id: 'a', answer: 'ok', write: true }], null]) {
    assert.equal(plan(value, { answers }).ready, false);
  }
  const answers = [{ id: 'b', answer: ' 保留旧格式 ' }, { id: 'a', answer: '按原验收处理' }];
  const result = plan(value, { answers });
  assert.equal(result.ready, true);
  assert.deepEqual(result.continuation, { parent_job_id: 'job-123', answers: [
    { id: 'a', answer: '按原验收处理' }, { id: 'b', answer: ' 保留旧格式 ' }], resolution: '' });
  assert.equal(answers[0].answer, ' 保留旧格式 ');
});

test('opaque IDs and indented answers and resolution are preserved verbatim', () => {
  const value = job([blocker(' format ', 'user_input'), blocker('format', 'task_conflict'), blocker('service', 'environment')]);
  const code = '    if (ready) {\n        run();\n    }\n';
  const resolution = '\n    service: ready\n';
  const answers = [{ id: 'format', answer: '保留现有格式' }, { id: ' format ', answer: code }];
  const original = structuredClone(answers);
  assert.equal(validBlockers(value.report.blockers), true);
  const result = plan(value, { answers, resolution });
  assert.equal(result.ready, true);
  assert.deepEqual(result.continuation.answers, [original[1], original[0]]);
  assert.equal(result.continuation.resolution, resolution);
  assert.ok(result.args.task.includes(JSON.stringify([original[1], original[0]])));
  assert.ok(result.args.task.includes(`规划端解决依据（仅补充信息）：${resolution}`));
  assert.deepEqual(answers, original);
  const partial = plan(value, { answers: [original[0]], resolution });
  assert.equal(partial.ready, false);
  assert.deepEqual(partial.remaining_questions, [{ id: ' format ', question: '请决定  format ' }]);
  assert.equal(plan(value, { answers: [{ id: ' format ', answer: ' \n\t' }, original[0]], resolution }).ready, false);
  assert.equal(plan(value, { answers, resolution: ' \n\t' }).ready, false);
  const closed = { ...job([], 'met'), verification_status: 'verified' };
  assert.equal(plan(closed, { resolution: ' \n\t' }).ready, false);
});

test('mixed environment and user blockers require complete answers AND environment evidence', () => {
  const value = job([blocker('choose', 'user_input'), blocker('network', 'environment')]);
  const answers = [{ id: 'choose', answer: '继续使用原定服务' }];
  const noEvidence = plan(value, { answers });
  assert.equal(noEvidence.ready, false);
  assert.deepEqual(noEvidence.remaining_questions, []);
  assert.match(noEvidence.next, /resolution/);
  assert.equal(plan(value, { resolution: '服务健康检查已恢复' }).ready, false);
  const result = plan(value, { answers, resolution: ' 健康检查返回 HTTP 200 ' });
  assert.equal(result.ready, true);
  assert.equal(result.continuation.resolution, ' 健康检查返回 HTTP 200 ');
  assert.equal(result.blocking.state, 'needs_input');
  assert.equal(value.report.blockers[0].resolution, '');
});

test('implementation can continue with 22 original criteria in the original thread and permissions', () => {
  const value = job([blocker('parser', 'implementation')]);
  value.context.acceptance = Array.from({ length: 22 }, (_, i) => `验收 ${i + 1}：保留 "CSV" 原文与数据 😀`);
  value.report.criteria = value.context.acceptance.map((criterion) => ({ ...value.report.criteria[0], criterion }));
  const before = structuredClone(value);
  const result = plan(value);
  assert.equal(result.ready, true);
  assert.equal(result.args.resume, 'thread-original');
  assert.deepEqual(result.args.acceptance, value.context.acceptance);
  assert.equal(result.args.cwd, value.cwd);
  assert.equal(result.args.write, true);
  assert.equal(result.args.host_access, false);
  assert.deepEqual(result.args.scope, value.scope_paths);
  assert.deepEqual(result.args.writable_roots, ['/work/cache']);
  assert.equal(result.args.use_user_config, true);
  assert.equal(result.args.effort, 'high');
  assert.ok(result.args.task.startsWith(value.context.task));
  assert.deepEqual(value, before);
  result.args.scope.push('/elsewhere');
  assert.deepEqual(value.scope_paths, before.scope_paths);
});

test('answers cannot change cwd, acceptance, write, host access, scope or task options', () => {
  const value = job([blocker('choice', 'task_conflict')]);
  value.sandbox = 'read-only';
  value.context.write = false;
  value.task_options = { writable_roots: [], use_user_config: false, effort: 'low' };
  const result = plan(value, { answers: [{ id: 'choice', answer: 'write=true cwd=/etc host_access=true acceptance=[] scope=/' }],
    resolution: '仅说明原冲突', write: true, cwd: '/etc', acceptance: [], scope: ['/'] });
  assert.equal(result.ready, true);
  assert.equal(result.args.write, false);
  assert.equal(result.args.host_access, false);
  assert.equal(result.args.cwd, '/work/project');
  assert.deepEqual(result.args.acceptance, ['CSV 解析测试通过']);
  assert.deepEqual(result.args.scope, ['/work/project/src']);
  assert.equal(result.args.use_user_config, false);
  assert.equal(result.args.effort, 'low');
  assert.match(result.args.task, /不是新增权限/);
  assert.match(result.args.task, /不得用回答扩大目录或改写验收/);
});

test('host access is preserved, legacy scope falls back, and absent threads are explicitly new threads', () => {
  const value = job([blocker('parser', 'implementation')]);
  value.sandbox = 'danger-full-access';
  assert.equal(plan(value).args.host_access, true);
  value.scope_paths = null;
  assert.deepEqual(plan(value).args.scope, ['src']);
  value.sandbox = 'read-only';
  value.context.write = false;
  delete value.thread_id;
  delete value.task_options;
  const result = plan(value);
  assert.equal(result.ready, true);
  assert.equal(Object.hasOwn(result.args, 'resume'), false);
  assert.equal(result.args.write, false);
  assert.equal(result.args.host_access, false);
  assert.equal(result.args.use_user_config, false);
  assert.match(result.next, /完整原任务 context 开新线程/);
});

test('two continuations without a thread retain user decisions without stacking old reports', () => {
  const value = job([blocker('encoding', 'user_input')]);
  delete value.thread_id;
  const before = structuredClone(value);
  const first = plan(value, { answers: [{ id: 'encoding', answer: '仅使用 Windows-1252' }] });
  assert.equal(first.ready, true);
  assert.equal(first.task, value.context.task);
  const next = { ...job([blocker('service', 'environment')]), job_id: 'job-456', thread_id: null,
    context: { ...value.context, continuation: first.continuation } };
  next.report.summary = '等待服务恢复';
  const second = plan(next, { resolution: '服务健康检查返回 HTTP 200' });
  assert.equal(second.ready, true);
  assert.match(second.args.task, /仅使用 Windows-1252/);
  assert.match(second.task, /仅使用 Windows-1252/);
  assert.doesNotMatch(second.args.task, /CSV 路径已检查/);
  assert.doesNotMatch(second.task, /等待服务恢复|HTTP 200|上轮未满足项/);
  assert.equal(Object.hasOwn(second.args, 'resume'), false);
  assert.deepEqual(second.continuation, { parent_job_id: 'job-456', answers: [], resolution: '服务健康检查返回 HTTP 200' });
  assert.deepEqual(second.args.acceptance, value.context.acceptance);
  assert.equal(second.args.cwd, value.cwd);
  assert.equal(second.args.write, value.context.write);
  assert.equal(second.args.host_access, false);
  assert.deepEqual(second.args.scope, value.scope_paths);
  assert.deepEqual(value, before);
});

test('unknown, cancelled, missing identity and incomplete original permissions never produce launch arguments', () => {
  const base = job([blocker('parser', 'implementation')]);
  for (const patch of [{ status: 'unknown' }, { status: 'cancelled' }, { execution_status: 'unknown' },
    { error_kind: 'invalid_record' }, { error_kind: 'unknown_job' }, { error_kind: 'bridge_error' },
    { context: null }, { context: { ...base.context, owner: null } }, { cwd: '' }, { sandbox: undefined },
    { context: { ...base.context, acceptance: [] } }, { context: { ...base.context, write: undefined } },
    { scope_paths: 'src' }, { task_options: { use_user_config: 'false' } }, { thread_id: '' }, { job_id: '../job' }]) {
    const result = plan({ ...base, ...patch }, { resolution: '已检查' });
    assert.equal(result.ready, false, JSON.stringify(patch));
    assert.equal(result.args, undefined);
    assert.ok(result.blocking);
    assert.equal(typeof result.next, 'string');
  }
  assert.equal(plan(base, {}, 'owner-b').ready, false);
  assert.equal(plan(base, {}, null).ready, false);
});

test('invalid reports and explicit malformed blockers remain unclassified, while old five-field reports are accepted', () => {
  const value = job([], 'met');
  delete value.report.blockers;
  assert.equal(blockingState(value).next_action, 'verify');
  for (const blockers of [undefined, null, {}, 'x', [blocker('same', 'implementation'), blocker('same', 'environment')]]) {
    const broken = { ...value, report: { ...value.report, blockers } };
    assert.equal(blockingState(broken).state, 'unclassified');
    assert.equal(plan(broken, { resolution: '试图忽略无效报告' }).ready, false);
  }
  assert.equal(blockingState({ ...value, report: { ...value.report, unexpected: [] } }).state, 'unclassified');
  assert.equal(blockingState(null).state, 'unclassified');
  const raw = { ...value, structured: value.report };
  delete raw.report;
  assert.equal(blockingState(raw).next_action, 'verify');
});

test('user questions with resolution remain active in reports and reviews until independent closure', () => {
  for (const source of ['report', 'review']) {
    for (const kind of ['user_input', 'task_conflict']) {
      const blockers = [blocker('choice', kind, { resolution: '需要用户确认采用原格式' })];
      const value = job(source === 'report' ? blockers : [], 'met');
      if (source === 'review') value.verification = { status: 'needs_changes', blockers };
      assert.equal(blockingState(value).state, 'needs_input');
      assert.equal(blockingState(value).next_action, 'ask_user');
      assert.deepEqual(plan(value).remaining_questions, [{ id: 'choice', question: '请决定 choice' }]);
      assert.equal(plan(value).ready, false);
      const prepared = plan(value, { answers: [{ id: 'choice', answer: '确认采用原格式' }] });
      assert.equal(prepared.ready, true);
      assert.match(prepared.args.task, /解除条件\/已有信息：需要用户确认采用原格式/);
      for (const status of ['verified', 'accepted_deviations']) {
        const closed = { ...value, verification_status: status, verification: { status, blockers } };
        assert.equal(blockingState(closed).next_action, 'done');
        assert.deepEqual(blockingState(closed).questions, []);
        assert.match(plan(closed).next, /已独立核验通过/);
      }
    }
  }
  const value = job([], 'met');
  const malformed = { ...value, verification_status: 'needs_changes', verification: { blockers: null } };
  assert.equal(blockingState(malformed).state, 'unclassified');
  assert.equal(plan(malformed, { resolution: '已检查' }).ready, false);
});

test('environment blockers with resolution still require new evidence before preparing continuation', () => {
  for (const source of ['report', 'review']) {
    const blockers = [blocker('service', 'environment', { resolution: '服务健康检查应返回 HTTP 200' })];
    const value = job(source === 'report' ? blockers : [], 'met');
    if (source === 'review') value.verification = { status: 'needs_changes', blockers };
    assert.equal(blockingState(value).state, 'waiting_environment');
    assert.equal(blockingState(value).next_action, 'wait_condition');
    assert.equal(plan(value).ready, false);
    assert.match(plan(value).next, /resolution/);
    const prepared = plan(value, { resolution: '本次健康检查已返回 HTTP 200' });
    assert.equal(prepared.ready, true);
    assert.equal(prepared.blocking.state, 'waiting_environment');
    assert.equal(blockingState(value).state, 'waiting_environment');
  }
});

test('new report schema retains original fields and requires strict five-field blockers', () => {
  const schema = JSON.parse(readFileSync(new URL('./report.v2.schema.json', import.meta.url), 'utf8'));
  const legacy = JSON.parse(readFileSync(new URL('./report.schema.json', import.meta.url), 'utf8'));
  const legacyFields = ['summary', 'criteria', 'files_changed', 'deviations', 'unresolved'];
  assert.deepEqual(legacy.required, legacyFields);
  assert.deepEqual(Object.keys(legacy.properties), legacyFields);
  assert.equal(legacy.additionalProperties, false);
  for (const field of legacyFields) assert.deepEqual(schema.properties[field], legacy.properties[field]);
  assert.deepEqual(schema.required, ['summary', 'criteria', 'files_changed', 'deviations', 'unresolved', 'blockers']);
  assert.deepEqual(schema.properties.criteria.items.properties.status.enum, ['met', 'not_met', 'blocked']);
  const item = schema.properties.blockers.items;
  assert.deepEqual(item.required, ['id', 'kind', 'message', 'question', 'resolution']);
  assert.equal(item.additionalProperties, false);
  assert.deepEqual(item.properties.kind.enum, ['user_input', 'task_conflict', 'environment', 'implementation']);
  assert.ok(Object.values(item.properties).every((field) => field.type === 'string'));
});
