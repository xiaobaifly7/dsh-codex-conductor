// 会话交接：后继会话继承前任会话的 Codex 任务归属。别名只由本机请求文件建立，不向模型开放。
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const validSessionId = (id) => typeof id === 'string' && id.length >= 1 && id.length <= 100 && !/[^A-Za-z0-9_-]/.test(id);

export function writeTextAtomic(file, text) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, text);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export const writeJsonAtomic = (file, value) => writeTextAtomic(file, JSON.stringify(value, null, 2) + '\n');

// 交接请求的发起来源；外部直接写请求文件、没带来源时记为 file。
export const ORIGINS = ['panel', 'auto', 'confirm', 'tool', 'file'];
const LINKS_UNREADABLE = '交接链接状态不可读，暂停自动交接。';

// 发布一份 handover-request.json；上一份还没被认领时拒绝，不覆盖。面板和自动交接共用。
export function submitHandoverRequest(directory, request) {
  const target = path.join(directory, 'handover-request.json');
  if (fs.existsSync(target)) throw Object.assign(new Error('a previous hand-over request is still pending'), { code: 'pending' });
  fs.mkdirSync(directory, { recursive: true });
  writeTextAtomic(target, JSON.stringify(request));
}

// handover-history.jsonl：每次交接、认领、撤回一行（不含交接单正文），只保留最近 200 行。
export function appendHandoverHistory(directory, entry, keep = 200) {
  const file = path.join(directory, 'handover-history.jsonl');
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  lines.push(JSON.stringify(entry));
  writeTextAtomic(file, lines.slice(-keep).join('\n') + '\n');
}

export function readHandoverHistory(directory, limit = 20) {
  try {
    return fs.readFileSync(path.join(directory, 'handover-history.jsonl'), 'utf8').split('\n').filter(Boolean).slice(-limit)
      .flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  } catch { return []; }
}

// 会话日志里的消息数和回合数（turn/start 个数）；交接时记下继任会话的基数，撤回时据此判断它是否已经开工。
export function logCounts(log) {
  let messages = 0, turns = 0;
  for (const event of Array.isArray(log) ? log : []) {
    if (MESSAGE_TYPES.has(event?.type)) messages++;
    else if (event?.type === 'turn/start') turns++;
  }
  return { messages, turns };
}

// handover.json：{ links: { "<后继>": { from: "<前任>", at, origin, requestedAt, toMessages, toTurns, ... } } }。每个前任最多一个后继，可成链 A→B→C。
// 每次读文件而不缓存：热重载后的新实例和请求处理看到的是同一份记录，文件很小。
export function createAliases(directory) {
  const file = directory && path.join(directory, 'handover.json');
  const read = () => {
    if (!file) return null;
    try {
      const links = JSON.parse(fs.readFileSync(file, 'utf8')).links;
      return links && typeof links === 'object' && !Array.isArray(links) ? links : null;
    } catch { return null; }
  };
  const predecessors = (id, links = read() ?? {}) => {
    const chain = [];
    for (let current = id; links[current] && validSessionId(links[current].from) && !chain.includes(links[current].from) &&
      links[current].from !== id;) chain.push(current = links[current].from);
    return chain;
  };
  const successor = (id, links = read() ?? {}) => Object.keys(links).find((to) => links[to]?.from === id);
  return {
    file,
    predecessors: (id, links) => (validSessionId(id) ? predecessors(id, links) : []),
    owners: (id) => (validSessionId(id) ? [id, ...predecessors(id)] : []),
    successor: (id, links) => (validSessionId(id) ? successor(id, links) : undefined),
    links: (fallback = {}) => read() ?? fallback,
    link(from, to, extra = {}) {
      if (!file) throw new Error('no local state directory');
      if (!validSessionId(from) || !validSessionId(to) || from === to) throw new Error('invalid session ids');
      const storedLinks = read();
      if (storedLinks === null && extra.origin === 'auto') throw new Error(LINKS_UNREADABLE);
      const links = storedLinks ?? {};
      if (links[to]) throw new Error(`${to} already took over ${links[to].from}`);
      const taken = successor(from, links);
      if (taken) throw new Error(`${from} was already handed over to ${taken}`);
      if (predecessors(from, links).includes(to)) throw new Error(`${to} is a predecessor of ${from}`);
      fs.mkdirSync(directory, { recursive: true });
      writeJsonAtomic(file, { links: { ...links, [to]: { from, at: new Date().toISOString(), ...extra } } });
    },
    // 交接完成后补记投递和自动续接的结果。
    annotate(to, fields) {
      const links = read() ?? {};
      if (!links[to]) return;
      links[to] = { ...links[to], ...fields };
      writeJsonAtomic(file, { links });
    },
    unlink(from, to) {
      const links = read() ?? {};
      if (links[to]?.from !== from) throw new Error(`${to} did not take over ${from}`);
      const removed = links[to];
      delete links[to];
      writeJsonAtomic(file, { links });
      return removed;
    },
  };
}

// handover-request.json：{sessionId, note?, force?} 新建后继会话；{adopt: {from, to}, note?, force?} 接管已建好的会话；
// {revert: {from, to}} 撤销一次交接。
export function validateHandoverRequest(input) {
  const pair = (value) => value && typeof value === 'object' && !Array.isArray(value) &&
    validSessionId(value.from) && validSessionId(value.to) && value.from !== value.to;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('request must be an object');
  const modes = ['sessionId', 'adopt', 'revert'].filter((key) => input[key] !== undefined);
  if (modes.length !== 1) throw new Error('give exactly one of sessionId, adopt or revert');
  if (input.sessionId !== undefined && !validSessionId(input.sessionId)) throw new Error('sessionId must match [A-Za-z0-9_-]{1,100}');
  if ((input.adopt !== undefined && !pair(input.adopt)) || (input.revert !== undefined && !pair(input.revert))) {
    throw new Error('adopt and revert need two different valid session ids in from and to');
  }
  if (input.note !== undefined && (typeof input.note !== 'string' || [...input.note].length > 4000)) throw new Error('note must be a string of at most 4000 characters');
  if (input.force !== undefined && typeof input.force !== 'boolean') throw new Error('force must be a boolean');
  if (input.origin !== undefined && !ORIGINS.includes(input.origin)) throw new Error(`origin must be one of ${ORIGINS.join(', ')}`);
  if (input.requestedAt !== undefined && (typeof input.requestedAt !== 'string' || input.requestedAt.length > 40 || !Number.isFinite(Date.parse(input.requestedAt)))) {
    throw new Error('requestedAt must be an ISO time');
  }
  const meta = { origin: input.origin ?? 'file', ...(input.requestedAt ? { requestedAt: input.requestedAt } : {}), force: input.force === true };
  return input.revert ? { revert: input.revert, ...meta } : {
    from: input.sessionId ?? input.adopt.from, to: input.adopt?.to, note: input.note ?? '', ...meta };
}

const firstLine = (value, size = 80) => String(value ?? '').split('\n')[0].trim().slice(0, size);
const clip = (value, size) => { const text = String(value ?? '').trim(); return text.length > size ? `${text.slice(0, size)}…` : text; };
const textOf = (content) => (Array.isArray(content) ? content : []).filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
const timeOf = (event) => { const t = event?.time ?? event?.at; return Number.isFinite(t) ? new Date(t).toISOString() : typeof t === 'string' ? t : '时间未知'; };

