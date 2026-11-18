import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// codex_review 提交前的机械修补与一次性问题清单：只改无歧义的形状，不替规划端判定结论、补证据或接受偏差。
const STATUSES = ['verified', 'needs_changes', 'accepted_deviations'];
const MARKS = ['met', 'not_met', 'blocked'];
const BLOCKER_KINDS = ['user_input', 'task_conflict', 'environment', 'implementation'];
const clip = (value, size = 60) => { const s = String(value ?? '').replace(/\s+/g, ' ').trim(); return s.length > size ? `${s.slice(0, size)}…` : s; };
const label = (a) => (typeof a === 'string' ? a : a?.criterion ?? '');
const nonempty = (s) => typeof s === 'string' && s.trim() !== '';
const asInt = (v) => (typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : v);
// 规划端常把数组序列化成字符串；只接受解析结果确为数组的情况。
const asArray = (v) => {
  if (typeof v !== 'string') return v;
  try { const parsed = JSON.parse(v); return Array.isArray(parsed) ? parsed : v; } catch { return v; }
};

// 与 runner validate_review 相同的依据：任务验收清单、报告偏差和范围外改动。
export function reviewTargets(source) {
  const report = source?.structured;
  const acceptance = Array.isArray(source?.context?.acceptance) ? source.context.acceptance
    : Array.isArray(report?.criteria) ? report.criteria : null;
  const reported = Array.isArray(report?.deviations) ? report.deviations : [];
  const outside = Array.isArray(source?.out_of_scope) ? source.out_of_scope : [];
  return { acceptance, deviations: [
    ...reported.map((text, i) => ({ kind: 'reported', index: i + 1, text })),
    ...outside.map((text, i) => ({ kind: 'scope', index: i + 1, text })),
  ] };
}

export const reviewItemText = (source, { row, index }) => row
  ? source.structured?.criteria?.[row - 1]?.criterion
  : label(reviewTargets(source).acceptance?.[index - 1]);

