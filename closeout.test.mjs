import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareReview, reviewRejection } from './closeout.mjs';

const acceptance = ['第一条', '第二条'];
const report = (extra = {}) => ({ summary: 's', criteria: acceptance.map((criterion) => ({ criterion, status: 'met', evidence: 'e' })),
  files_changed: [], deviations: [], unresolved: [], blockers: [], ...extra });
const source = (extra = {}, rep = {}) => ({ job_id: 'J1', status: 'completed', context: { owner: 'a', acceptance }, structured: report(rep), ...extra });
const met = (index) => ({ index, status: 'met', evidence: `核对 ${index}` });

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
