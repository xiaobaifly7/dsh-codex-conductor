import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareReview, reviewRejection, reviewSkeleton, TODO, INFERRED, pendingCloseout, closeoutRefusal, closeoutDeferral, closeoutSince } from './closeout.mjs';

const acceptance = ['第一条', '第二条'];
const report = (extra = {}) => ({ summary: 's', criteria: acceptance.map((criterion) => ({ criterion, status: 'met', evidence: 'e' })),
  files_changed: [], deviations: [], unresolved: [], blockers: [], ...extra });
const source = (extra = {}, rep = {}) => ({ job_id: 'J1', status: 'completed', context: { owner: 'a', acceptance }, structured: report(rep), ...extra });
const met = (index) => ({ index, status: 'met', evidence: `核对 ${index}` });

test('strict keeps any mapped not_met row even when a later row and the review say blocked', () => {
  const criteria = report().criteria;
  criteria[1].status = 'not_met';
  criteria.push({ ...criteria[1], status: 'blocked' });
  const src = source({ openLevel: 'strict', openSupport: { 2: ['later_round'] } }, { criteria });
  const review = { status: 'accepted_deviations', criteria: [
    met(1), { index: 2, status: 'blocked', evidence: '后续仍未完成', accepted: '接受未完成' },
  ] };
  const strict = prepareReview(review, src);
  assert.equal(strict.openUnsupported, 1);
  assert.match(strict.problems[0], /Codex 报告第 2 条为 not_met.*①.*③.*④/);
  assert.doesNotMatch(strict.problems[0], /②/);
  assert.deepEqual(prepareReview(review, { ...src, openLevel: 'relaxed' }).problems, []);
});