export function prepareReview(args, source) {
  const { job_id: _job, ...input } = args ?? {};
  const review = { ...input };
  const fixed = [];
  const problems = [];
  const { acceptance, deviations } = reviewTargets(source);
  if ('note' in review && !('notes' in review)) { review.notes = review.note; delete review.note; fixed.push('note 改为 notes'); }
  if (review.notes == null) review.notes = '';
  if (review.accepted_deviations == null) review.accepted_deviations = [];
  if (review.blockers == null) delete review.blockers;
  if (review.report_rows == null) delete review.report_rows;
  for (const key of ['criteria', 'accepted_deviations', 'blockers', 'report_rows']) {
    if (typeof review[key] === 'string' && Array.isArray(asArray(review[key]))) { review[key] = asArray(review[key]); fixed.push(`${key} 由字符串解析为数组`); }
  }
  const unknown = Object.keys(review).filter((k) => !['status', 'criteria', 'notes', 'accepted_deviations', 'blockers', 'report_rows'].includes(k));
  if (unknown.length) problems.push(`不认识的字段：${unknown.join('、')}（只接受 job_id、status、criteria、report_rows、notes、accepted_deviations、blockers）`);
  const extraRows = flaggedCriteria(source).filter((f) => f.row);
  let inferred = 0;
  // accepted 的检查（criteria 与 report_rows 共用）；骨架留下的占位在用不上时直接去掉，用得上时给出带结构示例的提示。
  const checkAccepted = (c, n, field) => {
    const open = review.status === 'accepted_deviations' && c.status !== 'met';
    // 规划端选了 accepted_deviations、这一条照实保留 not_met/blocked 却没写 accepted：意图是“接受未满足”，接受原因取这一条的 evidence 并在结果里说明。
    // 只补 accepted，从不把任何条目推定为 met；照样经过接受偏差的用户确认。
    if (c.accepted == null && open && MARKS.includes(c.status) && nonempty(c.evidence)) {
      c.accepted = `${INFERRED}${c.evidence.trim()}`;
      fixed.push(`${field} 第 ${n + 1} 项（${c.row ? `报告第 ${c.row} 行` : `index ${c.index}`}=${c.status}）没写 accepted：按 accepted_deviations 视为接受未满足，` +
        '接受原因取这一条的 evidence；不是本意就改记 needs_changes，或核实后记 met');
      inferred++;
      return;
    }
    if (c.accepted === undefined) { delete c.accepted; return; }
    if (placeholder(c.accepted) && !open) { delete c.accepted; fixed.push(`${field} 第 ${n + 1} 项去掉未填的 accepted 占位`); return; }
    if (placeholder(c.accepted)) problems.push(`${field} 第 ${n + 1} 项的 accepted 还是 ${TODO}：写明为什么接受这一条未满足，形如 ${acceptedExample(c)}；不接受就核实后改记 met，或改记 needs_changes`);
    else if (!nonempty(c.accepted) || !open) problems.push(`${field} 第 ${n + 1} 项的 accepted 只用于 accepted_deviations 里未满足（not_met/blocked）的条目，写明为什么接受未满足；记 met 或 needs_changes 时删去 accepted`);
  };
  if (!STATUSES.includes(review.status)) problems.push(`status 缺失或无效（${JSON.stringify(review.status) ?? '未填'}）；必须由你判定为 ${STATUSES.join(' / ')} 之一`);
  if (typeof review.notes !== 'string') problems.push('notes 必须是字符串');

  if (!Array.isArray(review.criteria)) problems.push('criteria 必须是数组');
  else {
    const all = review.criteria;
    const byOrder = acceptance && all.length === acceptance.length && all.every((c) => c && typeof c === 'object' && c.index == null);
    review.criteria = all.map((raw, n) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { problems.push(`criteria 第 ${n + 1} 项不是对象`); return raw; }
      const { criterion, ...c } = raw;
      c.index = asInt(c.index);
      if (c.index == null && acceptance) {
        const hits = acceptance.flatMap((a, i) => (nonempty(criterion) && label(a).trim() === criterion.trim() ? [i + 1] : []));
        if (hits.length === 1) { c.index = hits[0]; fixed.push(`criteria 第 ${n + 1} 项按条文对齐到 index ${hits[0]}`); }
        // 带条文却对不上时不按位置猜，避免把结论记到别的验收项上。
        else if (byOrder && !nonempty(criterion)) { c.index = n + 1; fixed.push(`criteria 第 ${n + 1} 项按顺序补 index ${n + 1}`); }
      }
      const extra = Object.keys(c).filter((k) => !['index', 'status', 'evidence', 'accepted'].includes(k));
      checkAccepted(c, n, 'criteria');
      if (extra.length) problems.push(`criteria 第 ${n + 1} 项有多余字段：${extra.join('、')}`);
      if (!Number.isInteger(c.index)) problems.push(`criteria 第 ${n + 1} 项缺少整数 index（从 1 开始，对应验收标准序号）` +
        (nonempty(criterion) ? `；条文「${clip(criterion)}」对不上任何一条验收标准原文，请按下面的验收清单写 index` : ''));
      if (!MARKS.includes(c.status)) problems.push(`criteria 第 ${n + 1} 项 status 无效（${JSON.stringify(c.status) ?? '未填'}），只能是 ${MARKS.join(' / ')}`);
      if (!nonempty(c.evidence)) problems.push(`criteria 第 ${n + 1} 项 evidence 为空，需写你核验的依据`);
      return c;
    });
    if (acceptance) {
      const indexes = review.criteria.map((c) => c?.index).filter(Number.isInteger);
      const missing = acceptance.map((_a, i) => i + 1).filter((i) => !indexes.includes(i));
      const outside = [...new Set(indexes.filter((i) => i < 1 || i > acceptance.length))];
      const twice = [...new Set(indexes.filter((i, k) => indexes.indexOf(i) !== k))];
      for (const i of missing) problems.push(`缺少验收标准 ${i}：「${clip(label(acceptance[i - 1]))}」`);
      if (outside.length) problems.push(`index ${outside.join('、')} 超出范围：原任务只有 ${acceptance.length} 条验收标准（不要按 Codex 报告或其他任务的条目编号）`);
      if (twice.length) problems.push(`index ${twice.join('、')} 重复出现，每条验收标准只记一次`);
    }
  }

  // 报告行数与验收条数不同时，报告自标 not_met/blocked 又对不上任何验收原文的行：结案结论须在 report_rows 逐行处理。
  if (review.report_rows !== undefined) {
    if (!Array.isArray(review.report_rows)) problems.push('report_rows 必须是数组');
    else {
      review.report_rows = review.report_rows.map((raw, n) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { problems.push(`report_rows 第 ${n + 1} 项不是对象`); return raw; }
        const r = { ...raw, row: asInt(raw.row) };
        const extra = Object.keys(r).filter((k) => !['row', 'status', 'evidence', 'accepted'].includes(k));
        if (extra.length) problems.push(`report_rows 第 ${n + 1} 项有多余字段：${extra.join('、')}`);
        checkAccepted(r, n, 'report_rows');
        if (!extraRows.some((f) => f.row === r.row)) problems.push(`report_rows 第 ${n + 1} 项的 row ${JSON.stringify(r.row) ?? '未填'} 不需要单独处理；` +
          (extraRows.length ? `只有报告第 ${extraRows.map((f) => f.row).join('、')} 行需要` : '这份报告没有需要单独处理的行，去掉 report_rows'));
        if (!MARKS.includes(r.status)) problems.push(`report_rows 第 ${n + 1} 项 status 无效（${JSON.stringify(r.status) ?? '未填'}），只能是 ${MARKS.join(' / ')}`);
        if (!nonempty(r.evidence)) problems.push(`report_rows 第 ${n + 1} 项 evidence 为空，需写你核验的依据`);
        return r;
      });
      const rows = review.report_rows.map((r) => r?.row).filter(Number.isInteger);
      const twice = [...new Set(rows.filter((x, k) => rows.indexOf(x) !== k))];
      if (twice.length) problems.push(`report_rows 的 row ${twice.join('、')} 重复出现，每行只记一次`);
    }
  }
  if (review.status !== 'needs_changes' && STATUSES.includes(review.status)) {
    const given = Array.isArray(review.report_rows) ? review.report_rows : [];
    for (const f of extraRows.filter((f) => !given.some((r) => r?.row === f.row))) {
      problems.push(`Codex 报告第 ${f.row} 行标 ${f.status}，对不上任何一条验收标准（${rowCounts(source)}）；${review.status} 需在 report_rows 写 ` +
        `{"row":${f.row},"status":"met|not_met|blocked","evidence":"<核验依据>"}：记 met 需要独立依据，保留 ${f.status} 时 accepted_deviations 加 accepted 写接受原因，否则记 needs_changes`);
    }
  }

  const key = (d) => `${d.kind}#${d.index}`;
  const expected = new Map(deviations.map((d) => [key(d), d]));
  if (!Array.isArray(review.accepted_deviations)) problems.push('accepted_deviations 必须是数组');
  else {
    const kinds = [...new Set(deviations.map((d) => d.kind))];
    const entries = review.accepted_deviations.map((raw, n) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { problems.push(`accepted_deviations 第 ${n + 1} 项不是对象`); return raw; }
      const d = { ...raw, index: asInt(raw.index) };
      if (d.kind == null && kinds.length === 1) { d.kind = kinds[0]; fixed.push(`accepted_deviations 第 ${n + 1} 项补 kind=${kinds[0]}`); }
      const extra = Object.keys(d).filter((k) => !['kind', 'index', 'evidence'].includes(k));
      if (extra.length) problems.push(`accepted_deviations 第 ${n + 1} 项有多余字段：${extra.join('、')}`);
      if (!nonempty(d.evidence)) problems.push(`accepted_deviations 第 ${n + 1} 项 evidence 为空，需写接受该偏差的依据`);
      return d;
    });
    const known = entries.filter((d) => d && expected.has(key(d)));
    const extras = entries.filter((d) => d && typeof d === 'object' && !expected.has(key(d)));
    const acked = known.map(key);
    const dup = [...new Set(acked.filter((k, i) => acked.indexOf(k) !== i))];
    if (dup.length) problems.push(`accepted_deviations 重复确认：${dup.join('、')}`);
    const missing = deviations.filter((d) => !acked.includes(key(d)));
    if (extras.length && !missing.length) {
      // 已逐项确认全部真实偏差，多出的条目没有可对应的偏差：移出并把原说明保留在 notes。
      review.accepted_deviations = entries.filter((d) => !extras.includes(d));
      review.notes = [review.notes, ...extras.map((d) => `[无对应偏差的确认 ${d.kind ?? '?'}#${d.index ?? '?'}] ${d.evidence ?? ''}`)]
        .filter(nonempty).join('\n');
      fixed.push(`移除 ${extras.length} 条没有对应偏差的 accepted_deviations（说明已并入 notes）`);
    } else {
      review.accepted_deviations = entries;
      if (extras.length) problems.push(`accepted_deviations 中 ${extras.map(key).join('、')} 不存在；可确认的只有 ${[...expected.keys()].join('、') || '（无）'}`);
    }
    if (review.status !== 'needs_changes' && STATUSES.includes(review.status)) {
      for (const d of missing) problems.push(`${review.status} 需要逐项确认偏差 ${key(d)}：「${clip(d.text, 80)}」；在 accepted_deviations 写 {kind:"${d.kind}", index:${d.index}, evidence}，或改记 needs_changes`);
    }
  }

  if (review.blockers !== undefined) {
    if (!Array.isArray(review.blockers)) problems.push('blockers 必须是数组');
    else review.blockers.forEach((b, n) => {
      const bad = !b || typeof b !== 'object' || Object.keys(b).sort().join() !== 'id,kind,message,question,resolution' ||
        !['id', 'kind', 'message', 'question', 'resolution'].every((k) => typeof b[k] === 'string') ||
        !nonempty(b.id) || !nonempty(b.message) || !BLOCKER_KINDS.includes(b.kind) ||
        (['user_input', 'task_conflict'].includes(b.kind) && !nonempty(b.question));
      if (bad) problems.push(`blockers 第 ${n + 1} 项需恰好包含字符串 id、kind(${BLOCKER_KINDS.join('/')})、message、question、resolution；问用户的 kind 必须填 question`);
    });
  }
  if (review.status !== 'needs_changes' && STATUSES.includes(review.status) && Array.isArray(review.criteria)) {
    const open = [...review.criteria, ...(Array.isArray(review.report_rows) ? review.report_rows : [])]
      .filter((c) => c && MARKS.includes(c.status) && c.status !== 'met');
    // accepted_deviations 可以“未满足但接受”：条目保留 not_met/blocked，并在 accepted 写明接受原因。
    const unaccepted = review.status === 'accepted_deviations' ? open.filter((c) => !nonempty(c.accepted)) : open;
    const names = unaccepted.map((c) => `${c.row ? `报告第 ${c.row} 行` : c.index}=${c.status}`).join('、');
    if (unaccepted.length) problems.push(review.status === 'accepted_deviations'
      ? `accepted_deviations 里 ${names} 未满足：核实后改记 met，或保留原状态并在这一条加 accepted 字段写明为什么接受未满足（形如 ${acceptedExample(unaccepted[0])}），或改记 needs_changes`
      : `verified 要求每条验收都 met；${names} 未通过，改记 needs_changes，或改用 accepted_deviations 并给这些条目加 accepted 字段写接受原因（形如 ${acceptedExample(unaccepted[0])}）`);
    if (Array.isArray(review.blockers) && review.blockers.length) problems.push(`${review.status} 不能带活动 blockers；有阻塞请记 needs_changes`);
  }
  // closeoutEvidence：independent 要求独立依据，planner 只拦照抄报告的证据（0.9.103 规则，扩到所有结案结论），off 不查。
  const level = source?.evidenceLevel ?? 'planner';
  const missing = review.status !== 'needs_changes' && STATUSES.includes(review.status) && level !== 'off' ? flaggedMet(review, source, level) : [];
  problems.push(...missing);
  const missingMeasured = ['verified', 'accepted_deviations'].includes(review.status)
    ? mustVerifyCriteria(source).filter(({ index, key }) => Array.isArray(review.criteria) &&
      review.criteria.some(c => c?.index === index && c.status === 'met') && !source.support?.[key]?.includes('must_verify'))
    : [];
  for (const { index } of missingMeasured) {
    problems.push(`验收第 ${index} 条（must_verify）记 met 缺少独立实测依据。先对 ${source.job_id} 派 codex_verify，回查运行证据或实际观测，核验判 met 后再记`);
  }
  const acceptedOpen = [];
  let openUnsupported = 0;
  if (review.status === 'accepted_deviations') {
    const flagged = new Map(flaggedCriteria(source).map(f => [f.key, f]));
    const required = new Set(mustVerifyCriteria(source).map(f => f.key));
    for (const c of [...(Array.isArray(review.criteria) ? review.criteria : []), ...(Array.isArray(review.report_rows) ? review.report_rows : [])]) {
      if (!c || !['blocked', 'not_met'].includes(c.status) || !nonempty(c.accepted) || placeholder(c.accepted)) continue;
      const key = c.row ? `row${c.row}` : String(c.index);
      const kinds = source?.openSupport?.[key] ?? [];
      acceptedOpen.push({ key, ...(c.row ? { row: c.row } : { index: c.index }), status: c.status, support: kinds });
      if (!source?.openLevel || source.openLevel === 'off') continue;
      const flag = flagged.get(key);
      const original = flag?.status ?? reportRowOf(acceptance, source.structured?.criteria, c.index)?.status;
      if (original === 'met' || (!flag && !required.has(key))) continue;
      const strict = source.openLevel === 'strict' && (original === 'not_met' || c.status === 'not_met');
      if (strict ? kinds.some(kind => kind === 'verification' || kind === 'user') : kinds.length) continue;
      openUnsupported++;
      const where = c.row ? `报告第 ${c.row} 行（对不上验收清单）` : `报告第 ${c.index} 条`;
      const running = source.runningVerification ? `核验 ${source.runningVerification} 正在跑，等它结束再记；` : '';
      problems.push(running + `Codex ${where}为 ${original ?? c.status}，accepted_deviations 接受它未满足需要依据（规划端判断不算）：` +
        `① ${deferralPath([source.job_id])}，核验看过这一条后再记；` +
        (strict ? '' : `② codex_continue ${source.job_id} 再试一次这一条；`) +
        '③ 作业结束后用户的确认；④ 改记 needs_changes');
    }
  }
  if (review.status === 'verified') problems.push(...unaddressed(review, source, acceptance));
  // accepted 的占位已在上面单独提示。
  const withoutAccepted = (list) => (Array.isArray(list) ? list.map((c) => (c && typeof c === 'object' ? { ...c, accepted: undefined } : c)) : list);
  if (JSON.stringify([review.status, withoutAccepted(review.criteria), withoutAccepted(review.report_rows), review.accepted_deviations, review.notes]).includes(TODO)) {
    problems.push(`骨架里还有 ${TODO} 占位没有换成你的结论或依据`);
  }
  if (review.status === 'needs_changes' && !deviations.length && Array.isArray(review.criteria) && review.criteria.length &&
      [...review.criteria, ...(Array.isArray(review.report_rows) ? review.report_rows : [])].every((c) => c?.status === 'met') && !(review.blockers ?? []).length) {
    problems.push('所有验收项都 met 且无阻塞、无偏差时不能记 needs_changes：被审对象的缺陷写进 notes 并记 verified；确有执行缺口就把对应条目标 not_met' +
      (extraRows.length ? `（对不上验收清单的报告第 ${extraRows.map((f) => f.row).join('、')} 行在 report_rows 标）` : '') + ' 或加 blocker');
  }
  return { review, fixed, problems, unsupported: (level === 'independent' ? missing.length : 0) + missingMeasured.length,
    inferred, acceptedOpen, openUnsupported };
}