// 整张交接单的字符上限；超出时先把任务表缩成要紧的几单，再按优先级从低到高整节省略（下一步、待收尾永不省略）。
export const BRIEF_LIMIT = 16_000;
// 近期摘要沿用对自动续接等固定话术的筛选，完整档案以来源标记为准。
const AUTOMATED_USER_TEXT = /^\s*(?:\[codex-conductor|(?:继续|continue|продолжай)(?:[\s。.!！,，;；:：]|$)|[（(](?:上一步工具|检测到你可能陷入循环))/i;

function humanInstruction(event) {
  if (event?.type !== 'user/message' || event.data?.source?.kind !== 'user') return;
  if (event.data.source.via === 'codex-conductor') return;
  const text = textOf(event.data.content);
  if (text.trim()) return { text, at: timeOf(event) };
}

// 从旧会话的内存日志里倒着找最近的人工指令和最后一个正常结束回合的小结；超过 deadlineMs 就放弃这两节。
export function sessionContext(log, { autoMessage, now = Date.now, deadlineMs = 10_000 } = {}) {
  const events = Array.isArray(log) ? log : [];
  const deadline = now() + deadlineMs;
  const instructions = [];
  let lastTurn, completedTurn, progress;
  for (let i = events.length - 1; i >= 0; i--) {
    if (i % 500 === 0 && now() > deadline) return { timedOut: true };
    const event = events[i];
    if (event?.type === 'turn/end') {
      lastTurn ??= { reason: event.data?.reason?.kind ?? '未知', at: timeOf(event) };
      if (completedTurn === undefined && event.data?.reason?.kind === 'completed') completedTurn = event.data?.turn;
    } else if (event?.type === 'assistant/message' && completedTurn !== undefined && !progress && event.data?.turn === completedTurn) {
      const text = textOf(event.data?.message?.content).trim();
      if (text) progress = { text: clip(text, 1500), at: timeOf(event) };
    } else if (instructions.length < 12) {
      const item = humanInstruction(event);
      if (item && item.text.trim() !== autoMessage && !AUTOMATED_USER_TEXT.test(item.text)) {
        instructions.push({ ...item, text: clip(item.text, 600) });
      }
    }
    if (instructions.length >= 12 && lastTurn && progress) break;
  }
  return { instructions, lastTurn, progress };
}

export function instructionArchivePath(directory, root) {
  // 保留小写 UUID 的旧路径，其他 ID 用独立的文件名空间，避免 Windows 折叠大小写。
  const id = /^(?:session-)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(root) ? root : `id-${hash(root)}`;
  return path.resolve(directory, 'handovers', `instructions-${id}.json`);
}

function readInstructions(file) {
  const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(entries)) throw new Error('invalid instruction archive');
  return entries;
}

async function archiveInstructions({ directory, aliases, from, agentA, agentOf }) {
  const links = aliases.links();
  const predecessors = aliases.predecessors(from, links);
  const root = predecessors.at(-1) ?? from;
  const file = instructionArchivePath(directory, root);
  const previous = links[from]?.instructions;
  let entries;
  if (previous?.root === root) {
    try { entries = readInstructions(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const append = (agent) => {
    if (!Array.isArray(agent.session?.log)) throw new Error(`session log unavailable: ${agent.id}`);
    for (const event of agent.session.log) {
      const item = humanInstruction(event);
      if (item) entries.push(item);
    }
  };
  // 旧链接、写入失败或撤回后，从仍相连的前任回填，避免重复追加同一来源。
  if (!entries || previous.count !== entries.length) {
    entries = [];
    for (const id of predecessors.reverse()) append(await agentOf(id));
  }
  append(agentA);
  entries.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, entries);
  return { root, file, count: entries.length, first: entries[0]?.at ?? null, last: entries.at(-1)?.at ?? null };
}

// 按优先顺序（最要紧的在前）放进 cap 字符以内，至少放一条。
function fit(items, cap) {
  const kept = [];
  let used = 0;
  for (const item of items) {
    if (kept.length && used + item.length + 1 > cap) break;
    kept.push(item);
    used += item.length + 1;
  }
  return kept;
}
const truncated = (total, shown) => (shown < total ? [`（已截断，共 ${total} 条，显示最近 ${shown} 条）`] : []);

// 交接单只用插件和 runner 已有的记录、旧会话日志机械生成，不经模型。
export function buildBrief({ from, to, at, cwd, goal, jobs, pending, since, note, origin = 'file', requestedAt = at, autoContinue,
  successorGoal, context, instructionArchive, instructionError, sessionRead = false, limit = BRIEF_LIMIT }) {
  const running = jobs.filter((j) => (j.execution_status ?? j.status) === 'running');
  const open = (j) => (j.execution_status ?? j.status) === 'running' || pending.unreviewed.includes(j.job_id) || pending.needsChanges.includes(j.job_id);
  // 表里只放任务号（job_id）：续接、核验、验收都靠它。线程号只列给需要带 resume 返工的任务，免得被当成任务号。
  const row = (j) => `| ${j.job_id} | ${j.execution_status ?? j.status ?? '?'} | ${j.verification_status ?? '?'} | ` +
    `${j.review_status === 'needs_attention' ? '有标记' : '-'} | ${j.parent_job_id ?? '-'} | ${j.cwd ?? '-'} | ` +
    `${j.diff_status ?? '-'} | ${firstLine(j.context?.task).replace(/\|/g, '/')} |`;
  const threads = jobs.filter((j) => pending.needsChanges.includes(j.job_id) && j.thread_id);
  const taskSection = (compact) => {
    // jobs 按开始时间从新到旧；紧张时只留未结束、待验收、需修改的任务和最近 10 单。
    const chosen = compact ? jobs.filter((j, i) => i < 10 || open(j)) : jobs;
    const rows = fit(chosen.map(row), 8000);
    return [`## 任务（收尾截止时间 ${new Date(since * 1000).toISOString()} 之后开始，共 ${jobs.length} 单）`, '',
      '任务号（job_id）用于 codex_status、codex_output、codex_review、codex_verify、codex_continue 的 job_id 参数。', '',
      '| 任务号 job_id | 执行 | 验收 | 报告 | 续接自（任务号） | 目录 | diff | 任务首行 |', '|---|---|---|---|---|---|---|---|',
      ...rows, ...truncated(jobs.length, rows.length),
      ...(threads.length ? ['', '### 返工用的线程号', '线程号（thread_id）不是任务号，只用于 codex_run 的 resume 参数；不要传给其他工具的 job_id。', '',
        ...threads.map((j) => `- 任务 ${j.job_id} 的线程号：${j.thread_id}`)] : [])].join('\n');
  };
  const rounds = Number.isSafeInteger(goal?.maxGoalRounds) ? Math.max(1, goal.maxGoalRounds - (goal.roundsStarted ?? 0)) : undefined;
  const hasGoal = goal && goal.phase !== 'complete' && typeof goal.objective === 'string';
  const goalSection = !hasGoal ? ['## 目标', '原会话没有进行中的目标。'] : ['## 目标',
    successorGoal === 'exists' ? '- 本会话已有自己的目标，没有用原会话的目标覆盖；以 get_goal 返回的为准。'
      : `- 目标已在本会话逐字重建${rounds ? `，上限 ${rounds} 轮` : ''}（原会话状态 ${goal.phase}，已用 ${goal.roundsStarted ?? '?'} / ${goal.maxGoalRounds ?? '?'} 轮）；以 get_goal 返回的为准。`,
    `- 目标开头：${clip(goal.objective, 200)}`];
  const instructions = context?.instructions ?? [];
  const items = fit(instructions.map((m) => `- ${m.at}：${m.text.replace(/\n/g, '\n  ')}`), 8000);
  const sections = [
    { priority: 1, title: '下一步', lines: ['## 下一步', note ? note : '未指定；按目标继续，先完成“待收尾”。'] },
    { priority: 2, title: '目标', lines: goalSection },
    ...(context && !context.timedOut ? [
      { priority: 3, title: '最近的用户指令', lines: ['## 最近的用户指令（旧会话里人工输入的消息，最近的在前）',
        '以下是用户亲手输入的要求，仍然有效，除非与“下一步”或更新的指令冲突。',
        ...(items.length ? [...items, ...truncated(instructions.length, items.length)] : ['（没有找到）'])] },
      ...(context.progress || context.lastTurn ? [{ priority: 4, title: '旧会话最后的进展', lines: ['## 旧会话最后的进展',
        ...(context.lastTurn ? [`- 最后一个回合：结束原因 ${context.lastTurn.reason}，${context.lastTurn.at}`] : []),
        ...(context.progress ? [`- 最后一个正常结束回合的助手回复（${context.progress.at}，前 1500 字符）：`, '', context.progress.text] : [])] }] : []),
    ] : []),
    // 待收尾很短却是接手时最要紧的，与“下一步”同为 1，永不省略。
    { priority: 1, title: '待收尾', lines: ['## 待收尾',
      `- 报告有标记、尚未 codex_review：${fit(pending.unreviewed, 1000).join('、') || '无'}`,
      `- needs_changes 尚未结案，最新轮次：${fit(pending.needsChanges, 1000).join('、') || '无'}`,
      ...(running.length ? ['- 仍在运行（这些任务随交接转给本会话：用 codex_status 等待并验收，不要重派；结束通知会转到本会话）：',
        ...running.map((j) => `  - ${j.job_id}：${firstLine(j.context?.task, 60).replace(/\|/g, '/') || '（无标题）'}` +
          `${Number.isFinite(j.started_at) ? `（已运行 ${Math.max(0, Math.round((Date.parse(at) / 1000 - j.started_at) / 60))} 分钟）` : ''}`)]
        : ['- 仍在运行：无'])] },
    { priority: 5.5, title: '任务', key: 'tasks', lines: [taskSection(false)] },
    { priority: 6, title: '如何回看旧会话', lines: ['## 如何回看旧会话', `- 旧会话 ID：${from}（已冻结，只能查看）`,
      ...(sessionRead ? [`- 用 session_read 回查：session_read(sessionId="${from}", mode="summary") 看结构化摘要；mode="search" 加 query 搜关键词；mode="tail" 看最后若干事件。`] : []),
      '- 历史任务报告：codex_summary（session_id="current"）看总览，codex_output（job_id=任务号）看单个任务的报告。'] },
    { priority: 7, title: '接手须知', lines: ['## 接手须知',
      '- 先用 get_goal、codex_jobs（session_id="current"）核对现状；',
      '- 先处理“待收尾”里的待验收 / 需修改任务；',
      '- 已完成的任务不要重派；要改动时优先续接原任务而不是新开；',
      '- 有“下一步”时直接按它推进，不要为确认方向而向用户提问；只有遇到交接单和目标都没有覆盖、且会实质影响结果的取舍时才提问；',
      '- 旧会话已冻结，不要尝试在旧会话里操作。'] },
  ];
  const header = (omitted) => [`# Codex 指挥交接单：${from} → ${to}`, '',
    `- 生成时间：${at}`, `- 发起来源：${origin}（请求时间 ${requestedAt}）`, `- 工作目录：${cwd ?? '（未知）'}`,
    ...(instructionArchive ? [`- 完整用户指令档案：${instructionArchive.file}，共 ${instructionArchive.count} 条，时间范围 ${instructionArchive.count ? `${instructionArchive.first} 至 ${instructionArchive.last}` : '无'}。早于最近 12 条的指令仍然有效，需要时读取该文件。`] : []),
    ...(instructionError ? [`- 完整用户指令档案未能保存（${instructionError}）。`] : []),
    ...(autoContinue === 'manual_required' ? [`- 请操作员在界面把原会话 ${from} 的“自动继续”开关关掉（插件无法替你关闭），免得它被自动续接继续推进。`] : []),
    ...(context?.timedOut ? ['- 读取旧会话日志超时，省略了“最近的用户指令”和“旧会话最后的进展”。'] : []),
    ...(omitted.length ? [`- 本单超过 ${limit} 字符，省略了：${omitted.join('、')}。`] : [])].join('\n');
  const render = (list, omitted) => [header(omitted), ...list.map((s) => s.lines.join('\n'))].join('\n\n') + '\n';
  let kept = sections;
  let text = render(kept, []);
  if (text.length > limit) {
    kept = kept.map((s) => (s.key === 'tasks' ? { ...s, lines: [taskSection(true)] } : s));
    text = render(kept, []);
  }
  const omitted = [];
  while (text.length > limit && kept.some((s) => s.priority > 1)) {
    const lowest = kept.reduce((a, b) => (b.priority > a.priority ? b : a));
    omitted.push(lowest.title);
    kept = kept.filter((s) => s !== lowest);
    text = render(kept, omitted);
  }
  return text;
}

// loopx：原会话由 LoopX 续跑、绑定已挪到本会话时传入。消息以 /loopx 开头，宿主把它当作 loopx 技能调用，LoopX 由此在本会话接着续跑。
const handoverMessage = (from, briefPath, brief, loopx) =>
  (loopx ? `/loopx 这是会话交接后的续接，不是新任务：原会话 ${from} 的 LoopX 绑定（goal ${loopx.goalId}，agent ${loopx.agentId}）已挪到本会话。` +
    '不要新建 LoopX 目标，也不要创建原生目标；先用 resolve-agent-thread 核对本会话的绑定。\n' : '') +
  `[codex-conductor 交接] 本会话接手会话 ${from} 的工作；原会话的目标已暂停，` +
  '它不能再派活或验收。下面是插件按记录生成的交接单' + (briefPath ? `（文件：${briefPath}）` : '') + '。\n' +
  '先调 codex_summary（session_id="current"）和 codex_jobs 看详情：本会话现在可以查看、验收、续接、核验和取消原会话的任务。' +
  '工具的 job_id 参数只填交接单里的任务号；线程号只用于 codex_run 的 resume。' +
  '收尾规则照旧：先给列出的待收尾任务做 codex_review 或返工，再派新任务。' +
  (loopx ? '本轮只核对绑定、读完交接单并处理待收尾任务，然后结束；之后由 LoopX 按待办续跑。' : '本会话若还没有目标，按交接单里的目标创建后继续推进。') +
  '\n\n' + brief;

// LoopX 跟随交接：原会话最近由 LoopX 续跑（而不是原生目标循环）时，把它的线程绑定挪给继任会话。
// loopx(args, cwd) 运行 LoopX CLI 并返回解析后的 JSON，失败时抛出。这里的任何失败都只记在步骤里，不影响交接。
const LOOPX_HOST = 'deepseek-harness-native';
export function loopxDriven(log) {
  for (let i = (log?.length ?? 0) - 1; i >= 0; i--) {
    const kind = log[i]?.type === 'user/message' ? log[i].data?.source?.kind : undefined;
    if (kind === 'loopx-continuation') return true;
    if (kind === 'goal') return false;
  }
  return false;
}

export async function moveLoopxBinding(loopx, cwd, from, to) {
  const thread = (id) => ['--host-surface', LOOPX_HOST, '--thread-id', id];
  const run = async (args) => {
    const value = await loopx(args, cwd);
    if (value?.ok !== true) throw new Error(`loopx ${args[0]} refused`);
    return value;
  };
  try {
    if (!cwd) return { loopx: 'unbound' };
    const bound = await run(['resolve-agent-thread', ...thread(from)]);
    if (bound.status !== 'bound' || typeof bound.goal_id !== 'string' || typeof bound.agent_id !== 'string') return { loopx: 'unbound' };
    const pair = ['--goal-id', bound.goal_id, '--agent-id', bound.agent_id];
    await run(['unbind-agent-thread', ...pair, ...thread(from), '--execute']);
    try { await run(['bind-agent-thread', ...pair, ...thread(to), '--execute']); }
    catch (error) {
      // 没绑上目标会话：把绑定还回去，不留一个两边都没绑的 LoopX 目标。
      await run(['bind-agent-thread', ...pair, ...thread(from), '--execute']).catch(() => {});
      throw error;
    }
    return { loopx: 'moved', goalId: bound.goal_id, agentId: bound.agent_id };
  } catch (error) { return { loopx: `failed:${error?.message ?? error}` }; }
}

// 首条消息走 sessionController.prompt（与界面发送相同的路径）；它可能等到整轮结束才返回，8 秒内没回执就当作已投递。
async function deliver(controller, sessionId, text, waitMs) {
  try {
    const call = controller.prompt({ requestId: `handover-${randomUUID()}`, sessionId, mode: 'queue', content: [{ type: 'text', text }] },
      new AbortController().signal);
    call.catch(() => {});
    let timer;
    const outcome = await Promise.race([call.then(() => 'prompted', (error) => ({ error })),
      new Promise((resolve) => { timer = setTimeout(() => resolve('prompt_pending'), waitMs); })]);
    clearTimeout(timer);
    return typeof outcome === 'string' ? { delivered: outcome } : { delivered: 'failed', deliverError: String(outcome.error?.message ?? outcome.error) };
  } catch (error) {
    return { delivered: 'failed', deliverError: String(error?.message ?? error) };
  }
}

// 可选集成 dsh-client-auto-continue：autoContinue(sessionId) 返回 undefined（没装）或 { previous, setMode? }；
// previous 是 sessionModes 里该会话原来的值，没有这个键时为 null。setMode(null) 删除这个键。失败不影响交接。
export async function disableAutoContinue(probe, sessionId) {
  let state;
  try { state = await probe?.(sessionId); } catch (error) { return { autoContinue: `failed:${error?.message ?? error}` }; }
  if (!state) return { autoContinue: 'not_installed' };
  if (state.previous === 'off') return { autoContinue: 'already_off' };
  if (typeof state.setMode !== 'function') return { autoContinue: 'manual_required' };
  try {
    await state.setMode('off');
    return { autoContinue: 'disabled', previous: state.previous ?? null };
  } catch (error) { return { autoContinue: `failed:${error?.message ?? error}` }; }
}

export async function restoreAutoContinue(probe, sessionId, previous) {
  let state;
  try { state = await probe?.(sessionId); } catch (error) { return `failed:${error?.message ?? error}`; }
  if (!state) return 'not_installed';
  if ((state.previous ?? null) === previous) return 'restored';
  if (typeof state.setMode !== 'function') return 'manual_required';
  try {
    await state.setMode(previous);
    return 'restored';
  } catch (error) { return `failed:${error?.message ?? error}`; }
}

// 宿主设置服务里 auto-continue 这一项（该插件的 profile 条目 id 和它自己开关写入时用的名字都是 auto-continue）。
// 只读写 sessionModes 下这一个会话的键，与该插件自己的“设置会话模式”按钮走同一个 settings.mutate。
export const AUTO_CONTINUE_ENTRY = 'auto-continue';
export function autoContinueFromSettings(settings) {
  return (sessionId) => {
    const entry = settings?.describe?.().find((form) => form.ns === AUTO_CONTINUE_ENTRY);
    if (!entry) return undefined;
    const modes = entry.value?.sessionModes;
    const previous = modes && typeof modes === 'object' && Object.hasOwn(modes, sessionId) ? modes[sessionId] : null;
    const writable = settings.writable !== false && typeof settings.mutate === 'function';
    return { previous, ...(writable ? { setMode: (mode) => settings.mutate(AUTO_CONTINUE_ENTRY, [mode === null
      ? { op: 'unset', path: ['sessionModes', sessionId] } : { op: 'set', path: ['sessionModes', sessionId], value: mode }]) } : {}) };
  };
}

const hash = (text) => createHash('sha256').update(String(text)).digest('hex');
// 会话设置在日志里是这些事件，取各自最后一条比较；时间、序号这类每个会话不同的字段不比。
const SETTING_EVENTS = { agentPreset: 'agent-preset/selected', model: 'model/selection', permission: 'permission/preset',
  sandbox: 'sandbox/mode', approval: 'approval/policy' };
const VOLATILE = new Set(['turn', 'time', 'at', 'seq', 'id']);
const settingsOf = (agent) => {
  const log = Array.isArray(agent?.session?.log) ? agent.session.log : [];
  const header = agent?.session?.header ?? {};
  const value = { cwd: header.cwd ?? null, presetHeader: header.agentPreset ?? null };
  for (const [name, type] of Object.entries(SETTING_EVENTS)) {
    const event = log.findLast((e) => e?.type === type);
    value[name] = event ? JSON.stringify(event.data ?? null, (key, v) => (VOLATILE.has(key) ? undefined : v)) : null;
  }
  return value;
};

// 宿主的工作区（侧栏分组）：ctx.workspaceRegistry。list() 给出有序的工作区，每个有 id、title 和 sessionIds；
// attachSession(id) 把会话加进名单（校验会话 cwd 与工作区目录一致），insertSessionBefore(id, beforeId) 调整顺序，
// detachSession(id) 移出；pinnedSessionIds / pinSession / unpinSession 管全局置顶。服务不存在时一律降级。
export const workspaceOf = (registry, sessionId) => registry?.list?.().find((ws) => ws.sessionIds.includes(sessionId));

// 把继任会话放进原会话所在的工作区、紧挨在原会话上方；原会话置顶时继任也置顶。失败不影响交接。
export async function placeInWorkspace(registry, from, to) {
  if (!registry?.list) return { workspace: 'unavailable' };
  let ws;
  try {
    ws = workspaceOf(registry, from);
    if (!ws) return { workspace: 'none' };
    const current = workspaceOf(registry, to);
    if (current && current.id !== ws.id) return { workspace: `failed:in_other_workspace:${current.id}` };
    await ws.attachSession(to);
    if (typeof ws.insertSessionBefore === 'function') await ws.insertSessionBefore(to, from);
  } catch (error) { return { workspace: `failed:${error?.message ?? error}` }; }
  const placed = { workspace: 'attached', workspaceId: ws.id };
  if (!registry.pinnedSessionIds?.includes(from)) return placed;
  if (typeof registry.pinSession !== 'function') return { ...placed, pin: 'skipped' };
  try {
    await registry.pinSession(to);
    return { ...placed, pin: 'pinned' };
  } catch (error) { return { ...placed, pin: `failed:${error?.message ?? error}` }; }
}

// 撤回：只移出由交接放进去的那个工作区（用户后来挪走的不动），并撤销交接加上的置顶。
export async function removeFromWorkspace(registry, link, to) {
  const steps = {};
  if (link.workspaceId) {
    try {
      const ws = registry?.list?.().find((entry) => entry.id === link.workspaceId);
      if (!registry?.list) steps.workspace = 'unavailable';
      else if (!ws?.sessionIds.includes(to)) steps.workspace = 'unchanged';
      else { await ws.detachSession(to); steps.workspace = 'detached'; }
    } catch (error) { steps.workspace = `failed:${error?.message ?? error}`; }
  }
  if (link.pinned) {
    try {
      if (typeof registry?.unpinSession !== 'function') steps.pin = 'unavailable';
      else { await registry.unpinSession(to); steps.pin = 'unpinned'; }
    } catch (error) { steps.pin = `failed:${error?.message ?? error}`; }
  }
  return steps;
}

// 继任会话的标题：[交接←<原会话短 id>] <原会话标题前 40 字符>；继任的继任只保留最近一跳的前缀。
export const LEGACY_HANDOVER_TITLE = '[codex-conductor 交接]';
export const titleOf = (agent) => (Array.isArray(agent?.session?.log) ? agent.session.log : []).findLast((e) => e?.type === 'session/title')?.data?.title;
export function successorTitle(fromId, fromTitle) {
  const short = String(fromId).replace(/^session-/, '').slice(0, 8);
  let base = String(fromTitle ?? '').trim();
  // 旧版本的交接会话标题是首条交接消息的开头，不是有意义的原标题。
  if (base.startsWith(LEGACY_HANDOVER_TITLE)) base = '';
  base = [...base.replace(/^\[交接←[^\]]*\]\s*/, '')].slice(0, 40).join('').trim();
  return base ? `[交接←${short}] ${base}` : `[交接←${short}]`;
}

async function renameSuccessor(controller, to, title) {
  if (typeof controller?.rename !== 'function') return 'unavailable';
  try {
    await controller.rename({ sessionId: to, title });
    return 'set';
  } catch (error) { return `failed:${error?.message ?? error}`; }
}

// 启动时修复旧版本留下的链接：继任会话不在任何工作区、原会话在时补进原会话的工作区（repaired 标记，只做一次）；
// 标题仍以旧的交接前缀开头（宿主按首条消息自动起的名）时改成带来源的标题（titleRepaired 标记，独立于 repaired，只做一次）。
// 用户自己改过的标题、已经是 [交接←…] 的标题不动。失败只记日志。
export async function repairLinks({ registry, controller, aliases, directory, logger }) {
  for (const [to, link] of Object.entries(aliases.links())) {
    if (link.repaired && link.titleRepaired) continue;
    const entry = { at: new Date().toISOString(), action: 'repair', from: link.from, to, origin: 'startup', status: 'unchanged' };
    const marks = {};
    try {
      if (!link.repaired) {
        marks.repaired = entry.at;
        if (registry?.list && !workspaceOf(registry, to) && workspaceOf(registry, link.from)) {
          const placed = await placeInWorkspace(registry, link.from, to);
          entry.placement = placed.workspace;
          if (placed.workspaceId) Object.assign(marks, { workspaceId: placed.workspaceId, ...(placed.pin === 'pinned' ? { pinned: true } : {}) });
        }
      }
      if (!link.titleRepaired) {
        marks.titleRepaired = entry.at;
        const resolve = async (id) => (await controller?.resolveAgent?.(id))?.agent;
        if (titleOf(await resolve(to))?.trim().startsWith(LEGACY_HANDOVER_TITLE)) {
          entry.title = await renameSuccessor(controller, to, successorTitle(link.from, titleOf(await resolve(link.from))));
        }
      }
      if (entry.placement || entry.title) entry.status = [entry.placement, entry.title].some((v) => v?.startsWith('failed')) ? 'failed' : 'repaired';
    } catch (error) {
      entry.status = 'failed';
      entry.reason = String(error?.message ?? error);
    }
    try { aliases.annotate(to, marks); } catch (error) { logger?.warn?.(`[codex-conductor] 交接记录修复标记失败 ${to}：${error.message}`); }
    if (entry.status !== 'unchanged') {
      logger?.[entry.status === 'failed' ? 'warn' : 'info']?.(`[codex-conductor] 修复旧交接 ${link.from} → ${to}：${JSON.stringify(entry)}`);
      try { appendHandoverHistory(directory, entry); } catch {}
    }
  }
}

// 交接后自检：每项 ok / failed:<原因> / skipped:<原因>。只列不一致的项名，不列可能含敏感内容的值。
export async function checkHandover({ goals, agentA, agentB, goal, steps, jobs, pending, sessionJobs, aliases, from, to, registry, instructionArchive }) {
  const checks = {};
  const hasGoal = goal && goal.phase !== 'complete' && typeof goal.objective === 'string';
  if (steps.successorGoal === 'loopx') checks.goal = 'skipped:loopx';
  else if (!hasGoal) checks.goal = 'skipped:no_goal';
  else if (steps.successorGoal === 'exists') checks.goal = 'skipped:successor_had_goal';
  else {
    const created = goals?.get(agentB);
    const rounds = Number.isSafeInteger(goal.maxGoalRounds) ? Math.max(1, goal.maxGoalRounds - (goal.roundsStarted ?? 0)) : undefined;
    checks.goal = !created ? 'failed:missing' : hash(created.objective) !== hash(goal.objective) ? 'failed:objective_differs'
      : rounds !== undefined && created.maxGoalRounds !== rounds ? `failed:rounds_${created.maxGoalRounds}_expected_${rounds}` : 'ok';
  }
  const [a, b] = [settingsOf(agentA), settingsOf(agentB)];
  const differ = Object.keys(a).filter((key) => a[key] !== b[key]);
  checks.settings = differ.length ? `failed:differs:${differ.join(',')}` : 'ok';
  const open = new Set([...jobs.filter((j) => (j.execution_status ?? j.status) === 'running').map((j) => j.job_id),
    ...pending.unreviewed, ...pending.needsChanges]);
  if (!open.size) checks.jobs = 'skipped:no_open_jobs';
  else {
    try {
      const seen = new Set((await sessionJobs(to)).map((j) => j.job_id));
      const missing = [...open].filter((id) => !seen.has(id));
      checks.jobs = missing.length ? `failed:missing:${missing.slice(0, 10).join(',')}` : 'ok';
    } catch (error) { checks.jobs = `failed:${error?.message ?? error}`; }
  }
  checks.delivered = steps.delivered === 'failed' ? `failed:${steps.deliverError ?? 'not delivered'}` : 'ok';
  checks.instructions = steps.instructions;
  if (instructionArchive) {
    try {
      checks.instructions = readInstructions(instructionArchive.file).length >= instructionArchive.count ? 'ok' : 'failed:count_below_brief';
    } catch (error) { checks.instructions = `failed:${error?.message ?? error}`; }
  }
  const frozen = [];
  if (hasGoal && goals?.get(agentA)?.phase !== 'paused') frozen.push('goal_not_paused');
  if (aliases.successor(from) !== to) frozen.push('alias_missing');
  if (steps.autoContinue && !['disabled', 'already_off', 'not_installed'].includes(steps.autoContinue)) frozen.push(`autoContinue_${steps.autoContinue}`);
  checks.predecessorFrozen = frozen.length ? `failed:${frozen.join(',')}` : 'ok';
  // 原会话在某个工作区时，继任会话必须在同一个工作区的名单里。
  try {
    const ws = registry?.list ? workspaceOf(registry, from) : undefined;
    checks.workspace = !registry?.list ? 'skipped:unavailable' : !ws ? 'skipped:ungrouped'
      : ws.sessionIds.includes(to) ? 'ok' : 'failed:not_in_workspace';
  } catch (error) { checks.workspace = `failed:${error?.message ?? error}`; }
  return checks;
}

// 链路末端的继任会话：A→B→C 时 A、B 都解析到 C。
export function lastSuccessor(aliases, id) {
  let to = aliases.successor(id);
  for (const seen = new Set([id]); to && !seen.has(to) && aliases.successor(to); seen.add(to)) to = aliases.successor(to);
  return to;
}

// 宿主 tool-jobs 在任务结束时把通知发给任务属主（交接前派出的任务属主仍是前任）：属主空闲就直接开一个新回合。
// 交接出去的会话收到 Codex 任务的结束通知时，在回合第一步之前把通知转给链路末端的继任会话；本回合只有这些通知时
// 返回 reject，前任以 blocked 结束这一回合，不调用模型。撤回后前任不再有继任，通知照常留给它自己。
export async function forwardRetiredNotices({ agent, messages, aliases, jobs, resolve }) {
  const successor = lastSuccessor(aliases, agent?.id);
  if (!successor || !Array.isArray(messages)) return undefined;
  const codex = new Set((jobs?.list?.(agent.id) ?? []).filter((job) => job.kind === 'codex' && /^Codex /.test(job.label ?? '')).map((job) => job.id));
  const notices = messages.filter((m) => m?.source?.kind === 'tool-jobs' && m.source.form === 'notice' &&
    codex.has(/^background job (\S+)(?:\s|$)/.exec(textOf(m.content))?.[1]));
  if (!notices.length) return undefined;
  let delivered = false;
  try {
    const target = await resolve(successor);
    if (target) {
      const text = `[codex-conductor] 原会话 ${agent.id} 交接前派出的任务已结束，通知转到本会话；用 codex_status / codex_output 查看并验收：\n\n` +
        notices.map((m) => textOf(m.content)).join('\n\n');
      const message = { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'plugin:codex-conductor' } };
      if (target.status === 'idle') target.followup(message);
      else target.inject(message);
      delivered = true;
    }
  } catch {}
  return { successor, delivered, forwarded: notices.length, reject: notices.length === messages.length };
}

export async function handOver(ctx, deps, request) {
  const { aliases, sessionJobs, pendingOf, since, directory, deliverWaitMs = 8_000, autoContinue,
    disableAutoContinue: turnOffAutoContinue = true, autoMessage, sessionRead = () => false, contextDeadlineMs, workspaces = () => undefined, withRunningJobs = false,
    loopx } = deps;
  const result = { status: 'refused', from: request.from ?? request.revert?.from, to: request.to ?? request.revert?.to ?? null, steps: {} };
  const refuse = (reason, extra = {}) => Object.assign(result, { reason, ...extra });
  const controller = ctx.get('sessionController');
  const goals = ctx.get('goals');
  const agentOf = async (id) => {
    const resolved = await controller.resolveAgent(id);
    if (resolved.error) throw Object.assign(new Error(resolved.error.message ?? 'session not found'), { code: resolved.error.code });
    return resolved.agent;
  };
  const ref = (goal) => ({ id: goal.id, revision: goal.revision });
  if (request.revert) {
    const { from, to } = request.revert;
    const link = aliases.links()[to];
    if (link?.from !== from) return refuse('not_linked', { error: `${to} did not take over ${from}` });
    // 继任会话交接后已经开工（交接单那一回合不算）时，撤回会让两个会话并行推进同一件事；默认拒绝，force 才执行。
    // 交接自身的自动回滚（rollback）只可能撞上交接单那一回合还在跑，不算开工。
    let newTurns = 0, successorRunning = false;
    try {
      const agent = await agentOf(to);
      newTurns = Math.max(0, logCounts(agent.session?.log).turns - (link.toTurns ?? 0) - (link.delivered === false ? 0 : 1));
      successorRunning = agent.status === 'running' && !request.rollback;
    } catch {} // 继任会话已不存在：不会并行。
    if (newTurns > 0 || successorRunning) {
      if (!request.force) {
        return refuse('successor_active', { status: 'rejected', newTurns, successorRunning,
          message: `继任会话已有 ${newTurns} 个新回合${successorRunning ? '且正在运行' : ''}，撤回会造成两个会话并行；确需撤回请带 force: true。` });
      }
      result.warning = 'parallel_sessions';
    }
    aliases.unlink(from, to);
    result.status = 'reverted';
    result.steps.alias = 'removed';
    // 回到原会话：暂停后继的目标、恢复原会话被暂停的目标；后继交接后派出的任务仍归后继。
    for (const [id, key, want] of [[to, 'successorGoal', 'pause'], [from, 'predecessorGoal', 'resume']]) {
      try {
        const agent = await agentOf(id);
        const goal = goals?.get(agent);
        if (want === 'pause' && goal?.phase === 'active') { goals.pause(agent, ref(goal)); result.steps[key] = 'paused'; }
        else if (want === 'resume' && goal?.phase === 'paused') { goals.resume(agent, ref(goal)); result.steps[key] = 'resumed'; }
        else result.steps[key] = goal ? `unchanged_${goal.phase}` : 'none';
      } catch (error) { result.steps[key] = `failed: ${error.message}`; }
    }
    Object.assign(result.steps, await removeFromWorkspace(workspaces(), link, to));
    // 交接时挪给继任会话的 LoopX 绑定，撤回时挪回原会话。
    if (link.loopx && loopx) {
      let cwd;
      try { cwd = (await agentOf(from)).session?.header?.cwd; } catch {}
      const back = await moveLoopxBinding(loopx, cwd, to, from);
      result.steps.loopx = back.loopx === 'moved' ? 'restored' : back.loopx;
    }
    // 交接时由插件关掉的自动续接，撤回时恢复成原来的值（原来没有这个键就删掉）。
    if (link.autoContinue === 'disabled' && Object.hasOwn(link, 'autoContinuePrevious')) {
      result.steps.autoContinue = await restoreAutoContinue(autoContinue, from, link.autoContinuePrevious);
    }
    result.sessions = [
      { sessionId: from, state: 'restored', goal: result.steps.predecessorGoal, note: '原会话恢复：可以继续派活、验收和续接。' },
      { sessionId: to, state: 'detached', goal: result.steps.successorGoal, newTurns,
        note: '继任会话不再接管原会话的任务，目标已暂停；它在交接后派出的任务仍归它。' + (result.warning ? '它已经开工，请决定保留哪一个会话，另一个停下。' : '') },
    ];
    return result;
  }
  const { from, note, force } = request;
  if (request.origin === 'auto' && aliases.links(null) === null) return refuse('links_unreadable', { error: LINKS_UNREADABLE });
  let agentA;
  try { agentA = await agentOf(from); } catch (error) { return refuse(error.code === 'session/not-found' ? 'session_not_found' : 'session_unavailable', { error: error.message }); }
  const taken = aliases.successor(from);
  if (taken) return refuse('already_handed_over', { successor: taken });
  if (!force && agentA.status === 'running') return refuse('turn_running');
  let jobs;
  try { jobs = await sessionJobs(from); } catch (error) { return refuse('jobs_unreadable', { error: String(error?.message ?? error) }); }
  const running = jobs.filter((j) => (j.execution_status ?? j.status) === 'running').map((j) => j.job_id);
  // 带任务交接（withRunningJobs）：运行中的任务随交接转给继任，结束通知由插件转投；有回合在跑时仍然拒绝。
  if (!force && !withRunningJobs && running.length) return refuse('jobs_running', { running });
  const goal = goals?.get(agentA);
  const header = agentA.session?.header ?? {};
  let to = request.to;
  let agentB;
  try {
    if (!to) {
      // 与界面“新对话”相同的入口：会话归宿主所有，插件重载不会把它拆掉。
      const created = await controller.create({ ...(header.cwd ? { cwd: header.cwd } : {}), ...(header.agentPreset ? { agentPreset: header.agentPreset } : {}) });
      to = created?.sessionId;
      if (!validSessionId(to)) throw new Error('sessionController.create returned no session id');
      result.steps.session = 'created';
    } else result.steps.session = 'adopted';
    result.to = to;
    agentB = await agentOf(to);
  } catch (error) { return refuse('successor_unavailable', { error: String(error?.message ?? error) }); }
  if (request.to && !force && agentB.status === 'running') return refuse('successor_turn_running');
  // 记下继任会话此刻的消息数和回合数：撤回保护和自动交接的再次触发都以它为基数。
  const base = logCounts(agentB.session?.log);
  const { origin, requestedAt } = request;
  try { aliases.link(from, to, { origin, requestedAt, toMessages: base.messages, toTurns: base.turns }); }
  catch (error) { return refuse('alias_failed', { error: error.message }); }
  result.status = 'handed_over';
  result.steps.alias = 'linked';
  // 继任会话进原会话的分组、排在它上方；新建的继任会话改成能看出来源的标题（在交接单送达前设，免得被自动标题覆盖）。
  const placed = await placeInWorkspace(workspaces(), from, to);
  result.steps.workspace = placed.workspace;
  if (placed.workspaceId) result.steps.workspaceId = placed.workspaceId;
  if (placed.pin) result.steps.pin = placed.pin;
  if (!request.to) result.steps.title = await renameSuccessor(controller, to, successorTitle(from, titleOf(agentA)));
  const autoContinueStep = turnOffAutoContinue ? await disableAutoContinue(autoContinue, from) : {};
  if (autoContinueStep.autoContinue) result.steps.autoContinue = autoContinueStep.autoContinue;
  // 原会话由 LoopX 续跑：绑定随交接挪给继任会话，继任会话由 LoopX 接着跑，不重建原生目标。
  const follow = loopx && loopxDriven(agentA.session?.log) ? await moveLoopxBinding(loopx, header.cwd, from, to) : undefined;
  if (follow) result.steps.loopx = follow.loopx;
  const followed = follow?.loopx === 'moved' ? { goalId: follow.goalId, agentId: follow.agentId } : undefined;
  const pending = pendingOf(jobs);
  Object.assign(result, { pending, running });
  const at = new Date().toISOString();
  const existingGoal = goals?.get(agentB);
  try {
    const archive = await archiveInstructions({ directory, aliases, from, agentA, agentOf });
    aliases.annotate(to, { instructions: { root: archive.root, count: archive.count } });
    result.instructions = archive;
    result.steps.instructions = 'written';
  } catch (error) { result.steps.instructions = `failed:${error?.message ?? error}`; }
  const brief = buildBrief({ from, to, at, cwd: header.cwd, goal, jobs, pending, since, note, origin, requestedAt,
    autoContinue: result.steps.autoContinue, successorGoal: existingGoal && existingGoal.phase !== 'complete' ? 'exists' : undefined,
    context: sessionContext(agentA.session?.log, { autoMessage, ...(contextDeadlineMs !== undefined ? { deadlineMs: contextDeadlineMs } : {}) }),
    instructionArchive: result.instructions, instructionError: result.instructions ? undefined : result.steps.instructions.slice(7),
    sessionRead: sessionRead() });
  try {
    const dir = path.join(directory, 'handovers');
    fs.mkdirSync(dir, { recursive: true });
    result.briefPath = path.join(dir, `${at.replace(/[:.]/g, '-')}-${from}-to-${to}.md`);
    fs.writeFileSync(result.briefPath, brief);
  } catch (error) { result.steps.brief = `failed: ${error.message}`; delete result.briefPath; }
  // 先停原会话的目标，再让新会话开工，避免两边同时推进。
  if (goal?.phase === 'active') {
    try { goals.pause(agentA, ref(goals.get(agentA))); result.steps.predecessorGoal = 'paused'; }
    catch (error) { result.steps.predecessorGoal = `failed: ${error.message}`; }
  } else result.steps.predecessorGoal = goal ? `unchanged_${goal.phase}` : 'none';
  Object.assign(result.steps, await deliver(controller, to, handoverMessage(from, result.briefPath, brief, followed), deliverWaitMs));
  if (followed) result.steps.successorGoal = 'loopx';
  else if (goal && goal.phase !== 'complete' && typeof goal.objective === 'string') {
    try {
      const existing = goals.get(agentB);
      if (existing && existing.phase !== 'complete') result.steps.successorGoal = 'exists';
      else {
        goals.create(agentB, { objective: goal.objective,
          ...(Number.isSafeInteger(goal.maxGoalRounds) ? { maxGoalRounds: Math.max(1, goal.maxGoalRounds - (goal.roundsStarted ?? 0)) } : {}) });
        result.steps.successorGoal = 'created';
      }
    } catch (error) { result.steps.successorGoal = `failed: ${error.message}`; }
  } else result.steps.successorGoal = 'none';
  try {
    aliases.annotate(to, { delivered: result.steps.delivered !== 'failed',
      ...(placed.workspaceId ? { workspaceId: placed.workspaceId } : {}), ...(placed.pin === 'pinned' ? { pinned: true } : {}),
      ...(result.steps.autoContinue ? { autoContinue: result.steps.autoContinue } : {}),
      ...(Object.hasOwn(autoContinueStep, 'previous') ? { autoContinuePrevious: autoContinueStep.previous } : {}),
      ...(followed ? { loopx: followed } : {}) });
  } catch (error) { result.steps.linkNote = `failed: ${error.message}`; }
  // 首条消息没送达，或继任会话的目标没建起来：不留一个没有交接单或没有目标的“继任”，自动撤回一次（不带 force）。
  const broken = result.steps.delivered === 'failed' ? 'delivery_failed' : result.steps.successorGoal.startsWith('failed') ? 'successor_goal_failed' : '';
  if (broken) {
    const back = await handOver(ctx, deps, { revert: { from, to }, force: false, rollback: true, origin });
    result.rollback = { reason: broken, status: back.status, ...(back.reason ? { refused: back.reason } : {}), steps: back.steps };
    result.status = back.status === 'reverted' ? 'rolled_back' : 'handed_over_with_issues';
    if (back.status === 'reverted') return result;
  }
  result.checks = await checkHandover({ goals, agentA, agentB, goal, steps: result.steps, jobs, pending, sessionJobs,
    aliases, from, to, registry: workspaces(), instructionArchive: result.instructions });
  if (Object.values(result.checks).some((value) => value.startsWith('failed'))) result.status = 'handed_over_with_issues';
  return result;
}

export async function processHandoverRequest({ ctx, directory, ...deps }) {
  const claimed = path.join(directory, `handover-request.${randomUUID()}.processing.json`);
  try { fs.renameSync(path.join(directory, 'handover-request.json'), claimed); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  let requestedAt = new Date().toISOString(), origin = 'file', action = 'invalid';
  let result;
  try {
    const request = validateHandoverRequest(JSON.parse(fs.readFileSync(claimed, 'utf8').replace(/^﻿/, '')));
    ({ origin } = request);
    requestedAt = request.requestedAt ??= requestedAt;
    action = request.revert ? 'revert' : request.to ? 'adopt' : 'handover';
    result = await handOver(ctx, { ...deps, directory }, request);
  } catch (error) {
    result = { status: 'rejected', reason: 'invalid_request', error: String(error?.message ?? error) };
  }
  result = { requestedAt, origin, ...result, completedAt: new Date().toISOString() };
  try {
    appendHandoverHistory(directory, { at: result.completedAt, action, from: result.from ?? null, to: result.to ?? null, origin,
      status: result.status, ...(result.reason ? { reason: result.reason } : {}), ...(result.warning ? { warning: result.warning } : {}) });
  } catch {} // 历史只是旁证，写不进去不影响交接结果。
  writeJsonAtomic(path.join(directory, 'handover-result.json'), result);
  // 结果写不出来时保留已认领的请求文件，不自动重放。
  fs.unlinkSync(claimed);
  // 自动交接据此在交接没成时恢复它提前暂停的目标。
  try { deps.onResult?.(result); } catch {}
  return result;
}

export function registerHandoverRequests({ ctx, directory, ...deps }) {
  let pending = Promise.resolve();
  let stopped = false;
  const warn = (error) => ctx.logger?.warn?.(`[codex-conductor] handover request: ${error?.message ?? error}`);
  const check = () => {
    pending = pending.then(() => stopped ? undefined : processHandoverRequest({ ctx, directory, ...deps })).catch(warn);
    return pending;
  };
  ctx.effect(() => {
    let watcher;
    try {
      fs.mkdirSync(directory, { recursive: true });
      watcher = fs.watch(directory, { persistent: false }, (_event, filename) => {
        if (filename == null || filename.toString() === 'handover-request.json') return check();
      });
      watcher.on('error', (error) => { warn(error); watcher.close(); });
    } catch (error) { warn(error); }
    void check();
    return () => { stopped = true; watcher?.close(); };
  });
  return check;
}

// 会话历史越长每步越慢；这里只标记“建议交接”，提醒、询问和自动交接由 createAutoHandover 按配置决定。
// 会话日志只追加，按日志数组累计，每次只数新增事件。
const MESSAGE_TYPES = new Set(['assistant/message', 'tool/result', 'user/message', 'system/message', 'developer/message']);
export function createHistoryTracker({ directory, threshold, now = Date.now, writeEveryMs = 30_000 }) {
  const counts = new WeakMap();
  const file = directory && path.join(directory, 'history-status.json');
  let sessions = {};
  try { sessions = JSON.parse(fs.readFileSync(file, 'utf8')).sessions ?? {}; } catch {}
  let written = 0;
  let dirty = false;
  let timer;
  const count = (log) => {
    if (!Array.isArray(log)) return undefined;
    let entry = counts.get(log);
    if (!entry || entry.scanned > log.length) entry = { scanned: 0, messages: 0 };
    for (let i = entry.scanned; i < log.length; i++) if (MESSAGE_TYPES.has(log[i]?.type)) entry.messages++;
    entry.scanned = log.length;
    counts.set(log, entry);
    return entry.messages;
  };
  // 供外部看门狗读取：只有会话 ID、消息数、是否建议交接、工作目录、阈值和时间。
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!file || !dirty) return;
    const old = now() - 7 * 86_400_000;
    for (const [id, value] of Object.entries(sessions)) if (!(Date.parse(value.at) >= old)) delete sessions[id];
    try {
      fs.mkdirSync(directory, { recursive: true });
      writeJsonAtomic(file, { updatedAt: new Date(now()).toISOString(), threshold: threshold(), sessions });
      written = now();
      dirty = false;
    } catch {}
  };
  return {
    observe(agent) {
      const messages = count(agent?.session?.log);
      if (messages === undefined || !validSessionId(agent?.id)) return undefined;
      const limit = threshold();
      const value = { messages, threshold: limit, suggest: limit > 0 && messages > limit };
      const previous = sessions[agent.id];
      const cwd = agent.session?.header?.cwd;
      if (previous?.messages !== messages || previous?.suggest !== value.suggest) {
        sessions[agent.id] = { messages, suggest: value.suggest, ...(typeof cwd === 'string' ? { cwd } : {}), at: new Date(now()).toISOString() };
        dirty = true;
      }
      if (now() - written >= writeEveryMs) flush();
      else if (dirty && !timer) { timer = setTimeout(flush, writeEveryMs - (now() - written)); timer.unref?.(); }
      return value;
    },
    snapshot: () => ({ threshold: threshold(), sessions: Object.entries(sessions).map(([sessionId, value]) => ({ sessionId, ...value })) }),
    flush,
  };
}