test('review repair fixes unambiguous shapes without inventing verdicts', () => {
  const byOrder = prepareReview({ job_id: 'J1', status: 'verified', note: 'n',
    criteria: JSON.stringify([{ status: 'met', evidence: 'a' }, { status: 'met', evidence: 'b' }]) }, source());
  assert.deepEqual(byOrder.problems, []);
  assert.deepEqual(byOrder.review, { status: 'verified', notes: 'n', accepted_deviations: [],
    criteria: [{ index: 1, status: 'met', evidence: 'a' }, { index: 2, status: 'met', evidence: 'b' }] });
  const byText = prepareReview({ status: 'verified', criteria: [{ criterion: '第二条', status: 'met', evidence: 'b' }, { index: '1', status: 'met', evidence: 'a' }] }, source());
  assert.deepEqual(byText.problems, []);
  assert.deepEqual(byText.review.criteria.map((c) => c.index), [2, 1]);
  const extras = prepareReview({ status: 'accepted_deviations', criteria: [met(1), met(2)],
    accepted_deviations: [{ index: 1, evidence: '用户已接受' }, { kind: 'reported', index: 2, evidence: '多写的' }] }, source({}, { deviations: ['改了格式'] }));
  assert.deepEqual(extras.problems, []);
  assert.deepEqual(extras.review.accepted_deviations, [{ kind: 'reported', index: 1, evidence: '用户已接受' }]);
  assert.match(extras.review.notes, /reported#2\] 多写的/);
});

test('review repair lists every remaining problem in one message', () => {
  const src = source({ out_of_scope: ['x.txt'] }, { deviations: ['偏差甲'] });
  const result = prepareReview({ job_id: 'J1', criteria: [met(1), { index: 3, status: 'pass', evidence: '' }], accepted_deviations: [{ kind: 'scope', index: 2, evidence: 'e' }] }, src);
  const message = reviewRejection('J1', src, result);
  for (const part of ['status 缺失', '缺少验收标准 2', 'index 3 超出范围', '"pass"', 'evidence 为空', 'scope#2 不存在', 'reported#1、scope#1', '恰好 2 项'])
    assert.ok(message.includes(part), part);
  const pass = prepareReview({ status: 'verified', criteria: [met(1), { index: 2, status: 'not_met', evidence: 'e' }] }, source({}, { deviations: ['偏差甲'] }));
  assert.ok(pass.problems.some((p) => p.includes('2=not_met')));
  assert.ok(pass.problems.some((p) => p.includes('reported#1') && p.includes('偏差甲')));
  const empty = prepareReview({ status: 'needs_changes', criteria: [met(1), met(2)] }, source());
  assert.ok(empty.problems.some((p) => p.includes('不能记 needs_changes')));
  // 有真实偏差缺确认时，多余条目可能是编号写错，不自动移除。
  const wrong = prepareReview({ status: 'accepted_deviations', criteria: [met(1), met(2)],
    accepted_deviations: [{ kind: 'reported', index: 2, evidence: 'e' }] }, source({}, { deviations: ['偏差甲'] }));
  assert.equal(wrong.review.accepted_deviations.length, 1);
  assert.ok(wrong.problems.some((p) => p.includes('reported#2 不存在')));
});

test('verified must address every item the report flagged', () => {
  const flagged = source({}, { criteria: [{ criterion: '第一条', status: 'met', evidence: 'e' }, { criterion: '第二条', status: 'blocked', evidence: '没跑测试' }],
    unresolved: ['数据未刷新'], blockers: [{ id: 'B1', kind: 'environment', message: '网络断开', question: '', resolution: '' }] });
  const copied = prepareReview({ status: 'verified', criteria: [met(1), { index: 2, status: 'met', evidence: '没跑测试' }] }, flagged);
  assert.ok(copied.problems.some((p) => p.includes('第 2 条为 blocked')));
  assert.ok(copied.problems.some((p) => p.includes('unresolved#1')));
  assert.ok(copied.problems.some((p) => p.includes('blocker:B1')));
  const addressed = prepareReview({ status: 'verified', criteria: [met(1), met(2)],
    notes: 'unresolved#1: 已手动刷新并核对\nblocker:B1: 网络已恢复，测试已重跑' }, flagged);
  assert.deepEqual(addressed.problems, []);
  // needs_changes 不受此约束。
  assert.deepEqual(prepareReview({ status: 'needs_changes', criteria: [met(1), { index: 2, status: 'not_met', evidence: 'x' }] }, flagged).problems, []);
});

test('close-out guard picks unreviewed flagged jobs and needs_changes without follow-up', () => {
  const done = (job_id, extra = {}) => ({ job_id, execution_status: 'completed', report_status: 'valid', review_status: 'needs_attention',
    verification_status: 'unreviewed', finished_at: 200, started_at: 100, thread_id: `T-${job_id}`, parent_job_id: null, ...extra });
  const jobs = [done('A'), done('OLD', { finished_at: 50 }), done('CANCELLED', { execution_status: 'cancelled', report_status: 'missing' }),
    done('NOREPORT', { execution_status: 'failed', report_status: 'missing' }), done('CLEAN', { review_status: 'needs_verification' }),
    done('VERIFY', { context: { verification_of: 'A' } }), done('NC', { verification_status: 'needs_changes' }),
    done('NC2', { verification_status: 'needs_changes' }), done('CHILD', { parent_job_id: 'NC2', review_status: 'needs_verification' }),
    done('NC3', { verification_status: 'needs_changes' }), done('RESUMED', { thread_id: 'T-NC3', started_at: 300, review_status: 'needs_verification' }),
    done('OK', { verification_status: 'verified' }), done('RUNNING', { execution_status: 'running', finished_at: null })];
  const pending = pendingCloseout(jobs, 100);
  assert.deepEqual(pending, { unreviewed: ['A'], needsChanges: ['NC'] });
  const message = closeoutRefusal('codex_run', pending);
  assert.match(message, /codex_review 记录：A。/);
  assert.match(message, /needs_changes 尚未结案，最新轮次：NC；用 codex_continue 或带 resume 的 codex_run 返工/);
  assert.match(closeoutRefusal('codex_run', pending, { resume: false }), /最新轮次：NC；用 codex_continue 返工/);
  assert.equal(closeoutRefusal('codex_run', { unreviewed: [], needsChanges: [] }), '');
});

test('new rework debt follows the latest execution round until a successor closes it', () => {
  const original = { job_id: 'ROOT', thread_id: 'original', started_at: 100, finished_at: 110,
    execution_status: 'completed', verification_status: 'needs_changes', verification: { time: 150 } };
  const child = { job_id: 'NEXT', parent_job_id: 'ROOT', thread_id: 'new-thread', started_at: 160,
    execution_status: 'completed', verification_status: 'unreviewed', finished_at: 170 };
  const resumed = { ...child, job_id: 'LATEST', parent_job_id: null, started_at: 180, finished_at: 190 };
  const debt = (...jobs) => pendingCloseout(jobs, 90, 120).needsChanges;
  assert.deepEqual(debt(original), ['ROOT']);
  for (const execution_status of ['failed', 'cancelled', 'running', 'completed']) {
    assert.deepEqual(debt({ ...resumed, execution_status }, original, child), ['LATEST']);
  }
  for (const verification_status of ['verified', 'accepted_deviations']) {
    assert.deepEqual(debt(original, child, { ...resumed, verification_status }), []);
  }
  assert.deepEqual(debt(original, { ...child, context: { verification_of: 'ROOT' }, verification_status: 'verified' }), ['ROOT']);
  assert.deepEqual(debt({ ...original, verification: { time: 119 } }, child), []);
  const flagged = { ...child, report_status: 'valid', review_status: 'needs_attention' };
  const jobs = [original, flagged];
  assert.deepEqual(closeoutDeferral(jobs, pendingCloseout(jobs, 90, 120), 'NEXT'), { job_id: 'NEXT', via: 'verify_previous' });
});

test('close-out cut-off is written once and then kept', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'conductor-closeout-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(closeoutSince(path.join(dir, 'state'), 1000), 1000);
  assert.equal(closeoutSince(path.join(dir, 'state'), 2000), 1000);
  assert.equal(closeoutSince(undefined, 3000), 3000);
});

