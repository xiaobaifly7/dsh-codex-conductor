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
  for (const key of ['criteria', 'accepted_deviations', 'blockers']) {
    if (typeof review[key] === 'string' && Array.isArray(asArray(review[key]))) { review[key] = asArray(review[key]); fixed.push(`${key} 由字符串解析为数组`); }
  }
  const unknown = Object.keys(review).filter((k) => !['status', 'criteria', 'notes', 'accepted_deviations', 'blockers'].includes(k));
  if (unknown.length) problems.push(`不认识的字段：${unknown.join('、')}（只接受 job_id、status、criteria、notes、accepted_deviations、blockers）`);
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
        else if (byOrder) { c.index = n + 1; fixed.push(`criteria 第 ${n + 1} 项按顺序补 index ${n + 1}`); }
      }
      const extra = Object.keys(c).filter((k) => !['index', 'status', 'evidence'].includes(k));
      if (extra.length) problems.push(`criteria 第 ${n + 1} 项有多余字段：${extra.join('、')}`);
      if (!Number.isInteger(c.index)) problems.push(`criteria 第 ${n + 1} 项缺少整数 index（从 1 开始，对应验收标准序号）`);
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
    const open = review.criteria.filter((c) => c && MARKS.includes(c.status) && c.status !== 'met');
    if (open.length) problems.push(`${review.status} 要求每条验收都 met；${open.map((c) => `${c.index}=${c.status}`).join('、')} 未通过，改记 needs_changes，或核实后给出 met 的证据`);
    if (Array.isArray(review.blockers) && review.blockers.length) problems.push(`${review.status} 不能带活动 blockers；有阻塞请记 needs_changes`);
  }
  if (review.status === 'verified') problems.push(...unaddressed(review, source, acceptance));
  if (review.status === 'needs_changes' && !deviations.length && Array.isArray(review.criteria) && review.criteria.length &&
      review.criteria.every((c) => c?.status === 'met') && !(review.blockers ?? []).length) {
    problems.push('所有验收项都 met 且无阻塞、无偏差时不能记 needs_changes：被审对象的缺陷写进 notes 并记 verified；确有执行缺口就把对应条目标 not_met 或加 blocker');
  }
  return { review, fixed, problems };
}

// verified 不能与原报告矛盾：报告自标未满足/阻塞的验收项要有规划端自己的核验证据（不能照抄 Codex 的 evidence），
// 报告的 unresolved 与 blockers 没有专门的条目结构，须在 notes 里逐项用标记说明（偏差与范围外改动已由 accepted_deviations 覆盖）。
function unaddressed(review, source, acceptance) {
  const report = source?.structured;
  if (!report || typeof report !== 'object' || !Array.isArray(review.criteria)) return [];
  const problems = [];
  (Array.isArray(report.criteria) ? report.criteria : []).forEach((c, i) => {
    if (!c || !['not_met', 'blocked'].includes(c.status)) return;
    const hit = acceptance?.findIndex((a) => nonempty(c.criterion) && label(a).trim() === c.criterion.trim());
    const index = hit >= 0 ? hit + 1 : i + 1;
    const entry = review.criteria.find((r) => r?.index === index);
    // 缺项或未 met 已由上面的覆盖与通过检查报告，这里只拦照抄报告证据的 met。
    if (entry?.status !== 'met' || !nonempty(entry.evidence) || entry.evidence.trim() !== String(c.evidence ?? '').trim()) return;
    problems.push(`Codex 报告第 ${index} 条为 ${c.status}；verified 需要你在 criteria index ${index} 写出自己核实已满足的证据，不能照抄报告原文，否则记 needs_changes`);
  });
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

export function reviewRejection(jobId, source, { fixed, problems }) {
  const { acceptance, deviations } = reviewTargets(source);
  const shape = `{job_id:"${jobId}", status:"verified|needs_changes|accepted_deviations", ` +
    `criteria:[${acceptance ? `恰好 ${acceptance.length} 项，index 1..${acceptance.length} 各一次，` : ''}{index, status:"met|not_met|blocked", evidence}], ` +
    `accepted_deviations:[${deviations.length ? `通过时须覆盖 ${deviations.map((d) => `${d.kind}#${d.index}`).join('、')}，` : '本任务没有可确认的偏差，留空；'}{kind:"reported|scope", index, evidence}], ` +
    'notes?:string, blockers?:[{id, kind, message, question, resolution}]}';
  return `codex_review: 未写入核验记录，共 ${problems.length} 处问题，一次改完再提交：\n` +
    problems.map((p, i) => `${i + 1}. ${p}`).join('\n') +
    (fixed.length ? `\n（以下已自动修正，无需再改：${fixed.join('；')}）` : '') +
    `\n应提交的形状：${shape}\n结论和证据由你核验后填写，插件不会代填。`;
}

// 收尾护栏：本会话已结束、报告有标记却没有 codex_review 的任务，以及 needs_changes 后既无后续轮次也无新核验的任务。
// 核验任务（verification_of）的验收记在原任务上；取消、无有效报告的失败和截止时间之前结束的任务都不拦。
export function pendingCloseout(jobs, since) {
  const unreviewed = [];
  const needsChanges = [];
  for (const job of jobs) {
    if (!job || job.context?.verification_of || !(job.finished_at >= since)) continue;
    if (job.verification_status === 'unreviewed' && job.review_status === 'needs_attention' &&
        ['completed', 'failed'].includes(job.execution_status) && job.report_status === 'valid') unreviewed.push(job.job_id);
    else if (job.verification_status === 'needs_changes' && !jobs.some((other) => other && other.job_id !== job.job_id &&
        (other.parent_job_id === job.job_id || (job.thread_id && other.thread_id === job.thread_id && other.started_at > job.started_at)))) {
      needsChanges.push(job.job_id);
    }
  }
  return { unreviewed, needsChanges };
}

export function closeoutRefusal(tool, { unreviewed, needsChanges }) {
  if (!unreviewed.length && !needsChanges.length) return '';
  return `${tool}: 本会话还有已结束但未收尾的 Codex 任务，${tool === 'update_goal' ? '会话目标暂不能标记完成' : '未启动新任务'}。` +
    (unreviewed.length ? `报告标出问题却没有验收记录，先用 codex_review 记录：${unreviewed.join('、')}。` : '') +
    (needsChanges.length ? `已记 needs_changes 但没有后续轮次：${needsChanges.join('、')}；用 codex_continue 或带 resume 的 codex_run 返工，` +
      '或核实后用 codex_review 记 accepted_deviations（写明理由）或 verified。' : '') +
    'codex_continue、codex_verify、codex_review、codex_status、codex_output、codex_cancel 仍可使用。';
}

// 截止时间：本机第一次加载带收尾护栏的版本时记下（秒，与 runner 的 finished_at 同单位），之后保持不变；
// 在此之前结束的任务一律不拦。没有目录（测试或非 Windows）时取本次加载时间。
export function closeoutSince(directory, now = Date.now() / 1000) {
  if (!directory) return now;
  const file = path.join(directory, 'closeout-since.json');
  try {
    const since = JSON.parse(readFileSync(file, 'utf8')).since;
    if (Number.isFinite(since)) return since;
  } catch {}
  try { mkdirSync(directory, { recursive: true }); writeFileSync(file, JSON.stringify({ since: now })); } catch {}
  return now;
}