const HOUR = 3_600_000;
// 自动交接没成之后过这么久才再试，免得每个回合都暂停再恢复目标；撞上新回合（turn_running）时下一个回合边界就再试。
export const RETRY_COOLDOWN_MS = 30 * 60_000;
export const TURN_RETRY_COOLDOWN_MS = 2 * 60_000;
export const AUTO_HANDOVER_DEFAULTS = { mode: 'confirm', cooldownHours: 12, remindStepMessages: 2000, startupDelayMinutes: 10, disableAutoContinue: true,
  withRunningJobs: true, maxChainDepth: 6, minHoursBetween: 6 };

// 纯判定：会话标了建议交接之后这一次要做什么。remind 是面板提醒；act 为 ask（confirm 模式询问）或 auto（执行交接，
// 来源 origin 为 auto，或用户在面板同意过的 confirm / panel）。名下是否还有运行中的 Codex 任务由调用方最后再查。
export function autoHandoverStep({ settings, record = {}, messages, threshold, suggest, idle, retired, link, now, uptimeMs,
  linksReadable = true, depth = 0, lastAutoAt = -Infinity }) {
  const step = { remind: false, act: null };
  if (settings.mode === 'off' || !suggest || retired) return step;
  // 继任会话从交接时起再涨满一个阈值才算（自动交接出的新会话不会马上再触发）。
  if (link && messages - (link.toMessages ?? 0) <= threshold) return step;
  step.remind = record.remindedMessages === undefined || messages - record.remindedMessages >= settings.remindStepMessages;
  if (!idle || now < (Date.parse(record.retryAfter) || 0)) return step;
  // 用户已在面板同意：下一个回合边界按自动交接的流程执行，不再看冷却和每日上限。
  if (record.approved) return Object.assign(step, { act: 'auto', origin: record.approved.origin ?? 'confirm' });
  if (settings.mode === 'notify') return step;
  if (settings.mode === 'auto') {
    if (!linksReadable) return { ...step, blocked: LINKS_UNREADABLE };
    if (settings.maxChainDepth > 0 && depth >= settings.maxChainDepth) {
      return { ...step, blocked: `会话链已交接 ${depth} 次，达到自动交接上限 ${settings.maxChainDepth} 次。` };
    }
    const until = lastAutoAt + settings.minHoursBetween * HOUR;
    if (settings.minHoursBetween > 0 && now < until) {
      return { ...step, blocked: `同一会话链自动交接至少间隔 ${settings.minHoursBetween} 小时，还需等待 ${Math.ceil((until - now) / 60_000)} 分钟。` };
    }
  }
  // 拒绝、点了“知道了”或询问后没人理，都在冷却期内不再询问或自动交接。
  const quiet = Math.max(Date.parse(record.askedAt) || 0, Date.parse(record.declinedAt) || 0);
  if (now - quiet < settings.cooldownHours * HOUR) return step;
  if (settings.mode === 'auto' && (uptimeMs < settings.startupDelayMinutes * 60_000 ||
    (record.autoAt ?? []).some((at) => now - Date.parse(at) < 24 * HOUR))) return step;
  return Object.assign(step, settings.mode === 'auto' ? { act: 'auto', origin: 'auto' } : { act: 'ask' });
}