// 报告自标 blocked / not_met、结案结论却记成 met 的条目。independent：需要独立依据（source.support[index]：
// 晚于该轮结束的核验任务判这一条 met、同一单元的后续轮次报告这一条 met，或原会话用户在作业结束后的确认）；
// planner：只要求不照抄报告原文（0.9.103 规则）。规划端自己写的证据不算独立依据。
function flaggedMet(review, source, level) {
  const job = source?.job_id ?? '?';
  return flaggedCriteria(source).flatMap(({ key, index, row, status, evidence }) => {
    const list = row ? review.report_rows : review.criteria;
    const entry = Array.isArray(list) ? list.find((r) => (row ? r?.row === row : r?.index === index)) : undefined;
    if (entry?.status !== 'met' || !nonempty(entry.evidence)) return [];
    const where = row ? `报告第 ${row} 行（对不上验收清单）` : `报告第 ${index} 条`;
    if (level === 'planner') {
      if (entry.evidence.trim() !== String(evidence ?? '').trim()) return [];
      return [`Codex ${where}为 ${status}；${review.status} 需要你在 ${row ? `report_rows row ${row}` : `criteria index ${index}`} 写出自己核实已满足的证据，不能照抄报告原文，否则记 needs_changes`];
    }
    if (source?.support?.[key]?.length) return [];
    return [`Codex ${where}为 ${status}，${review.status} 记成 met 但没有独立依据（规划端自己写的证据不算）。三选一：` +
      `① ${deferralPath([job])}（核验会单列这一条），核验判 met 后再记；` +
      `② codex_continue ${job} 返工这一条；` +
      `③ 这一条保留 ${status}：记 accepted_deviations 并写 accepted 说明为什么接受未满足，或记 needs_changes`];
  });
}

