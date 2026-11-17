import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareReview, reviewRejection, reviewSkeleton, TODO, pendingCloseout, closeoutRefusal, closeoutSince } from './closeout.mjs';

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
  assert.match(message, /needs_changes 但没有后续轮次：NC；/);
  assert.equal(closeoutRefusal('codex_run', { unreviewed: [], needsChanges: [] }), '');
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