test('criteria without index are aligned by text, by position only when they carry no text', () => {
  // 条文与验收原文不一致且顺序颠倒：不按位置补 index，报问题并附验收清单。
  const reversed = { status: 'needs_changes', criteria: [{ criterion: 'Docs are updated', status: 'not_met', evidence: 'README untouched' },
    { criterion: 'Tests pass', status: 'met', evidence: 'npm test ok' }] };
  const src = source({ context: { owner: 'a', acceptance: ['tests pass', 'docs updated'] } });
  const result = prepareReview(reversed, src);
  assert.deepEqual(result.review.criteria.map((c) => c.index), [undefined, undefined]);
  assert.ok(result.problems.some((p) => p.includes('第 1 项缺少整数 index') && p.includes('Docs are updated')));
  assert.ok(!result.fixed.some((f) => f.includes('按顺序')));
  assert.match(reviewRejection('J1', src, result), /验收清单：1\. tests pass；2\. docs updated/);
  // 没有条文且条数相符：按位置补。
  const plain = prepareReview({ status: 'verified', criteria: [{ status: 'met', evidence: 'a' }, { status: 'met', evidence: 'b' }] }, src);
  assert.deepEqual([plain.problems, plain.review.criteria.map((c) => c.index)], [[], [1, 2]]);
  // 条文恰好对上一条：按条文补，即使顺序颠倒。
  const exact = prepareReview({ status: 'needs_changes', criteria: [{ criterion: 'docs updated', status: 'not_met', evidence: 'x' },
    { criterion: 'tests pass', status: 'met', evidence: 'y' }] }, src);
  assert.deepEqual([exact.problems, exact.review.criteria.map((c) => c.index)], [[], [2, 1]]);
});

test('a rejection carries a pre-filled review skeleton that only leaves the missing parts as placeholders', () => {
  const src = source({ out_of_scope: ['x.txt'] }, { deviations: ['偏差甲'], unresolved: ['数据未刷新'],
    blockers: [{ id: 'B1', kind: 'environment', message: '网络断开', question: '', resolution: '' }] });
  const result = prepareReview({ status: 'verified', criteria: [met(1)], notes: '已核对', accepted_deviations: [{ kind: 'reported', index: 1, evidence: '用户已接受' }] }, src);
  const message = reviewRejection('J1', src, result);
  const skeleton = JSON.parse(message.split('\n').find((line) => line.startsWith('{"job_id"')));
  assert.deepEqual(skeleton, { job_id: 'J1', status: 'verified',
    criteria: [{ index: 1, status: 'met', evidence: '核对 1' }, { index: 2, status: TODO, evidence: TODO }],
    accepted_deviations: [{ kind: 'reported', index: 1, evidence: '用户已接受' }, { kind: 'scope', index: 1, evidence: TODO }],
    notes: `已核对\nunresolved#1: ${TODO}\nblocker:B1: ${TODO}` });
  // 原样提交骨架会被拒；把占位换掉后一次通过。
  assert.ok(prepareReview(skeleton, src).problems.some((p) => p.includes('占位')));
  const filled = JSON.parse(JSON.stringify(skeleton).replaceAll(TODO, 'met').replace('"evidence":"met"', '"evidence":"复核 2"')
    .replace('"evidence":"met"', '"evidence":"范围外改动已核对"').replace('unresolved#1: met', 'unresolved#1: 已刷新').replace('blocker:B1: met', 'blocker:B1: 已恢复'));
  assert.deepEqual(prepareReview(filled, src).problems, []);
  // needs_changes 的骨架不要求确认偏差或标记。
  const nc = reviewSkeleton('J1', src, { status: 'needs_changes', criteria: [met(1)] });
  assert.deepEqual(Object.keys(nc), ['job_id', 'status', 'criteria']);
});