// verified 不能与原报告矛盾：报告的 unresolved 与 blockers 没有专门的条目结构，须在 notes 里逐项用标记说明
// （自标未满足的条目由 flaggedMet 检查，偏差与范围外改动已由 accepted_deviations 覆盖）。
function unaddressed(review, source, acceptance) {
  const report = source?.structured;
  if (!report || typeof report !== 'object' || !Array.isArray(review.criteria)) return [];
  const problems = [];
  const notes = typeof review.notes === 'string' ? review.notes : '';
  (Array.isArray(report.unresolved) ? report.unresolved : []).forEach((u, i) => {
    if (!notes.includes(`unresolved#${i + 1}`)) problems.push(`报告未决项 unresolved#${i + 1}「${clip(u, 80)}」未处理；verified 需在 notes 写「unresolved#${i + 1}: 已解决或不影响验收的依据」，否则记 needs_changes`);
  });
  (Array.isArray(report.blockers) ? report.blockers : []).forEach((b) => {
    const id = b?.id ?? '?';
    if (!notes.includes(`blocker:${id}`)) problems.push(`报告阻塞 blocker:${id}「${clip(b?.message, 80)}」未处理；verified 需在 notes 写「blocker:${id}: 已解除的依据」，否则记 needs_changes`);
  });
  return problems;
}