// auto-handover.json：{ sessions: { "<会话>": { remindedMessages, remindedAt, open, askedAt, askedMessages, declinedAt, approved,
//   autoAt[], retryAfter, pending, blocked } } }。
// 没有可调用的通知服务；宿主的提问服务为工具调用设计，不借用。提醒和询问只出现在面板的“会话交接”里。
// 目标循环里回合一结束 goal 就会排下一轮：宿主在会话转为空闲时异步落盘后才排，这里在同一个“空闲”事件里同步暂停目标，
// 抢在下一轮之前；交接没成就把这次暂停的目标恢复（resume 会重新武装，goal 循环随之继续）。
export function createAutoHandover({ directory, settings, aliases, runningJobs, submit = (request) => submitHandoverRequest(directory, request),
  goals = () => undefined, agentOf = () => undefined, workspaces = () => undefined, now = Date.now, uptime = () => process.uptime() * 1000, logger }) {
  const file = directory && path.join(directory, 'auto-handover.json');
  const read = () => {
    try {
      const sessions = JSON.parse(fs.readFileSync(file, 'utf8')).sessions;
      return sessions && typeof sessions === 'object' && !Array.isArray(sessions) ? sessions : {};
    } catch { return {}; }
  };
  const save = (id, record) => {
    const sessions = read();
    sessions[id] = record;
    fs.mkdirSync(directory, { recursive: true });
    writeJsonAtomic(file, { sessions });
  };
  const checking = new Set();
  const openPrompt = (record, at = now()) => record?.open === 'remind' ||
    (record?.open === 'ask' && at - Date.parse(record.askedAt) < settings().cooldownHours * HOUR);
  // 只暂停正在由 goal 循环驱动的目标；用户暂停过、改过或本来就不是 active 的不动。
  const pauseGoal = (agent) => {
    const service = goals();
    const goal = service?.get?.(agent);
    if (goal?.phase !== 'active' || goal.activation !== 'armed') return undefined;
    try {
      const paused = service.pause(agent, { id: goal.id, revision: goal.revision });
      return { id: goal.id, revision: paused?.revision };
    } catch (error) {
      logger?.warn?.(`[codex-conductor] 自动交接前暂停目标失败 ${agent.id}：${error?.message ?? error}`);
      return undefined;
    }
  };
  // 只恢复这次暂停的那一版目标；之后被用户或交接改动过的不动。
  const resumeGoal = (agent, paused) => {
    const service = goals();
    const goal = agent && paused ? service?.get?.(agent) : undefined;
    if (!goal || goal.id !== paused.id || goal.phase !== 'paused' || (paused.revision !== undefined && goal.revision !== paused.revision)) return false;
    try {
      service.resume(agent, { id: goal.id, revision: goal.revision });
      return true;
    } catch (error) {
      logger?.warn?.(`[codex-conductor] 恢复自动交接前暂停的目标失败 ${agent.id}：${error?.message ?? error}`);
      return false;
    }
  };
  const giveUp = (agent, record, paused, why, turn = false) => {
    const resumed = resumeGoal(agent, paused);
    const wait = turn ? TURN_RETRY_COOLDOWN_MS : RETRY_COOLDOWN_MS;
    record.retryAfter = new Date(now() + wait).toISOString();
    delete record.pending;
    logger?.info?.(`[codex-conductor] 会话 ${agent?.id} 本次没有自动交接（${why}）${resumed ? '，已恢复目标' : ''}，${wait / 60_000} 分钟后再试。`);
  };
  const decision = (id, value, sessions, idle, storedLinks = aliases.links(null)) => {
    const links = storedLinks ?? {};
    const predecessors = aliases.predecessors(id, links);
    let lastAutoAt = -Infinity;
    for (const owner of [id, ...predecessors]) {
      for (const at of sessions[owner]?.autoAt ?? []) lastAutoAt = Math.max(lastAutoAt, Date.parse(at) || 0);
      const link = links[owner];
      if (link?.origin === 'auto') lastAutoAt = Math.max(lastAutoAt, Date.parse(link.at) || 0);
    }
    return autoHandoverStep({ settings: settings(), record: sessions[id], messages: value.messages, threshold: value.threshold, suggest: value.suggest,
      idle, retired: Boolean(aliases.successor(id, links)), link: links[id], now: now(), uptimeMs: uptime(),
      linksReadable: storedLinks !== null, depth: predecessors.length, lastAutoAt });
  };
  return {
    // value 是 history.observe(agent) 的结果；会话每次转为空闲时同步调用（第一个 await 之前的部分与 goal 排下一轮同属这次事件）。
    async observe(agent, value) {
      const id = agent?.id;
      if (!file || !value || !validSessionId(id) || checking.has(id)) return undefined;
      const sessions = read();
      const record = { ...sessions[id] };
      const at = new Date(now()).toISOString();
      const step = decision(id, value, sessions, agent.status === 'idle');
      let changed = record.blocked !== step.blocked;
      if (step.blocked) record.blocked = step.blocked;
      else delete record.blocked;
      if (step.remind) {
        Object.assign(record, { remindedMessages: value.messages, remindedAt: at, open: record.open === 'ask' && openPrompt(record) ? 'ask' : 'remind' });
        changed = true;
        logger?.info?.(`[codex-conductor] 会话 ${id} 已有 ${value.messages} 条消息，建议交接；见面板“会话交接”。`);
      }
      if (step.act) {
        checking.add(id);
        // 询问不打断目标循环；执行交接前先同步暂停目标。
        const paused = step.act === 'auto' ? pauseGoal(agent) : undefined;
        try {
          // 带任务交接时不必等任务结束（它们随交接转给继任），询问也就不必等。查任务期间会话可能又开始了新回合。
          const carry = settings().withRunningJobs !== false;
          const jobsQuiet = carry || await runningJobs(id) === 0;
          const quiet = jobsQuiet && agent.status === 'idle';
          if (step.act === 'ask') {
            if (quiet) Object.assign(record, { open: 'ask', askedAt: at, askedMessages: value.messages });
          } else if (!quiet) giveUp(agent, record, paused, agent.status === 'idle' ? '有 Codex 任务在运行' : '会话又开始了新回合', agent.status !== 'idle');
          else {
            submit({ sessionId: id, origin: step.origin, requestedAt: at });
            if (step.origin === 'auto') record.autoAt = [...(record.autoAt ?? []).filter((t) => now() - Date.parse(t) < 24 * HOUR), at];
            Object.assign(record, { open: null, approved: null, pending: { requestedAt: at, ...(paused ? { goal: paused } : {}) } });
            logger?.info?.(`[codex-conductor] 会话 ${id} 已有 ${value.messages} 条消息，已提交交接请求（${step.origin}）。`);
          }
          changed = changed || step.act === 'auto' || quiet;
        } catch (error) {
          logger?.warn?.(`[codex-conductor] 自动交接检查跳过 ${id}：${error?.message ?? error}`);
          if (step.act === 'auto') { giveUp(agent, record, paused, '检查出错'); changed = true; }
        } finally { checking.delete(id); }
      }
      if (changed) save(id, record);
      return step;
    },
    // 交接请求处理完：没成就恢复提前暂停的目标并进入重试冷却。
    settled(result) {
      const id = result?.from;
      const record = validSessionId(id) ? read()[id] : undefined;
      if (!record?.pending || record.pending.requestedAt !== result.requestedAt) return;
      if (['handed_over', 'handed_over_with_issues'].includes(result.status)) delete record.pending;
      else {
        // 没交接成的尝试不占“24 小时一次”的名额。
        record.autoAt = (record.autoAt ?? []).filter((at) => at !== record.pending.requestedAt);
        giveUp(agentOf(id), record, record.pending.goal, `交接${result.status}${result.reason ? `：${result.reason}` : ''}`,
          result.reason === 'turn_running');
      }
      save(id, record);
    },
    // 面板上的“同意交接 / 现在交接”：记下同意，在会话下一个回合边界按自动交接的流程执行；“暂不交接 / 知道了”进入冷却。
    answer(id, accept) {
      const record = read()[id];
      if (!openPrompt(record)) throw Object.assign(new Error('no open hand-over prompt'), { code: 'none' });
      const at = new Date(now()).toISOString();
      if (accept) record.approved = { at, origin: record.open === 'ask' ? 'confirm' : 'panel' };
      else record.declinedAt = at;
      save(id, { ...record, open: null, retryAfter: null });
      return accept ? { scheduled: true } : { declined: true };
    },
    snapshot(suggestions = [], threshold) {
      const sessions = read();
      const storedLinks = aliases.links(null);
      const links = storedLinks ?? {};
      let result = null;
      try { result = JSON.parse(fs.readFileSync(path.join(directory, 'handover-result.json'), 'utf8')); } catch {}
      // 继任会话所在工作区的名字；取不到就不显示。
      let groups = new Map();
      try { for (const ws of workspaces()?.list?.() ?? []) for (const sid of ws.sessionIds) groups.set(sid, ws.title); } catch { groups = new Map(); }
      const group = (sid) => (groups.has(sid) ? { workspace: groups.get(sid) } : {});
      return { mode: settings().mode,
        suggestions: suggestions.filter((s) => s.suggest && !aliases.successor(s.sessionId, links)).map((s) => {
          const { blocked } = decision(s.sessionId, { threshold, ...s }, sessions, true, storedLinks);
          return blocked ? { ...s, blocked } : s;
        }),
        prompts: Object.entries(sessions).filter(([id, r]) => openPrompt(r) && !aliases.successor(id))
          .map(([sessionId, r]) => ({ sessionId, kind: r.open, at: r.open === 'ask' ? r.askedAt : r.remindedAt, messages: r.open === 'ask' ? r.askedMessages : r.remindedMessages })),
        scheduled: Object.entries(sessions).filter(([id, r]) => r.approved && !aliases.successor(id)).map(([sessionId]) => sessionId),
        links: Object.entries(links).map(([to, l]) => ({ from: l.from, to, at: l.at, origin: l.origin ?? null, autoContinue: l.autoContinue ?? null, ...group(to) })),
        result, recent: directory ? readHandoverHistory(directory, 10).map((entry) => ({ ...entry, ...group(entry.to) })) : [] };
    },
  };
}