test('closing verdicts need independent support for criteria the report marked blocked, at the chosen level', () => {
  const src = (level, support) => ({ ...source({}, { criteria: [{ criterion: '第一条', status: 'met', evidence: 'e1' }, { criterion: '第二条', status: 'blocked', evidence: '没权限' }] }),
    evidenceLevel: level, ...(support ? { support } : {}) });
  const met2 = { index: 2, status: 'met', evidence: '我看了一下应该没问题' };
  for (const status of ['verified', 'accepted_deviations']) {
    const bare = prepareReview({ status, criteria: [met(1), met2] }, src('independent'));
    assert.equal(bare.unsupported, 1, status);
    assert.ok(bare.problems.some((p) => p.includes('第 2 条为 blocked') && p.includes('没有独立依据') &&
      p.includes('先对 J1 派 codex_verify（或在下一单上带 verify_previous），核验在跑时可以派不重叠的下一单') && p.includes('codex_continue J1') && p.includes('accepted')), status);
    for (const kind of ['verification', 'later_round', 'user']) {
      assert.deepEqual(prepareReview({ status, criteria: [met(1), met2] }, src('independent', { 2: [kind] })).problems, [], `${status} ${kind}`);
    }
    // planner：自己写的（非照抄）证据即可，照抄报告原文不行；off：不查。
    assert.deepEqual(prepareReview({ status, criteria: [met(1), met2] }, src('planner')).problems.filter((p) => p.includes('第 2 条')), []);
    assert.ok(prepareReview({ status, criteria: [met(1), { ...met2, evidence: '没权限' }] }, src('planner')).problems.some((p) => p.includes('不能照抄')));
    assert.deepEqual(prepareReview({ status, criteria: [met(1), { ...met2, evidence: '没权限' }] }, src('off')).problems.filter((p) => p.includes('第 2 条')), []);
  }
});

test('accepted_deviations can record an open criterion as accepted although not met, and nothing else can', () => {
  const src = { ...source({}, { criteria: [{ criterion: '第一条', status: 'met', evidence: 'e1' }, { criterion: '第二条', status: 'blocked', evidence: '没权限' }] }), evidenceLevel: 'independent' };
  const open = { index: 2, status: 'blocked', evidence: '仍无权限', accepted: '用户已同意本期不做' };
  const ok = prepareReview({ status: 'accepted_deviations', criteria: [met(1), open] }, src);
  assert.deepEqual([ok.problems, ok.unsupported], [[], 0]);
  assert.equal(ok.review.criteria[1].accepted, '用户已同意本期不做');
  // 没写 accepted：按 accepted_deviations 的意图接受，原因取 evidence，并在 fixed 里说明。
  const inferred = prepareReview({ status: 'accepted_deviations', criteria: [met(1), { ...open, accepted: undefined }] }, src);
  assert.deepEqual([inferred.problems, inferred.inferred, inferred.review.criteria[1].accepted], [[], 1, `${INFERRED}仍无权限`]);
  assert.ok(inferred.fixed.some((f) => f.includes('index 2=blocked') && f.includes('视为接受未满足')));
  // 从不推定 met：verified 里的未满足照样被拒。
  assert.ok(prepareReview({ status: 'verified', criteria: [met(1), { ...open, accepted: undefined }] }, src).problems
    .some((p) => p.includes('2=blocked') && p.includes('加 accepted 字段')));
  assert.ok(prepareReview({ status: 'verified', criteria: [met(1), open] }, src).problems.some((p) => p.includes('accepted 只用于')));
  assert.ok(prepareReview({ status: 'accepted_deviations', criteria: [{ ...met(1), accepted: 'x' }, open] }, src).problems.some((p) => p.includes('accepted 只用于')));
  // needs_changes 照常可用。
  assert.deepEqual(prepareReview({ status: 'needs_changes', criteria: [met(1), { index: 2, status: 'blocked', evidence: '仍无权限' }] }, src).problems, []);
});