// 被拒后直接给出可提交的骨架：沿用本次已填好的条目，只把还缺的位置留成占位，规划端改完占位即可一次提交。
export const TODO = '<待填>';
// 由 evidence 推定的 accepted 带这个前缀，记录里能和规划端亲手写的区分开。
export const INFERRED = '（按 evidence 推定）';
export function reviewSkeleton(jobId, source, review = {}) {
  const { acceptance, deviations } = reviewTargets(source);
  const report = source?.structured;
  const status = STATUSES.includes(review.status) ? review.status : TODO;
  const given = new Map((Array.isArray(review.criteria) ? review.criteria : [])
    .filter((c) => c && Number.isInteger(c.index)).map((c) => [c.index, c]));
  // accepted_deviations 里保留 not_met/blocked 的条目带上 accepted：沿用已填的原因，没有就留占位。
  const withAccepted = (entry, c) => (status === 'accepted_deviations' && ['not_met', 'blocked'].includes(entry.status)
    ? { ...entry, accepted: nonempty(c?.accepted) && !placeholder(c.accepted) ? c.accepted : TODO } : entry);
  const criteria = acceptance ? acceptance.map((_a, i) => {
    const c = given.get(i + 1);
    return withAccepted({ index: i + 1, status: MARKS.includes(c?.status) ? c.status : TODO, evidence: nonempty(c?.evidence) ? c.evidence : TODO }, c);
  }) : review.criteria;
  const skeleton = { job_id: jobId, status, criteria };
  const rows = new Map((Array.isArray(review.report_rows) ? review.report_rows : [])
    .filter((r) => r && Number.isInteger(r.row)).map((r) => [r.row, r]));
  const extraRows = flaggedCriteria(source).filter((f) => f.row);
  if (extraRows.length && (status !== 'needs_changes' || rows.size)) skeleton.report_rows = extraRows.map(({ row }) => {
    const r = rows.get(row);
    return withAccepted({ row, status: MARKS.includes(r?.status) ? r.status : TODO, evidence: nonempty(r?.evidence) ? r.evidence : TODO }, r);
  });
  // needs_changes 不需要确认偏差，也不需要逐项说明未决项和阻塞。
  if (status !== 'needs_changes') {
    const acks = new Map((Array.isArray(review.accepted_deviations) ? review.accepted_deviations : [])
      .filter((d) => d && typeof d === 'object').map((d) => [`${d.kind}#${d.index}`, d.evidence]));
    if (deviations.length) skeleton.accepted_deviations = deviations.map((d) =>
      ({ kind: d.kind, index: d.index, evidence: nonempty(acks.get(`${d.kind}#${d.index}`)) ? acks.get(`${d.kind}#${d.index}`) : TODO }));
    const notes = typeof review.notes === 'string' ? review.notes : '';
    const markers = [...(Array.isArray(report?.unresolved) ? report.unresolved : []).map((_u, i) => `unresolved#${i + 1}`),
      ...(Array.isArray(report?.blockers) ? report.blockers : []).map((b) => `blocker:${b?.id ?? '?'}`)];
    const text = [notes, ...markers.filter((m) => !notes.includes(m)).map((m) => `${m}: ${TODO}`)].filter(nonempty).join('\n');
    if (text) skeleton.notes = text;
  } else if (nonempty(review.notes)) skeleton.notes = review.notes;
  return skeleton;
}

