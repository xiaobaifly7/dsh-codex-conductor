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
  if (review.status === 'needs_changes' && !deviations.length && Array.isArray(review.criteria) && review.criteria.length &&
      review.criteria.every((c) => c?.status === 'met') && !(review.blockers ?? []).length) {
    problems.push('所有验收项都 met 且无阻塞、无偏差时不能记 needs_changes：被审对象的缺陷写进 notes 并记 verified；确有执行缺口就把对应条目标 not_met 或加 blocker');
  }
  return { review, fixed, problems };
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