// 0.9.118 上线后的实际形状（只保留条数和状态）：核验任务 743982 验收 5 条、报告 13 行，第 8、13 行 not_met；460f80 验收 8 条、报告 9 行，第 9 行 blocked。
const rowsSource = (accepted, statuses, extra = {}) => ({ job_id: 'V', status: 'completed', context: { owner: 'a', acceptance: Array.from({ length: accepted }, (_v, i) => `验收 ${i + 1}`) },
  structured: { summary: 's', criteria: statuses.map((status, i) => ({ criterion: `改写过的第 ${i + 1} 行`, status, evidence: `报告 ${i + 1}` })),
    files_changed: [], deviations: [], unresolved: [], blockers: [] }, evidenceLevel: 'independent', ...extra });
const statuses743982 = ['met', 'met', 'met', 'met', 'met', 'met', 'met', 'not_met', 'met', 'met', 'met', 'met', 'not_met'];
const allMet = (n) => Array.from({ length: n }, (_v, i) => met(i + 1));

test('flagged report rows that match no acceptance criterion must be addressed in report_rows; dropping them no longer passes', () => {
  const src = rowsSource(5, statuses743982);
  // 0.9.118 上线时这样的结案（只按验收条数提交）直接通过，第 8、13 行没有人处理。
  for (const status of ['verified', 'accepted_deviations']) {
    const dropped = prepareReview({ status, criteria: allMet(5) }, src);
    assert.equal(dropped.problems.filter((p) => /报告第 (8|13) 行标 not_met，对不上任何一条验收标准（报告 13 行、验收 5 条）.*report_rows/.test(p)).length, 2, status);
  }
  // 条数不同时不按位置把第 8 行算成第 8 条验收（那会是“超出范围”）。
  assert.ok(!prepareReview({ status: 'verified', criteria: allMet(5) }, src).problems.some((p) => p.includes('超出范围')));
  // 记 met 需要独立依据，规则与 criteria 相同。
  const rowsMet = [{ row: 8, status: 'met', evidence: '我看过' }, { row: 13, status: 'met', evidence: '我看过' }];
  const bare = prepareReview({ status: 'verified', criteria: allMet(5), report_rows: rowsMet }, src);
  assert.equal(bare.unsupported, 2);
  assert.ok(bare.problems.some((p) => p.includes('报告第 8 行（对不上验收清单）为 not_met') && p.includes('先对 V 派 codex_verify')));
  assert.deepEqual(prepareReview({ status: 'verified', criteria: allMet(5), report_rows: rowsMet }, { ...src, support: { row8: ['verification'], row13: ['user'] } }).problems, []);
  // 照实保留：accepted_deviations 加 accepted；verified 不行。
  const open = [{ row: 8, status: 'not_met', evidence: '确实不对' }, { row: 13, status: 'not_met', evidence: '确实不对' }];
  assert.ok(prepareReview({ status: 'verified', criteria: allMet(5), report_rows: open }, src).problems
    .some((p) => p.includes('报告第 8 行=not_met') && p.includes('{"row":8,"status":"not_met","evidence":"<核验依据>","accepted":"<为什么接受未满足>"}')));
  assert.equal(prepareReview({ status: 'accepted_deviations', criteria: allMet(5), report_rows: open }, src).inferred, 2);
  assert.deepEqual(prepareReview({ status: 'accepted_deviations', criteria: allMet(5), report_rows: open.map((r) => ({ ...r, accepted: '不影响本单结论' })) }, src).problems, []);
  assert.ok(prepareReview({ status: 'verified', criteria: allMet(5), report_rows: open }, src).problems.some((p) => p.startsWith('verified 要求每条验收都 met')));
  // needs_changes：验收全 met 时，把报告行记 not_met 即可（不再被“全 met 不能 needs_changes”挡住）。
  assert.ok(prepareReview({ status: 'needs_changes', criteria: allMet(5) }, src).problems.some((p) => p.includes('报告第 8、13 行在 report_rows 标')));
  assert.deepEqual(prepareReview({ status: 'needs_changes', criteria: allMet(5), report_rows: [open[0]] }, src).problems, []);
  // 只接受需要处理的行号，且每行一次。
  assert.ok(prepareReview({ status: 'verified', criteria: allMet(5), report_rows: [...rowsMet, { row: 3, status: 'met', evidence: 'x' }] }, { ...src, support: { row8: ['user'], row13: ['user'] } })
    .problems.some((p) => p.includes('row 3 不需要单独处理；只有报告第 8、13 行需要')));
  assert.ok(prepareReview({ status: 'needs_changes', criteria: allMet(5), report_rows: [open[0], open[0]] }, src).problems.some((p) => p.includes('row 8 重复')));
  // 拒绝回执的形状说明和骨架列出这些行。
  const result = prepareReview({ status: 'verified', criteria: allMet(5) }, src);
  const message = reviewRejection('V', src, result);
  assert.match(message, /report_rows:\[报告 13 行、验收 5 条，第 8 行（not_met）、13 行（not_met）对不上验收清单/);
  const skeleton = JSON.parse(message.split('\n').find((line) => line.startsWith('{"job_id"')));
  assert.deepEqual(skeleton.report_rows, [{ row: 8, status: TODO, evidence: TODO }, { row: 13, status: TODO, evidence: TODO }]);
  // 460f80：验收 8 条、报告 9 行，第 9 行 blocked。
  const src460 = rowsSource(8, [...Array(8).fill('met'), 'blocked']);
  assert.ok(prepareReview({ status: 'verified', criteria: allMet(8) }, src460).problems.some((p) => p.includes('报告第 9 行标 blocked')));
  // 条数相同：仍按位置对应验收编号（改写过条文的真实报告靠这个）。
  const aligned = rowsSource(2, ['met', 'blocked']);
  assert.ok(prepareReview({ status: 'verified', criteria: allMet(2) }, aligned).problems.some((p) => p.includes('报告第 2 条为 blocked')));
  assert.equal(reviewSkeleton('V', aligned, { status: 'verified', criteria: allMet(2) }).report_rows, undefined);
});

test('replaying the 4c0261 loop: an open criterion kept under accepted_deviations is accepted on the first try; the skeleton keeps accepted', () => {
  // 4c0261：验收 12 条，报告第 3、8 行 blocked；规划端连续 4 次提交 accepted_deviations，第 3 条保留 blocked 却没有 accepted，每次都被拒。
  const statuses = Array.from({ length: 12 }, (_v, i) => ([2, 7].includes(i) ? 'blocked' : 'met'));
  const src = { ...rowsSource(12, statuses), support: { 8: ['later_round'] } };
  const attempt = { job_id: 'V', status: 'accepted_deviations', criteria: allMet(12).map((c) => (c.index === 3 ? { index: 3, status: 'blocked', evidence: '仍无法核实' } : c)) };
  const first = prepareReview(attempt, src);
  assert.deepEqual([first.problems, first.inferred, first.review.criteria[2].accepted], [[], 1, `${INFERRED}仍无法核实`]);
  assert.ok(first.fixed.some((f) => f.includes('criteria 第 3 项（index 3=blocked）没写 accepted')));
  // 有别的问题时骨架给这一条带上 accepted 占位；原样提交占位只得到一条点名 accepted 的提示（带一行结构示例）。
  const other = prepareReview({ ...attempt, criteria: attempt.criteria.map((c) => (c.index === 5 ? { ...c, evidence: '' } : c)) }, src);
  const skeleton = JSON.parse(reviewRejection('V', src, other).split('\n').find((line) => line.startsWith('{"job_id"')));
  assert.equal(skeleton.criteria.filter((c) => 'accepted' in c).length, 1);
  assert.deepEqual(skeleton.criteria[2], { index: 3, status: 'blocked', evidence: '仍无法核实', accepted: `${INFERRED}仍无法核实` });
  const leftTodo = { ...skeleton, criteria: skeleton.criteria.map((c) => (c.index === 3 ? { ...c, accepted: TODO } : c.index === 5 ? { ...c, evidence: '核对 5' } : c)) };
  assert.deepEqual(prepareReview(leftTodo, src).problems, [`criteria 第 3 项的 accepted 还是 ${TODO}：写明为什么接受这一条未满足，形如 ` +
    '{"index":3,"status":"blocked","evidence":"<核验依据>","accepted":"<为什么接受未满足>"}；不接受就核实后改记 met，或改记 needs_changes']);
  // 骨架里没有可沿用的原因时留占位。
  assert.equal(reviewSkeleton('V', src, { ...attempt, criteria: attempt.criteria.map((c) => (c.index === 3 ? { ...c, evidence: '' } : c)) }).criteria[2].accepted, TODO);
  // 规划端亲手写的 accepted 原样保留。
  const filled = { ...attempt, criteria: attempt.criteria.map((c) => (c.index === 3 ? { ...c, accepted: '环境限制，用户同意后补' } : c)) };
  const ok = prepareReview(filled, src);
  assert.deepEqual([ok.problems, ok.inferred, ok.review.criteria[2].accepted], [[], 0, '环境限制，用户同意后补']);
  assert.equal(reviewSkeleton('V', src, filled).criteria[2].accepted, '环境限制，用户同意后补');
  // 改记 needs_changes 时，未填的占位自动去掉，不额外报错。
  const switched = prepareReview({ ...attempt, status: 'needs_changes', criteria: attempt.criteria.map((c) => (c.index === 3 ? { ...c, accepted: TODO } : c)) }, src);
  assert.deepEqual(switched.problems, []);
  assert.ok(!('accepted' in switched.review.criteria[2]) && switched.fixed.some((f) => f.includes('去掉未填的 accepted 占位')));
  // verified 的骨架不带 accepted。
  assert.ok(reviewSkeleton('V', src, { status: 'verified', criteria: attempt.criteria }).criteria.every((c) => !('accepted' in c)));
});

test('verification deferral: only the single unreviewed job, only while its first verification runs, never alongside other pending work', () => {
  const done = (job_id, extra = {}) => ({ job_id, execution_status: 'completed', report_status: 'valid', review_status: 'needs_attention',
    verification_status: 'unreviewed', finished_at: 200, started_at: 100, ...extra });
  const check = (job_id, execution_status, of = 'A') => ({ job_id, execution_status, finished_at: execution_status === 'running' ? null : 300, started_at: 250,
    context: { verification_of: of } });
  const defer = (jobs, deferFor) => closeoutDeferral(jobs, pendingCloseout(jobs, 100), deferFor);
  assert.deepEqual(defer([done('A'), check('V1', 'running')]), { job_id: 'A', via: 'running' });
  assert.deepEqual(defer([done('A')], 'A'), { job_id: 'A', via: 'verify_previous' });
  assert.equal(defer([done('A')]), null);
  assert.equal(defer([done('A')], 'OTHER'), null);
  // 每个任务只放行一次：已有结束（完成、失败、取消）的核验就不再放行，哪怕又派了一次核验。
  for (const status of ['completed', 'failed', 'cancelled']) {
    assert.equal(defer([done('A'), check('V1', status)]), null, status);
    assert.equal(defer([done('A'), check('V1', status), check('V2', 'running')], 'A'), null, status);
  }
  // 同一时间只放行一个待验收任务；有 needs_changes 没跟进时也不放行。
  assert.equal(defer([done('A'), check('V1', 'running'), done('B'), check('V2', 'running', 'B')]), null);
  assert.equal(defer([done('A'), check('V1', 'running'), done('NC', { verification_status: 'needs_changes' })]), null);
  // 核验判 needs_changes、规划端记下后：A 成了没跟进的 needs_changes，照常拦。
  assert.equal(defer([done('A', { verification_status: 'needs_changes' }), check('V1', 'completed')]), null);
  // 护栏拒绝文字给出这条路；update_goal 不给（核验中的任务仍未收尾）。
  assert.match(closeoutRefusal('codex_run', { unreviewed: ['A'], needsChanges: [] }),
    /先对 A 派 codex_verify（或在下一单上带 verify_previous），核验在跑时可以派不重叠的下一单（同一时间只放行一个待验收任务，每个任务只放行一次）/);
  assert.ok(!closeoutRefusal('update_goal', { unreviewed: ['A'], needsChanges: [] }).includes('verify_previous'));
});