export function reviewRejection(jobId, source, { fixed, problems, review }) {
  const { acceptance, deviations } = reviewTargets(source);
  const extraRows = flaggedCriteria(source).filter((f) => f.row);
  const shape = `{job_id:"${jobId}", status:"verified|needs_changes|accepted_deviations", ` +
    `criteria:[${acceptance ? `恰好 ${acceptance.length} 项，index 1..${acceptance.length} 各一次，` : ''}{index, status:"met|not_met|blocked", evidence, accepted?:"accepted_deviations 里保留 not_met/blocked 时写接受原因"}], ` +
    (extraRows.length ? `report_rows:[${rowCounts(source)}，第 ${extraRows.map((f) => `${f.row} 行（${f.status}）`).join('、')}对不上验收清单，` +
      '通过时须逐行记 {row, status:"met|not_met|blocked", evidence, accepted?}], ' : '') +
    `accepted_deviations:[${deviations.length ? `通过时须覆盖 ${deviations.map((d) => `${d.kind}#${d.index}`).join('、')}，` : '本任务没有可确认的偏差，留空；'}{kind:"reported|scope", index, evidence}], ` +
    'notes?:string, blockers?:[{id, kind, message, question, resolution}]}';
  return `codex_review: 未写入核验记录，共 ${problems.length} 处问题，一次改完再提交：\n` +
    problems.map((p, i) => `${i + 1}. ${p}`).join('\n') +
    (fixed.length ? `\n（以下已自动修正，无需再改：${fixed.join('；')}）` : '') +
    `\n应提交的形状：${shape}` +
    (acceptance ? `\n验收清单：${acceptance.map((a, i) => `${i + 1}. ${clip(label(a))}`).join('；')}` : '') +
    `\n可直接修改后提交的骨架（把每个 ${TODO} 换成你的结论或依据；记 needs_changes 时可删去 accepted_deviations 和 notes 里的标记行）：\n` +
    JSON.stringify(reviewSkeleton(jobId, source, review ?? {})) +
    '\n结论和证据由你核验后填写，插件不会代填。';
}

// 后续重开线程靠 parent_job_id 关联，原线程里的 resume 靠 thread_id 关联。
function pendingRework(job, rounds) {
  const ids = new Set([job.job_id]);
  const threads = new Map(job.thread_id ? [[job.thread_id, job.started_at]] : []);
  let latest = job;
  for (const other of rounds) {
    if (other.job_id === job.job_id ||
        !(ids.has(other.parent_job_id) || other.started_at > threads.get(other.thread_id))) continue;
    if (other.execution_status === 'completed' && ['verified', 'accepted_deviations'].includes(other.verification_status)) return null;
    ids.add(other.job_id);
    if (other.thread_id && !threads.has(other.thread_id)) threads.set(other.thread_id, other.started_at);
    latest = other;
  }
  return latest.job_id;
}

// 核验任务的验收记在原任务上。新口径只跟踪本版加载之后记录的 needs_changes。
export function pendingCloseout(jobs, since, reworkSince = Infinity) {
  const unreviewed = [];
  const needsChanges = new Set();
  const rounds = jobs.filter(job => job && !job.context?.verification_of).sort((a, b) => a.started_at - b.started_at);
  for (const job of jobs) {
    if (!job || job.context?.verification_of || !(job.finished_at >= since)) continue;
    if (job.verification_status === 'unreviewed' && job.review_status === 'needs_attention' &&
        ['completed', 'failed'].includes(job.execution_status) && job.report_status === 'valid') unreviewed.push(job.job_id);
    else if (job.verification_status === 'needs_changes') {
      if (job.verification?.time >= reworkSince) {
        const latest = pendingRework(job, rounds);
        if (latest) needsChanges.add(latest);
      } else if (!jobs.some(other => other && other.job_id !== job.job_id &&
          (other.parent_job_id === job.job_id || (job.thread_id && other.thread_id === job.thread_id && other.started_at > job.started_at)))) {
        needsChanges.add(job.job_id);
      }
    }
  }
  return { unreviewed, needsChanges: [...needsChanges] };
}

// 核验中放行：唯一的待验收任务正由它的第一次核验处理（核验在跑，或本次调用用 verify_previous 派核验），且没有别的待收尾任务时，
// 允许派不重叠的新任务。每个任务只放行一次：已有结束的核验就不再放行，核验结束后照常要先验收，所以不能靠连环核验一直拖着不验收。
export function closeoutDeferral(jobs, { unreviewed, needsChanges }, deferFor) {
  if (unreviewed.length !== 1 || needsChanges.some(id => id !== unreviewed[0])) return null;
  const [id] = unreviewed;
  const checks = jobs.filter((job) => job?.context?.verification_of === id);
  if (checks.some((job) => job.execution_status !== 'running')) return null;
  return checks.length ? { job_id: id, via: 'running' } : deferFor === id ? { job_id: id, via: 'verify_previous' } : null;
}
export const deferralPath = (ids) => `先对 ${ids.join('、')} 派 codex_verify（或在下一单上带 verify_previous），核验在跑时可以派不重叠的下一单`;

export function closeoutRefusal(tool, { unreviewed, needsChanges }) {
  if (!unreviewed.length && !needsChanges.length) return '';
  return `${tool}: 本会话还有已结束但未收尾的 Codex 任务，${tool === 'update_goal' ? '会话目标暂不能标记完成' : '未启动新任务'}。` +
    (unreviewed.length ? `报告标出问题却没有验收记录，先用 codex_review 记录：${unreviewed.join('、')}。` : '') +
    (unreviewed.length && tool === 'codex_run' ? `需要核验再记的：${deferralPath(unreviewed)}（同一时间只放行一个待验收任务，每个任务只放行一次）。` : '') +
    (needsChanges.length ? `needs_changes 尚未结案，最新轮次：${needsChanges.join('、')}；用 codex_continue 或带 resume 的 codex_run 返工，` +
      '或核实后用 codex_review 记 accepted_deviations（写明理由）或 verified。' : '') +
    'codex_continue、codex_verify、codex_review、codex_status、codex_output、codex_cancel 仍可使用。';
}

// 截止时间：本机第一次加载带收尾护栏的版本时记下（秒，与 runner 的 finished_at 同单位），之后保持不变；
// 在此之前结束的任务一律不拦。没有目录（测试或非 Windows）时取本次加载时间。
export function closeoutSince(directory, now = Date.now() / 1000, name = 'closeout-since.json') {
  if (!directory) return now;
  const file = path.join(directory, name);
  try {
    const since = JSON.parse(readFileSync(file, 'utf8')).since;
    if (Number.isFinite(since)) return since;
  } catch {}
  try { mkdirSync(directory, { recursive: true }); writeFileSync(file, JSON.stringify({ since: now })); } catch {}
  return now;
}

const placeholder = (v) => typeof v === 'string' && v.trim() === TODO;
const acceptedExample = (c) => `{${c?.row ? `"row":${c.row}` : `"index":${Number.isInteger(c?.index) ? c.index : 1}`},` +
  `"status":"${['not_met', 'blocked'].includes(c?.status) ? c.status : 'blocked'}","evidence":"<核验依据>","accepted":"<为什么接受未满足>"}`;
const rowCounts = (source) => {
  const { acceptance } = reviewTargets(source);
  return `报告 ${(source?.structured ?? source?.report)?.criteria?.length ?? 0} 行、验收 ${acceptance?.length ?? 0} 条`;
};

// 报告行与验收项的对应：条文与某条验收原文一致就按条文；报告行数与验收条数相同时按位置。
// 条数不同时位置不可信（核验报告曾按抽查结论逐行汇报），对不上的行不猜，返回 0。
export function acceptanceIndexOfRow(acceptance, rows, i) {
  if (!Array.isArray(acceptance) || !Array.isArray(rows)) return 0;
  const c = rows[i];
  const hit = acceptance.findIndex((a) => nonempty(c?.criterion) && label(a).trim() === c.criterion.trim());
  return hit >= 0 ? hit + 1 : rows.length === acceptance.length ? i + 1 : 0;
}
// 某条验收（从 1 起）在报告里对应的行；对不上时 undefined。
export const reportRowOf = (acceptance, rows, index) =>
  (Array.isArray(rows) ? rows.find((_c, i) => acceptanceIndexOfRow(acceptance, rows, i) === index) : undefined);

// 原报告自标 blocked / not_met 的条目：能对上验收清单的按验收编号（key 为编号），对不上的按报告行号（row，key 为 row<k>）。
export function flaggedCriteria(source) {
  const { acceptance } = reviewTargets(source);
  const report = source?.structured ?? source?.report;
  const rows = Array.isArray(report?.criteria) ? report.criteria : [];
  return rows.flatMap((c, i) => {
    if (!c || !['not_met', 'blocked'].includes(c.status)) return [];
    const index = acceptance ? acceptanceIndexOfRow(acceptance, rows, i) : i + 1;
    if (!index) return [{ key: `row${i + 1}`, row: i + 1, status: c.status, criterion: c.criterion, evidence: c.evidence }];
    return [{ key: String(index), index, status: c.status, criterion: acceptance ? label(acceptance[index - 1]) : c.criterion, evidence: c.evidence }];
  });
}

// 核验任务为每个自标未满足的原验收项（或对不上验收清单的报告行）单列一条验收，核验报告的这一条就是该项的独立结论。
export const mustVerifyCriteria = ({ context } = {}) => [...new Set(context?.must_verify ?? [])].map(index =>
  ({ index, key: String(index), criterion: context.acceptance[index - 1], mustVerify: true }));

export const verifyCriterionItem = ({ index, row, status, criterion, mustVerify }) =>
  `${row ? `原报告第 ${row} 行（原报告标 ${status}，未对上原验收清单）`
    : `原验收第 ${index} 条（${mustVerify ? '必须实测' : `原报告标 ${status}`}）`}：${String(criterion ?? '').trim()}` +
  '——独立核实现在是否满足：满足记 met，不满足记 not_met，无法核实记 blocked，evidence 写出处。';
export const VERIFY_ITEM = /^原验收第 (\d+) 条（(?:原报告标 |必须实测）)/;
export const VERIFY_ROW = /^原报告第 (\d+) 行（原报告标 /;
export function verificationItemKey(item) {
  const index = VERIFY_ITEM.exec(item);
  if (index) return index[1];
  const row = VERIFY_ROW.exec(item);
  return row ? `row${row[1]}` : undefined;
}
