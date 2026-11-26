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

function readRevokedHandovers(directory) {
  try {
    const { sessions } = JSON.parse(fs.readFileSync(path.join(directory, 'revoked-handovers.json'), 'utf8'));
    if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions) ||
        !Object.values(sessions).every(ids => Array.isArray(ids) && ids.every(id => typeof id === 'string'))) {
      throw new Error('invalid revoked handover records');
    }
    return sessions;
  } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

function revokeHandover(directory, agentId, requestId) {
  const sessions = readRevokedHandovers(directory);
  const ids = sessions[agentId] ?? [];
  if (ids.includes(requestId)) return;
  fs.mkdirSync(directory, { recursive: true });
  writeJsonAtomic(path.join(directory, 'revoked-handovers.json'), {
    sessions: { ...sessions, [agentId]: [...ids, requestId] },
  });
}

export function filterRevokedHandovers(directory, agentId, messages) {
  if (!directory) return messages;
  const revoked = readRevokedHandovers(directory)[agentId];
  return revoked?.length ? messages.filter(message => !revoked.includes(message.source?.rpcId)) : messages;
}

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
  if (input.pausedGoal !== undefined && (!input.pausedGoal || typeof input.pausedGoal.id !== 'string' || input.pausedGoal.id.length > 200)) {
    throw new Error('pausedGoal must be an object with a goal id');
  }
  const meta = { origin: input.origin ?? 'file', ...(input.requestedAt ? { requestedAt: input.requestedAt } : {}), force: input.force === true,
    ...(input.pausedGoal ? { pausedGoal: { id: input.pausedGoal.id } } : {}) };
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

// 以用户身份提交、却不是人打的固定文本：本插件投递的交接单（宿主记 rpcId handover-…，档案里只剩正文开头），
// dsh-client-auto-continue 未开 usePluginSource 时的重启续跑默认话术（中、英、俄）。
const MACHINE_USER_TEXT = /^\s*(?:\[codex-conductor 交接\]|\/loopx 这是会话交接后的续接|继续。宿主在你上一轮运行期间重启了|Continue\. The harness was restarted while your previous turn|Продолжай\. Хост перезапустился)/;

function humanInstruction(event) {
  if (event?.type !== 'user/message' || event.data?.source?.kind !== 'user') return;
  if (event.data.source.via?.startsWith('codex-conductor') || String(event.data.source.rpcId ?? '').startsWith('handover-')) return;
  const text = textOf(event.data.content);
  if (text.trim() && !MACHINE_USER_TEXT.test(text)) return { text, at: timeOf(event) };
}

// 交接单的“最近的用户指令”：取整条会话链档案里最近 12 条，排除自动续接等固定话术（与 sessionContext 同一筛选）。
export function recentInstructions(entries, autoMessage) {
  const kept = [];
  for (let i = entries.length - 1; i >= 0 && kept.length < 12; i--) {
    const { text, at } = entries[i] ?? {};
    if (typeof text !== 'string' || !text.trim() || text.trim() === autoMessage || AUTOMATED_USER_TEXT.test(text) || MACHINE_USER_TEXT.test(text)) continue;
    kept.push({ text: clip(text, 600), at });
  }
  return kept;
}

// 从旧会话的内存日志里倒着找最近的人工指令和最后一个正常结束回合的小结；超过 deadlineMs 就放弃这两节。
export function sessionContext(log, { autoMessage, now = Date.now, deadlineMs = 10_000 } = {}) {
  const events = Array.isArray(log) ? log : [];
  const deadline = now() + deadlineMs;
  const instructions = [];
  let lastTurn, lastTurnNo, completedTurn, progress, latest;
  for (let i = events.length - 1; i >= 0; i--) {
    if (i % 500 === 0 && now() > deadline) return { timedOut: true };
    const event = events[i];
    if (event?.type === 'turn/end') {
      if (!lastTurn) {
        lastTurn = { reason: event.data?.reason?.kind ?? '未知', at: timeOf(event) };
        lastTurnNo = event.data?.turn;
      }
      if (completedTurn === undefined && event.data?.reason?.kind === 'completed') completedTurn = event.data?.turn;
    } else if (event?.type === 'assistant/message') {
      // 最后一个回合没正常结束（被交接掐断、报错、中断）时，它最后说的话才是最新进展；正常结束回合的小结照旧另列。
      const turn = event.data?.turn;
      const wanted = (!latest && lastTurn && lastTurn.reason !== 'completed' && turn === lastTurnNo) ||
        (!progress && completedTurn !== undefined && turn === completedTurn);
      const text = wanted ? textOf(event.data?.message?.content).trim() : '';
      if (text && turn === completedTurn) progress = { text: clip(text, 1500), at: timeOf(event) };
      else if (text) latest = { text: clip(text, 1500), at: timeOf(event) };
    } else if (instructions.length < 12) {
      const item = humanInstruction(event);
      if (item && item.text.trim() !== autoMessage && !AUTOMATED_USER_TEXT.test(item.text)) {
        instructions.push({ ...item, text: clip(item.text, 600) });
      }
    }
    if (instructions.length >= 12 && lastTurn && progress) break;
  }
  return { instructions, lastTurn, progress, ...(latest ? { latest } : {}) };
}

// 保留小写 UUID 的旧路径，其他 ID 用独立的文件名空间，避免 Windows 折叠大小写。
const fileId = (id) => (/^(?:session-)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id) ? id : `id-${hash(id)}`);

export function instructionArchivePath(directory, root) {
  return path.resolve(directory, 'handovers', `instructions-${fileId(root)}.json`);
}

export function transcriptPath(directory, sessionId) {
  return path.resolve(directory, 'handovers', `transcript-${fileId(sessionId)}.md`);
}

// 旧会话原文：交接时把会话的对话按时间导出成纯文本，继任会话缺细节时用 grep / read 回查，不靠摘要记忆。
// 收用户原话、助手回复、插件代发的消息、交接单、任务通知、用户的审批操作、工具调用和结果的开头；
// 不收宿主每步注入的技能、记忆召回、规则提示等上下文：那些不是对话，却占原日志的九成。
const TRANSCRIPT_TOOL_CLIP = 300;
// 向用户提问的问题和用户的回答保留全文。
const ASK_TOOL = /ask_user_question/;
export function renderTranscript(log, { sessionId, title, cwd, at }) {
  const events = Array.isArray(log) ? log : [];
  const asks = new Set();
  const names = new Map();
  const counts = { user: 0, assistant: 0, tools: 0 };
  const entries = [];
  let first, last;
  const line = (text, full) => (full ? text : clip(text.replace(/\s+/g, ' '), TRANSCRIPT_TOOL_CLIP));
  for (const event of events) {
    const data = event?.data ?? {};
    let entry;
    if (event?.type === 'user/message') {
      const source = data.source ?? {};
      const text = textOf(data.content).trim();
      const label = !text ? undefined
        : source.kind === 'user' ? (String(source.rpcId ?? '').startsWith('handover-') ? '交接单（插件投递）'
          : source.via ? `插件代发（${source.via}）` : MACHINE_USER_TEXT.test(text) ? '自动消息' : '用户')
        : source.kind === 'tool-jobs' ? '任务通知' : source.kind === 'user-approval' ? '用户操作'
        : String(source.kind ?? '').includes('auto-continue') ? '自动续跑' : undefined;
      if (!label) continue;
      if (label === '用户') counts.user++;
      entry = `### ${timeOf(event)} ${label}\n\n${text}`;
    } else if (event?.type === 'assistant/message') {
      const text = textOf(data.message?.content).trim();
      if (!text) continue;
      counts.assistant++;
      entry = `### ${timeOf(event)} 助手（回合 ${data.turn ?? '?'}）\n\n${text}`;
    } else if (event?.type === 'tool/call') {
      const args = typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {});
      const ask = ASK_TOOL.test(`${data.name} ${args}`);
      names.set(data.callId, data.name);
      if (ask) asks.add(data.callId);
      counts.tools++;
      entry = `- ${timeOf(event)} 调用 ${data.name}：${line(args, ask)}`;
    } else if (event?.type === 'tool/result') {
      const message = data.message ?? {};
      entry = `- ${timeOf(event)} 结果 ${names.get(message.toolCallId) ?? '?'}${message.isError ? '（出错）' : ''}：` +
        line(textOf(message.content), asks.has(message.toolCallId));
    } else continue;
    first ??= timeOf(event);
    last = timeOf(event);
    entries.push(entry);
  }
  const text = [`# 会话原文：${sessionId}`, '',
    `- 标题：${title || '（无）'}`, `- 工作目录：${cwd ?? '（未知）'}`,
    `- 导出时间：${at}；时间范围 ${first ?? '无'} 至 ${last ?? '无'}；用户消息 ${counts.user} 条，助手回复 ${counts.assistant} 条，工具调用 ${counts.tools} 次。`,
    `- 按时间顺序。工具调用的参数和结果只留开头 ${TRANSCRIPT_TOOL_CLIP} 字符（向用户提问的问题和回答保留全文）；宿主注入的技能、记忆召回、规则提示等上下文不在其中。`,
    '', ...entries.flatMap((entry) => [entry, ''])].join('\n');
  return { text, ...counts, first: first ?? null, last: last ?? null };
}

// 交接出去的会话各导出一份原文；更早的前任没有原文的（0.9.202 之前交接的），从宿主的会话记录补一次。
// shortcut: 前任的原文只在它交接时导出一次；用户之后再在已交接的旧会话里说话，那部分不会补进原文，需要时改成按日志长度重导。
async function writeTranscripts({ directory, aliases, from, agentA, readSession, at }) {
  const write = (sessionId, log, title, cwd) => {
    const file = transcriptPath(directory, sessionId);
    const { text, ...stats } = renderTranscript(log, { sessionId, title, cwd, at });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeTextAtomic(file, text);
    return { sessionId, file, ...stats };
  };
  const list = [];
  for (const id of aliases.predecessors(from).reverse()) {
    const file = transcriptPath(directory, id);
    if (fs.existsSync(file)) { list.push({ sessionId: id, file }); continue; }
    try {
      const events = (await readSession(id))?.events;
      if (!Array.isArray(events)) throw new Error('session log unavailable');
      const header = events.find((event) => event?.type === 'session');
      const title = events.findLast((event) => event?.type === 'session/title')?.data?.title;
      list.push(write(id, events, title, header?.cwd));
    } catch (error) { list.push({ sessionId: id, error: String(error?.message ?? error) }); }
  }
  if (!Array.isArray(agentA.session?.log)) throw new Error(`session log unavailable: ${agentA.id}`);
  const events = agentA.session.log.length;
  list.push({ ...write(from, agentA.session.log.slice(0, events), titleOf(agentA), agentA.session.header?.cwd), events });
  return list;
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
  } else {
    // 0.9.198 之前的档案把交接单和重启续跑话术也记成了用户指令，读出时剔除。
    entries = entries.filter((entry) => !MACHINE_USER_TEXT.test(String(entry?.text ?? '')));
  }
  append(agentA);
  entries.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, entries);
  return { root, file, count: entries.length, first: entries[0]?.at ?? null, last: entries.at(-1)?.at ?? null, entries };
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

// 交接单除“旧会话写的交接摘要”一节外，都用插件和 runner 已有的记录、旧会话日志机械生成，不经模型。
export function buildBrief({ from, to, at, cwd, goal, jobs, pending, since, note, origin = 'file', requestedAt = at, autoContinue,
  successorGoal, context, instructionArchive, instructionError, transcripts, transcriptError, sessionRead = false, summary, limit = BRIEF_LIMIT }) {
  const running = jobs.filter((j) => (j.execution_status ?? j.status) === 'running');
  const open = (j) => (j.execution_status ?? j.status) === 'running' || pending.unreviewed.includes(j.job_id) || pending.needsChanges.includes(j.job_id);
  // 表里只放任务号（job_id）：续接、核验、验收都靠它。线程号只列给需要带 resume 返工的任务，免得被当成任务号。
  const row = (j) => `| ${j.job_id} | ${j.execution_status ?? j.status ?? '?'} | ${j.verification_status ?? '?'} | ` +
    `${j.review_status === 'needs_attention' ? '有标记' : '-'} | ${j.parent_job_id ?? '-'} | ${j.cwd ?? '-'} | ` +
    `${j.diff_status ?? '-'} | ${firstLine(j.context?.task).replace(/\|/g, '/')} |`;
  const threads = jobs.filter((j) => pending.needsChanges.includes(j.job_id) && j.thread_id);
  const taskSection = () => {
    // jobs 按开始时间从新到旧；只列未结束、待验收、需修改的任务和最近 10 单非核验任务，其余用 codex_jobs 查。
    let recent = 0;
    const chosen = jobs.filter((j) => (!j.context?.verification_of && recent++ < 10) || open(j));
    const checks = jobs.filter((j) => j.context?.verification_of).length;
    const rows = fit(chosen.map(row), 8000);
    return [`## 任务（收尾截止时间 ${new Date(since * 1000).toISOString()} 之后开始，共 ${jobs.length} 单，其中核验单 ${checks} 单）`, '',
      '这里只列未结束、待验收、需修改的任务和最近 10 单非核验任务；完整列表用 codex_jobs（session_id="current"）。',
      '任务号（job_id）用于 codex_status、codex_output、codex_review、codex_verify、codex_continue 的 job_id 参数。', '',
      '| 任务号 job_id | 执行 | 验收 | 报告 | 续接自（任务号） | 目录 | diff | 任务首行 |', '|---|---|---|---|---|---|---|---|',
      ...rows, ...truncated(chosen.length, rows.length),
      ...(threads.length ? ['', '### 返工用的线程号', '线程号（thread_id）不是任务号，只用于 codex_run 的 resume 参数；不要传给其他工具的 job_id。', '',
        ...threads.map((j) => `- 任务 ${j.job_id} 的线程号：${j.thread_id}`)] : [])].join('\n');
  };
  const rounds = Number.isSafeInteger(goal?.maxGoalRounds) ? Math.max(1, goal.maxGoalRounds - (goal.roundsStarted ?? 0)) : undefined;
  const hasGoal = goal && goal.phase !== 'complete' && typeof goal.objective === 'string';
  const goalSection = !hasGoal ? ['## 目标', '原会话没有进行中的目标。'] : ['## 目标',
    successorGoal === 'exists' ? '- 本会话已有自己的目标，没有用原会话的目标覆盖；以 get_goal 返回的为准。'
      : successorGoal === 'kept' ? `- 原会话的目标交接时处于 ${goal.phase} 状态，不是在推进的目标，没有在本会话重建。不要自行创建或推进它，等用户指示。`
      : `- 目标已在本会话逐字重建${rounds ? `，上限 ${rounds} 轮` : ''}（原会话状态 ${goal.phase}，已用 ${goal.roundsStarted ?? '?'} / ${goal.maxGoalRounds ?? '?'} 轮）；以 get_goal 返回的为准。`,
    `- 目标开头：${clip(goal.objective, 200)}`];
  const instructions = context?.instructions ?? [];
  const items = fit(instructions.map((m) => `- ${m.at}：${m.text.replace(/\n/g, '\n  ')}`), 8000);
  const sections = [
    { priority: 1, title: '下一步', lines: ['## 下一步', note ? note : '未指定；按目标继续，先完成“待收尾”。'] },
    ...(summary?.text ? [{ priority: 1.5, title: '旧会话写的交接摘要', lines: ['## 旧会话写的交接摘要',
      `旧会话按它的完整上下文在交接前写成（${summary.at ?? at}）；与任务记录或用户指令冲突时，以记录和用户原话为准。`, '', clip(summary.text, 6000)] }] : []),
    { priority: 2, title: '目标', lines: goalSection },
    // 日志读取超时时，档案里的指令照样能列；进展只能从日志读，随之省略。
    ...(context && (!context.timedOut || context.instructions) ? [
      { priority: 3, title: '最近的用户指令', lines: ['## 最近的用户指令（本会话链里人工输入的消息，最近的在前）',
        '以下是用户亲手输入的要求，仍然有效，除非与“下一步”或更新的指令冲突。',
        ...(items.length ? [...items, ...truncated(instructions.length, items.length)] : ['（没有找到）'])] }] : []),
    ...(context && !context.timedOut && (context.progress || context.lastTurn) ? [{ priority: 4, title: '旧会话最后的进展', lines: ['## 旧会话最后的进展',
      ...(context.lastTurn ? [`- 最后一个回合：结束原因 ${context.lastTurn.reason}，${context.lastTurn.at}`] : []),
      ...(context.latest ? [`- 最后一个回合没有正常结束，它最后的助手文字（${context.latest.at}，前 1500 字符）：`, '', context.latest.text, ''] : []),
      ...(context.progress ? [`- 最后一个正常结束回合的助手回复（${context.progress.at}，前 1500 字符）：`, '', context.progress.text] : [])] }] : []),
    // 待收尾很短却是接手时最要紧的，与“下一步”同为 1，永不省略。
    { priority: 1, title: '待收尾', lines: ['## 待收尾',
      `- 报告有标记、尚未 codex_review：${fit(pending.unreviewed, 1000).join('、') || '无'}`,
      `- needs_changes 尚未结案，最新轮次：${fit(pending.needsChanges, 1000).join('、') || '无'}`,
      ...(running.length ? ['- 仍在运行（这些任务随交接转给本会话：用 codex_status 等待并验收，不要重派；结束通知会转到本会话）：',
        ...running.map((j) => `  - ${j.job_id}：${firstLine(j.context?.task, 60).replace(/\|/g, '/') || '（无标题）'}` +
          `${Number.isFinite(j.started_at) ? `（已运行 ${Math.max(0, Math.round((Date.parse(at) / 1000 - j.started_at) / 60))} 分钟）` : ''}`)]
        : ['- 仍在运行：无'])] },
    { priority: 5.5, title: '任务', lines: [taskSection()] },
    // 原文是交接后不丢上下文的底：这一节很短，与“下一步”同为 1，永不省略。
    { priority: 1, title: '旧会话原文', lines: ['## 旧会话原文（完整对话，随时回查）',
      '交接单和摘要只是概括，具体内容以原文为准。' + (transcripts?.length
        ? '本会话链上每个旧会话的完整对话都导出成了文件（用户原话、助手回复、插件代发的消息、任务通知、工具调用和结果的开头），最近的在前：'
        : `旧会话的原文没能导出（${transcriptError ?? '未知原因'}），只能用下面的工具回查。`),
      ...[...transcripts ?? []].reverse().map((t) => (t.error ? `- ${t.sessionId}：原文没能导出（${t.error}）` + (sessionRead ? '，用 session_read 查。' : '。')
        : `- ${t.sessionId}${t.first ? `（${t.first} 至 ${t.last}，用户消息 ${t.user} 条，助手回复 ${t.assistant} 条）` : ''}：${t.file}`)),
      '用户提到以前说过、做过、定过的事，或者你要做的决定以前可能讨论过时：先用 grep 搜关键词，path 逐个填上面的文件' +
        `（例如 grep(pattern="关键词", path="${[...transcripts ?? []].reverse().find((t) => t.file)?.file ?? '上面的文件'}")；整个 handovers 目录不能搜），` +
        '再用 read 读命中处附近的原文核对，然后再回答或行动。不要凭印象作答，也不要让用户重复已经说过的话；这些文件你自己就能读，不必派任务去读。',
      `- 旧会话 ID：${from}（已冻结，只能查看）`,
      ...(sessionRead ? [`- 也可以用 session_read 回查：session_read(sessionId="${from}", mode="search", query="关键词")；mode="summary" 看结构化摘要，mode="tail" 看最后若干事件。`] : []),
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
    ...(context?.timedOut ? [`- 读取旧会话日志超时，省略了${context.instructions ? '' : '“最近的用户指令”和'}“旧会话最后的进展”。`] : []),
    ...(summary && !summary.text ? [`- 旧会话没有写出交接摘要（${summary.status}），以下各节由插件按记录生成。`] : []),
    ...(omitted.length ? [`- 本单超过 ${limit} 字符，省略了：${omitted.join('、')}。`] : [])].join('\n');
  const render = (list, omitted) => [header(omitted), ...list.map((s) => s.lines.join('\n'))].join('\n\n') + '\n';
  let kept = sections;
  let text = render(kept, []);
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
const handoverMessage = (from, briefPath, brief, loopx, keptGoal = false, transcripts = false) =>
  (loopx ? `/loopx 这是会话交接后的续接，不是新任务：原会话 ${from} 的 LoopX 绑定（goal ${loopx.goalId}，agent ${loopx.agentId}）已挪到本会话。` +
    '不要新建 LoopX 目标，也不要创建原生目标；先用 resolve-agent-thread 核对本会话的绑定。\n' : '') +
  `[codex-conductor 交接] 本会话接手会话 ${from} 的工作；原会话的目标已暂停，` +
  '它不能再派活或验收。下面是插件按记录生成的交接单' + (briefPath ? `（文件：${briefPath}）` : '') + '。\n' +
  (transcripts ? '交接单只是概括，旧会话的完整对话原文见其中“旧会话原文”一节：用户提到以前的事，或你拿不准以前怎么定的，先查原文再回答，' +
    '不要凭印象，也不要让用户重复已经说过的话。\n' : '') +
  '先调 codex_summary（session_id="current"）和 codex_jobs 看详情：本会话现在可以查看、验收、续接、核验和取消原会话的任务。' +
  '工具的 job_id 参数只填交接单里的任务号；线程号只用于 codex_run 的 resume。' +
  '收尾规则照旧：先给列出的待收尾任务做 codex_review 或返工，再派新任务。' +
  (loopx ? '本轮只核对绑定、读完交接单并处理待收尾任务，然后结束；之后由 LoopX 按待办续跑。'
    : keptGoal ? '原会话的目标是暂停或受阻状态，没有在本会话重建；不要自行创建或推进它，处理完待收尾任务后等用户指示。'
    : '本会话若还没有目标，按交接单里的目标创建后继续推进。') +
  '\n\n' + brief;

// LoopX 跟随交接：原会话绑着 LoopX 线程时，把绑定挪给继任会话。原生目标和 LoopX 都在推进的会话也挪：绑定留在已交接的会话上，
// LoopX 会接着唤醒它（11-22 一次交接后 3 秒原会话就被 LoopX 拉起，空跑了一个回合）。
// loopx(args, cwd) 运行 LoopX CLI 并返回解析后的 JSON，失败时抛出。这里的任何失败都只记在步骤里，不影响交接。
const LOOPX_HOST = 'deepseek-harness-native';
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
// 交接前让旧会话按它的完整上下文写交接摘要。此时目标已暂停，链接还没建（等摘要时宿主重启也不会留下没有交接单的继任会话）。
// index.mjs 据 summarizing 拒绝这一回合的所有工具调用、最多放行 SUMMARY_MAX_STEPS 步、不发防虚报提醒，自动交接也不掐断它；
// 过了时限，这一回合在下一步之前结束。
export const summarizing = new Map();
export const SUMMARY_MAX_STEPS = 3;
const SUMMARY_TAG = '[codex-conductor 交接摘要]';
const summaryPrompt = () => `${SUMMARY_TAG} 本会话即将交接给一个新会话。新会话开头只看到你现在写的摘要和插件按记录生成的交接单；这里的对话原文会导出成文件，但它要自己去查，摘要里没写的它多半不知道。` +
  '请只用文字写一份交接摘要，不要调用任何工具（本回合的工具调用都会被拒绝），写完就结束本回合。按下面五节写，每节只写确有的内容，总长不超过 3000 字：\n' +
  '1. 用户要什么：总目标，以及对话里提出、仍然有效的要求、偏好和禁止事项（尽量保留用户原话）。\n' +
  '2. 已经做成的事和关键决定（附理由）。\n' +
  '3. 进行到哪：被打断时正在做什么、做到哪一步，哪些任务还在跑或待验收（写任务号）。\n' +
  '4. 下一步：接下来该做什么，先做哪件。\n' +
  '5. 注意事项：踩过的坑、走不通的路、需要等用户决定的事。';

function summaryReply(log, id) {
  const events = Array.isArray(log) ? log : [];
  // 宿主一般沿用提交时的消息 id；万一换了 id，按固定开头认。
  const start = events.findLastIndex((e) => e?.type === 'user/message' &&
    (e.data?.id === id || textOf(e.data?.content).startsWith(SUMMARY_TAG)));
  if (start < 0) return {};
  const texts = [];
  let at;
  for (let i = start + 1; i < events.length; i++) {
    const event = events[i];
    if (event?.type === 'assistant/message') {
      const text = textOf(event.data?.message?.content).trim();
      if (text) { texts.push(text); at = timeOf(event); }
    } else if (event?.type === 'turn/end') return { ended: true, reason: event.data?.reason?.kind ?? '未知', text: texts.join('\n\n'), at };
  }
  return { text: texts.join('\n\n'), at };
}

// 返回 { status, text?, at? }：written / timeout_partial 带摘要；off、unavailable、turn_running、empty:<结束原因>、timeout、failed:<原因> 不带。
export async function requestSummary(agent, { timeoutMs, pollMs = 1_000, graceMs = 60_000, now = Date.now } = {}) {
  if (!(timeoutMs > 0)) return { status: 'off' };
  if (typeof agent?.followup !== 'function') return { status: 'unavailable' };
  if (agent.status === 'running') return { status: 'turn_running' };
  const id = randomUUID();
  const entry = { id, deadline: now() + timeoutMs, steps: 0 };
  summarizing.set(agent.id, entry);
  let outcome;
  let ended = false;
  try {
    // via 标出插件代发：不算用户指令，不进档案。
    agent.followup({ id, role: 'user', content: [{ type: 'text', text: summaryPrompt() }], source: { kind: 'user', via: 'codex-conductor-handover-summary' } });
    for (;;) {
      const found = summaryReply(agent.session?.log, id);
      if (found.ended) {
        ended = true;
        outcome = found.text ? { status: 'written', text: found.text, at: found.at } : { status: `empty:${found.reason}` };
        break;
      }
      if (now() > entry.deadline) entry.expired = true;
      if (now() > entry.deadline + graceMs) {
        outcome = found.text ? { status: 'timeout_partial', text: found.text, at: found.at } : { status: 'timeout' };
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } catch (error) {
    outcome = { status: `failed:${error?.message ?? error}` };
  } finally {
    // 摘要回合还没结束就留着（已过期）记录，会话转为空闲时由 index.mjs 清掉。
    if (!ended && agent.status === 'running') entry.expired = true;
    else summarizing.delete(agent.id);
  }
  return outcome;
}

// 摘要回合的步骤闸门（index.mjs 的 pre-step 调用）：过期或超过步数时返回 true，表示结束这一回合。
export function summaryStepRejected(agentId, now = Date.now) {
  const entry = summarizing.get(agentId);
  if (!entry) return false;
  entry.steps++;
  return Boolean(entry.expired || now() > entry.deadline || entry.steps > SUMMARY_MAX_STEPS);
}

async function deliver(controller, sessionId, text, waitMs, requestId, signal) {
  try {
    const call = controller.prompt({ requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] },
      signal);
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
// 宿主 HMR 用 AsyncLocalStorage 标记“正处在一次重载事务里”，带着这个标记的调用一律被拒为“不能嵌套”，重试多少次都一样。
// 插件热加载时建的请求监视器，回调继承了加载那次事务的上下文，交接里写设置因此总被拒；宿主自己的配置监视器也是先 executing.exit() 再建。
export function outsideHmr(hmr) {
  const store = hmr?.executing;
  return typeof store?.exit === 'function' ? (fn) => store.exit(fn) : (fn) => fn();
}
export function autoContinueFromSettings(settings, outside = (fn) => fn()) {
  return (sessionId) => {
    const entry = settings?.describe?.().find((form) => form.ns === AUTO_CONTINUE_ENTRY);
    if (!entry) return undefined;
    const modes = entry.value?.sessionModes;
    const previous = modes && typeof modes === 'object' && Object.hasOwn(modes, sessionId) ? modes[sessionId] : null;
    const writable = settings.writable !== false && typeof settings.mutate === 'function';
    return { previous, ...(writable ? { setMode: (mode) => outside(() => settings.mutate(AUTO_CONTINUE_ENTRY, [mode === null
      ? { op: 'unset', path: ['sessionModes', sessionId] } : { op: 'set', path: ['sessionModes', sessionId], value: mode }])) } : {}) };
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
  base = [...base.replace(/^\[已交接→[^\]]*\]\s*/, '').replace(/^\[交接←[^\]]*\]\s*/, '')].slice(0, 40).join('').trim();
  return base ? `[交接←${short}] ${base}` : `[交接←${short}]`;
}

// 交接出去的旧会话：[已交接→<继任短 id>] <原标题前 40 字符>，侧栏里一眼能看出它已停用；撤回时改回原标题。
export function retiredTitle(toId, fromTitle) {
  const short = String(toId).replace(/^session-/, '').slice(0, 8);
  const base = [...String(fromTitle ?? '').trim().replace(/^\[已交接→[^\]]*\]\s*/, '').replace(/^\[交接←[^\]]*\]\s*/, '')]
    .slice(0, 40).join('').trim();
  return base ? `[已交接→${short}] ${base}` : `[已交接→${short}]`;
}

async function renameSession(controller, sessionId, title) {
  if (typeof controller?.rename !== 'function') return 'unavailable';
  try {
    await controller.rename({ sessionId, title });
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
          entry.title = await renameSession(controller, to, successorTitle(link.from, titleOf(await resolve(link.from))));
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
export async function checkHandover({ goals, agentA, agentB, goal, steps, jobs, pending, sessionJobs, aliases, from, to, registry, instructionArchive, transcripts }) {
  const checks = {};
  const hasGoal = goal && goal.phase !== 'complete' && typeof goal.objective === 'string';
  if (steps.successorGoal === 'user_stopped') checks.goal = 'skipped:user_stopped';
  else if (steps.successorGoal === 'loopx') checks.goal = 'skipped:loopx';
  else if (!hasGoal) checks.goal = 'skipped:no_goal';
  else if (steps.successorGoal === 'exists') checks.goal = 'skipped:successor_had_goal';
  else if (steps.successorGoal?.startsWith('kept_')) checks.goal = 'skipped:goal_not_active';
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
  // 原文不缺：导出时旧会话里的每条用户原话和助手回复都能在原文文件里找到。
  checks.transcripts = steps.transcripts ?? 'skipped';
  const own = transcripts?.find((t) => t.sessionId === from && t.file);
  if (own) {
    try {
      const text = fs.readFileSync(own.file, 'utf8');
      const said = (agentA.session?.log ?? []).slice(0, own.events).map((event) => (event?.type === 'assistant/message'
        ? textOf(event.data?.message?.content) : humanInstruction(event)?.text ?? '').trim()).filter(Boolean);
      // 原文按日志顺序写，顺着往后找：长会话（上万条、数 MB）也只扫一遍。
      let at = 0, lost = 0;
      for (const line of said) {
        const found = text.indexOf(line, at);
        if (found < 0) lost++;
        else at = found + line.length;
      }
      checks.transcripts = lost ? `failed:missing_${lost}_of_${said.length}` : steps.transcripts === 'written' ? 'ok' : steps.transcripts;
    } catch (error) { checks.transcripts = `failed:${error?.message ?? error}`; }
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
  for (const seen = new Set([id]); to && !seen.has(to) && aliases.successor(to);) {
    seen.add(to);
    to = aliases.successor(to);
  }
  return to;
}

// 宿主 tool-jobs 在任务结束时把通知发给任务属主（交接前派出的任务属主仍是前任）：属主空闲就直接开一个新回合。
// 交接出去的会话收到 Codex 任务的结束通知时，在回合第一步之前把通知转给链路末端的继任会话；本回合只有这些通知时
// 返回 reject，前任以 blocked 结束这一回合，不调用模型。撤回后前任不再有继任，通知照常留给它自己。
export async function forwardRetiredNotices({ agent, messages, aliases, jobs, resolve, allowed = () => true, hold }) {
  const successor = lastSuccessor(aliases, agent?.id);
  if (!successor || !Array.isArray(messages)) return undefined;
  const codex = new Map((jobs?.list?.(agent.id) ?? []).filter((job) => job.kind === 'codex' && /^Codex /.test(job.label ?? '')).map((job) => [job.id, job]));
  const notices = messages.filter((m) => m?.source?.kind === 'tool-jobs' && m.source.form === 'notice' &&
    codex.has(/^background job (\S+)(?:\s|$)/.exec(textOf(m.content))?.[1]));
  if (!notices.length) return undefined;
  const forwarded = new Set();
  try {
    const target = await resolve(successor);
    if (target) {
      const groups = [[], []];
      for (const notice of notices) {
        const job = codex.get(/^background job (\S+)(?:\s|$)/.exec(textOf(notice.content))?.[1]);
        groups[await allowed(target, job) ? 0 : 1].push(notice);
      }
      const wrap = (group, id) => ({ id, role: 'user', content: [{ type: 'text', text:
        `[codex-conductor] 原会话 ${agent.id} 交接前派出的任务已结束，通知转到本会话；用 codex_status / codex_output 查看并验收：\n\n` +
        group.map(notice => textOf(notice.content)).join('\n\n') }], source: { kind: 'plugin:codex-conductor' } });
      const retain = async (group) => {
        for (const notice of group) {
          try {
            await hold(target, wrap([notice], notice.id));
            forwarded.add(notice);
          } catch {}
        }
      };
      for (const [deferred, group] of groups.entries()) {
        if (!group.length) continue;
        if (deferred) {
          if (hold) await retain(group);
          continue;
        }
        const message = wrap(group, randomUUID());
        try {
          if (target.status === 'idle') await target.followup(message);
          else await target.inject(message);
          for (const notice of group) forwarded.add(notice);
        } catch { if (hold) await retain(group); }
      }
    }
  } catch {}
  const delivered = forwarded.size === notices.length;
  // A partial failure leaves only unsent originals for the caller, so successful groups cannot be resent.
  if (!delivered && forwarded.size) {
    for (let i = messages.length - 1; i >= 0; i--) if (forwarded.has(messages[i])) messages.splice(i, 1);
  }
  return { successor, delivered, forwarded: forwarded.size, reject: delivered && notices.length === messages.length };
}

export async function handOver(ctx, deps, request) {
  const { aliases, sessionJobs, pendingOf, since, directory, deliverWaitMs = 8_000, autoContinue,
    disableAutoContinue: turnOffAutoContinue = true, autoMessage, sessionRead = () => false, contextDeadlineMs, workspaces = () => undefined, withRunningJobs = false,
    loopx, summaryMinutes, summaryOptions, allowed = () => true } = deps;
  const result = { status: 'refused', from: request.from ?? request.revert?.from, to: request.to ?? request.revert?.to ?? null, steps: {} };
  const refuse = (reason, extra = {}) => Object.assign(result, { status: 'refused', reason, ...extra });
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
    if (link.deliveryRequestId) revokeHandover(directory, to, link.deliveryRequestId);
    aliases.unlink(from, to);
    result.status = 'reverted';
    result.steps.alias = 'removed';
    // 回到原会话：暂停后继的目标、恢复原会话被暂停的目标；后继交接后派出的任务仍归后继。
    for (const [id, key, want] of [[to, 'successorGoal', 'pause'], [from, 'predecessorGoal', 'resume']]) {
      try {
        const agent = await agentOf(id);
        const goal = goals?.get(agent);
        if (want === 'pause' && goal?.phase === 'active') { goals.pause(agent, ref(goal)); result.steps[key] = 'paused'; }
        // 只恢复这次交接自己暂停的那个目标；用户暂停的不动（旧链接没有 goalPaused，照旧恢复）。
        else if (want === 'resume' && (!request.rollback || allowed(agent)) && goal?.phase === 'paused' && (!Object.hasOwn(link, 'goalPaused') || link.goalPaused === goal.id)) {
          goals.resume(agent, ref(goal)); result.steps[key] = 'resumed';
        }
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
    // 交接时改成 [已交接→…] 的旧会话标题改回原名；用户之后自己改过的不动。
    if (link.retiredTitle) {
      try {
        result.steps.predecessorTitle = titleOf(await agentOf(from)) === link.retiredTitle
          ? (await renameSession(controller, from, link.fromTitle) === 'set' ? 'restored' : 'restore_failed') : 'unchanged';
      } catch (error) { result.steps.predecessorTitle = `failed: ${error.message}`; }
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
  const stoppedSince = (agent, offset) => agent.session?.log?.slice(offset).some(event => event?.type === 'turn/end' &&
    event.data?.reason?.kind === 'aborted' && event.data.reason.reason?.kind === 'user');
  const originalLogStart = agentA.session?.log?.length ?? 0;
  const stopped = () => stoppedSince(agentA, originalLogStart) || (request.origin === 'auto' && !allowed(agentA));
  if (stopped()) return refuse('user_stopped');
  const taken = aliases.successor(from);
  if (taken) return refuse('already_handed_over', { successor: taken });
  if (!force && agentA.status === 'running') return refuse('turn_running');
  let jobs;
  try { jobs = await sessionJobs(from); } catch (error) { return refuse('jobs_unreadable', { error: String(error?.message ?? error) }); }
  const running = jobs.filter((j) => (j.execution_status ?? j.status) === 'running').map((j) => j.job_id);
  // 带任务交接（withRunningJobs）：运行中的任务随交接转给继任，结束通知由插件转投；有回合在跑时仍然拒绝。
  if (!force && !withRunningJobs && running.length) return refuse('jobs_running', { running });
  if (stopped()) return refuse('user_stopped');
  const goal = goals?.get(agentA);
  // 只重建原会话正在推进的目标：用户暂停或受阻的目标不在继任会话复活（自动交接自己刚暂停的那一版除外）。
  const pursued = goal?.phase === 'active' || (goal?.phase === 'paused' && goal.id === request.pausedGoal?.id);
  const keptGoal = Boolean(goal && !pursued && goal.phase !== 'complete');
  const header = agentA.session?.header ?? {};
  // 先停原会话的目标，再写摘要、让新会话开工，避免两边同时推进。摘要写在建链接之前：
  // 等摘要时宿主若重启，旧会话只是目标暂停、历史都在，不会留下一个没收到交接单的继任会话。
  if (goal?.phase === 'active') {
    try { goals.pause(agentA, ref(goals.get(agentA))); result.steps.predecessorGoal = 'paused'; }
    catch (error) { result.steps.predecessorGoal = `failed: ${error.message}`; }
  } else result.steps.predecessorGoal = goal ? `unchanged_${goal.phase}` : 'none';
  // 摘要之后没交接成：把这里暂停的目标恢复（自动交接提前暂停的那一版由 settled 恢复）。
  const giveBack = (reason, extra) => {
    if (result.steps.predecessorGoal === 'paused' && !stopped()) {
      try { goals.resume(agentA, ref(goals.get(agentA))); result.steps.predecessorGoal = 'resumed'; }
      catch (error) { result.steps.predecessorGoal = `failed: ${error.message}`; }
    }
    return refuse(reason, extra);
  };
  // 旧会话的进展在摘要回合之前读：否则摘要回合会成了“最后一个正常结束的回合”。
  const context = sessionContext(agentA.session?.log, { autoMessage, ...(contextDeadlineMs !== undefined ? { deadlineMs: contextDeadlineMs } : {}) });
  const summary = await requestSummary(agentA, { timeoutMs: (summaryMinutes ?? 0) * 60_000, ...summaryOptions });
  if (stopped()) return giveBack('user_stopped');
  if (summary.status !== 'off') result.steps.summary = summary.status;
  // 摘要之后会话又开了新回合（用户发话等）就不交接；超时还没停的摘要回合不算，它下一步之前就会被结束，工具也都被拒。
  if (!force && agentA.status === 'running' && !summarizing.get(agentA.id)?.expired) return giveBack('turn_running');
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
  } catch (error) { return giveBack('successor_unavailable', { error: String(error?.message ?? error) }); }
  const successorLogStart = agentB.session?.log?.length ?? 0;
  if (request.to && !force && agentB.status === 'running') return giveBack('successor_turn_running');
  // 记下继任会话此刻的消息数和回合数：撤回保护和自动交接的再次触发都以它为基数。
  const base = logCounts(agentB.session?.log);
  const { origin, requestedAt } = request;
  try { aliases.link(from, to, { origin, requestedAt, toMessages: base.messages, toTurns: base.turns }); }
  catch (error) { return giveBack('alias_failed', { error: error.message }); }
  result.status = 'handed_over';
  result.steps.alias = 'linked';
  // 继任会话进原会话的分组、排在它上方；新建的继任会话改成能看出来源的标题（在交接单送达前设，免得被自动标题覆盖）。
  const placed = await placeInWorkspace(workspaces(), from, to);
  result.steps.workspace = placed.workspace;
  if (placed.workspaceId) result.steps.workspaceId = placed.workspaceId;
  if (placed.pin) result.steps.pin = placed.pin;
  if (!request.to) result.steps.title = await renameSession(controller, to, successorTitle(from, titleOf(agentA)));
  // 旧会话改名 [已交接→…]，免得用户在侧栏里看不出来、接着在旧会话里说话；没有标题的不改（撤回时无从改回）。
  const fromTitle = titleOf(agentA);
  const retired = typeof fromTitle === 'string' && fromTitle.trim() ? retiredTitle(to, fromTitle) : undefined;
  if (retired) result.steps.predecessorTitle = await renameSession(controller, from, retired);
  const autoContinueStep = turnOffAutoContinue ? await disableAutoContinue(autoContinue, from) : {};
  if (autoContinueStep.autoContinue) result.steps.autoContinue = autoContinueStep.autoContinue;
  // 原会话绑着 LoopX：绑定随交接挪给继任会话，继任会话由 LoopX 接着跑，不重建原生目标。
  const follow = loopx ? await moveLoopxBinding(loopx, header.cwd, from, to) : undefined;
  if (follow) result.steps.loopx = follow.loopx;
  const followed = follow?.loopx === 'moved' ? { goalId: follow.goalId, agentId: follow.agentId } : undefined;
  const pending = pendingOf(jobs);
  Object.assign(result, { pending, running });
  const at = new Date().toISOString();
  const existingGoal = goals?.get(agentB);
  try {
    aliases.annotate(to, {
      ...(placed.workspaceId ? { workspaceId: placed.workspaceId } : {}), ...(placed.pin === 'pinned' ? { pinned: true } : {}),
      ...(result.steps.autoContinue ? { autoContinue: result.steps.autoContinue } : {}),
      ...(Object.hasOwn(autoContinueStep, 'previous') ? { autoContinuePrevious: autoContinueStep.previous } : {}),
      ...(followed ? { loopx: followed } : {}),
      ...(result.steps.predecessorTitle === 'set' ? { fromTitle, retiredTitle: retired } : {}),
      goalPaused: pursued && (result.steps.predecessorGoal === 'paused' || goal.phase === 'paused') ? goal.id : null });
  } catch (error) { result.steps.linkNote = `failed: ${error.message}`; }
  let chain;
  try {
    const { entries, ...archive } = await archiveInstructions({ directory, aliases, from, agentA, agentOf });
    chain = entries;
    aliases.annotate(to, { instructions: { root: archive.root, count: archive.count } });
    result.instructions = archive;
    result.steps.instructions = 'written';
  } catch (error) { result.steps.instructions = `failed:${error?.message ?? error}`; }
  // 最近的用户指令取整条会话链：用户没在上一个会话里打字时，更早会话里的要求照样列出。
  if (chain) context.instructions = recentInstructions(chain, autoMessage);
  try {
    const query = ctx.get('sessionQuery');
    result.transcripts = await writeTranscripts({ directory, aliases, from, agentA, at,
      readSession: async (id) => { if (typeof query?.readSession !== 'function') throw new Error('sessionQuery unavailable'); return query.readSession(id); } });
    const missing = result.transcripts.filter((t) => t.error).length;
    result.steps.transcripts = missing ? `partial:${missing}` : 'written';
  } catch (error) { result.steps.transcripts = `failed:${error?.message ?? error}`; }
  const brief = buildBrief({ from, to, at, cwd: header.cwd, goal, jobs, pending, since, note, origin, requestedAt,
    autoContinue: result.steps.autoContinue,
    successorGoal: existingGoal && existingGoal.phase !== 'complete' ? 'exists' : keptGoal ? 'kept' : undefined,
    context, summary: summary.status === 'off' ? undefined : summary,
    instructionArchive: result.instructions, instructionError: result.instructions ? undefined : result.steps.instructions.slice(7),
    transcripts: result.transcripts, transcriptError: result.transcripts ? undefined : result.steps.transcripts.slice(7),
    sessionRead: sessionRead() });
  try {
    const dir = path.join(directory, 'handovers');
    fs.mkdirSync(dir, { recursive: true });
    result.briefPath = path.join(dir, `${at.replace(/[:.]/g, '-')}-${from}-to-${to}.md`);
    fs.writeFileSync(result.briefPath, brief);
  } catch (error) { result.steps.brief = `failed: ${error.message}`; delete result.briefPath; }
  let deliveryRequestId;
  const deliveryController = new AbortController();
  const rollbackStopped = async () => {
    if (deliveryRequestId) {
      revokeHandover(directory, to, deliveryRequestId);
      deliveryController.abort();
    }
    const log = agentB.session?.log ?? [];
    const currentTurn = log.slice(log.findLastIndex(event => event.type === 'turn/start'));
    const handoverTurn = deliveryRequestId && !currentTurn.some(event => event.type === 'turn/end') &&
      currentTurn.some(event => event.type === 'user/message' && event.data?.source?.rpcId === deliveryRequestId);
    if (agentB.status === 'running' && logCounts(log).turns === base.turns + 1 && handoverTurn) {
      const successorGoal = goals?.get(agentB);
      if (successorGoal?.phase === 'active') goals.pause(agentB, ref(successorGoal));
      agentB.cancel({ kind: 'user' }, { keepInbox: true });
      result.steps.successorTurn = 'cancel_requested';
    }
    // A later human question must not restore the goal paused by this stopped handover.
    const back = await handOver(ctx, { ...deps, allowed: agent => agent.id !== from && allowed(agent) },
      { revert: { from, to }, rollback: true, force: true });
    result.rollback = { status: back.status, ...(back.reason ? { refused: back.reason } : {}), steps: back.steps };
    if (back.status !== 'reverted') return Object.assign(result, { status: 'handed_over_with_issues', reason: 'user_stopped' });
    return giveBack('user_stopped');
  };
  if (stopped()) return rollbackStopped();
  deliveryRequestId = `handover-${randomUUID()}`;
  aliases.annotate(to, { deliveryRequestId });
  Object.assign(result.steps, await deliver(controller, to, handoverMessage(from, result.briefPath, brief, followed, keptGoal, Boolean(result.transcripts)), deliverWaitMs, deliveryRequestId, deliveryController.signal));
  if (stopped()) return rollbackStopped();
  if (stoppedSince(agentB, successorLogStart)) result.steps.successorGoal = 'user_stopped';
  else if (followed) result.steps.successorGoal = 'loopx';
  else if (keptGoal) result.steps.successorGoal = `kept_${goal.phase}`;
  else if (!stopped() && goal && goal.phase !== 'complete' && typeof goal.objective === 'string') {
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
  try { aliases.annotate(to, { delivered: result.steps.delivered !== 'failed' }); }
  catch (error) { result.steps.linkNote = `failed: ${error.message}`; }
  // 首条消息没送达，或继任会话的目标没建起来：不留一个没有交接单或没有目标的“继任”，自动撤回一次（不带 force）。
  const broken = result.steps.delivered === 'failed' ? 'delivery_failed' : result.steps.successorGoal.startsWith('failed') ? 'successor_goal_failed' : '';
  if (broken) {
    const back = await handOver(ctx, deps, { revert: { from, to }, force: false, rollback: true, origin });
    result.rollback = { reason: broken, status: back.status, ...(back.reason ? { refused: back.reason } : {}), steps: back.steps };
    result.status = back.status === 'reverted' ? 'rolled_back' : 'handed_over_with_issues';
    if (back.status === 'reverted') return result;
  }
  result.checks = await checkHandover({ goals, agentA, agentB, goal, steps: result.steps, jobs, pending, sessionJobs,
    aliases, from, to, registry: workspaces(), instructionArchive: result.instructions, transcripts: result.transcripts });
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
// 上下文地板：最近 FLOOR_WINDOW 次请求的最小上下文（输入 + 缓存命中 token），且窗口内有压缩成功信号。
const FLOOR_WINDOW = 20;
const promptTokens = (event) => {
  const usage = event?.type === 'assistant/message' ? event.data?.usage : undefined;
  return usage && (Number(usage.inputTokens) || 0) + (Number(usage.cacheReadTokens) || 0) || undefined;
};
export function createHistoryTracker({ directory, threshold, contextThreshold = () => 0, now = Date.now, writeEveryMs = 30_000 }) {
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
    if (!entry || entry.scanned > log.length) entry = { scanned: 0, messages: 0, prompts: [], compressCalls: new Set() };
    for (let i = entry.scanned; i < log.length; i++) {
      const event = log[i];
      if (MESSAGE_TYPES.has(event?.type)) entry.messages++;
      if (event?.type === 'tool/call' && event.data?.name === 'compress') entry.compressCalls.add(event.data.callId);
      else if (event?.type === 'tool/result') {
        const message = event.data?.message;
        if (entry.compressCalls.delete(message?.toolCallId) && !message?.isError &&
          /^\[Compressed [^\r\n]* → [1-9]\d* block\(s\), ~[1-9]\d* tokens saved\./.test(textOf(message?.content))) entry.compressed = true;
      } else if (event?.type === 'compaction/end' && event.data && !event.data.error) entry.compressed = true;
      const tokens = promptTokens(event);
      if (tokens) {
        // 成功压缩后的请求随信号滑出窗口；bili preflight 无宿主事件，不能从输入下降推断压缩。
        entry.prompts = [...entry.prompts.slice(1 - FLOOR_WINDOW), { tokens,
          compressed: entry.compressed === true }];
        entry.compressed = false;
      }
      // 自动交接据此避开用户正在对话的时候：最后一条人工消息的时间，以及当前回合里是否有人工消息。
      if (event?.type === 'turn/start') entry.turnHuman = false;
      // 用户点了停止：直到他再发话、恢复或新建目标、或操作员明确请求续接，这个会话都算“用户叫停的”。
      else if (event?.type === 'turn/end') {
        if (event.data?.reason?.kind === 'aborted' && event.data.reason.reason?.kind === 'user') {
          entry.userStopped = true;
          entry.lastUserStopAt = Number.isFinite(event.time) ? event.time : Infinity;
        }
      } else if (event?.type === 'goal/change') {
        if (['resume', 'create'].includes(event.data?.operation)) {
          entry.userStopped = false;
          delete entry.lastUserStopAt;
        }
      } else if (humanInstruction(event)) {
        entry.turnHuman = true;
        entry.userStopped = false;
        if (Number.isFinite(event.time)) entry.lastHumanAt = event.time;
      } else if (event?.type === 'user/message' && event.data?.source?.via === 'codex-conductor') {
        entry.userStopped = false;
        delete entry.lastUserStopAt;
      }
    }
    entry.scanned = log.length;
    counts.set(log, entry);
    return entry;
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
      const entry = count(agent?.session?.log);
      if (entry === undefined || !validSessionId(agent?.id)) return undefined;
      const { messages, prompts } = entry;
      const limit = threshold();
      const value = { messages, threshold: limit, suggest: limit > 0 && messages > limit,
        ...(entry.lastHumanAt !== undefined ? { lastHumanAt: entry.lastHumanAt } : {}), ...(entry.turnHuman ? { turnHuman: true } : {}),
        ...(entry.userStopped ? { userStopped: true } : {}),
        ...(entry.lastUserStopAt !== undefined ? { lastUserStopAt: entry.lastUserStopAt } : {}) };
      const floorLimit = contextThreshold();
      // 子代理读大文件时上下文同样会很大，但它们不交接。
      if (floorLimit > 0 && agent.session?.header?.origin !== 'subagent') {
        const floor = prompts.length >= FLOOR_WINDOW ? Math.min(...prompts.map((p) => p.tokens)) : undefined;
        Object.assign(value, { floor, contextThreshold: floorLimit, contextFull: floor >= floorLimit && prompts.some((p) => p.compressed) });
        if (value.contextFull) value.suggest = true;
      }
      const previous = sessions[agent.id];
      const cwd = agent.session?.header?.cwd;
      if (previous?.messages !== messages || previous?.suggest !== value.suggest) {
        sessions[agent.id] = { messages, suggest: value.suggest, ...(value.floor !== undefined ? { floor: value.floor } : {}),
          ...(typeof cwd === 'string' ? { cwd } : {}), at: new Date(now()).toISOString() };
        dirty = true;
      }
      if (now() - written >= writeEveryMs) flush();
      else if (dirty && !timer) { timer = setTimeout(flush, writeEveryMs - (now() - written)); timer.unref?.(); }
      return value;
    },
    allowsAutomatic(agent, startedAt) {
      const stop = this.observe(agent)?.lastUserStopAt;
      // Unknown jobs/timestamps cannot prove they were dispatched after the user's stop.
      return stop === undefined || (Number.isFinite(startedAt) && startedAt > stop);
    },
    snapshot: () => ({ threshold: threshold(), sessions: Object.entries(sessions).map(([sessionId, value]) => ({ sessionId, ...value })) }),
    flush,
  };
}

const HOUR = 3_600_000;
// 自动交接没成之后过这么久才再试，免得每个回合都暂停再恢复目标；撞上新回合（turn_running）时下一个回合边界就再试。
export const RETRY_COOLDOWN_MS = 30 * 60_000;
export const TURN_RETRY_COOLDOWN_MS = 2 * 60_000;
// quietMinutes：用户这么多分钟内亲手发过消息就不自动交接（他可能还在对话）；summaryMinutes：交接前等旧会话写交接摘要的时限，0 不写。
export const AUTO_HANDOVER_DEFAULTS = { mode: 'confirm', cooldownHours: 12, remindStepMessages: 2000, startupDelayMinutes: 10, disableAutoContinue: true,
  withRunningJobs: true, maxChainDepth: 6, minHoursBetween: 6, quietMinutes: 30, summaryMinutes: 10 };

// 纯判定：会话标了建议交接之后这一次要做什么。remind 是面板提醒；act 为 ask（confirm 模式询问）或 auto（执行交接，
// 来源 origin 为 auto，或用户在面板同意过的 confirm / panel）。名下是否还有运行中的 Codex 任务由调用方最后再查。
export function autoHandoverStep({ settings, record = {}, messages, threshold, suggest, contextFull = false, idle, retired, link, now, uptimeMs,
  linksReadable = true, depth = 0, lastAutoAt = -Infinity, lastHumanAt = -Infinity, userStopped = false }) {
  const step = { remind: false, act: null };
  if (settings.mode === 'off' || !suggest || retired) return step;
  // 继任会话从交接时起再涨满一个阈值才算（自动交接出的新会话不会马上再触发）。
  if (link && !contextFull && messages - (link.toMessages ?? 0) <= threshold) return step;
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
    // 用户刚说过话：等他停下这么久再交接，免得对话进行到一半被换到新会话。
    if (settings.quietMinutes > 0 && now - lastHumanAt < settings.quietMinutes * 60_000) return step;
    // 用户点了停止、还没再发话：交接会让新会话接着干，所以不自动交接；提醒、询问和面板同意过的照常。
    if (userStopped) return step;
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
  goals = () => undefined, agentOf = () => undefined, workspaces = () => undefined, now = Date.now, uptime = () => process.uptime() * 1000, logger, allowed = () => true }) {
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
    const resumed = allowed(agent) && resumeGoal(agent, paused);
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
      contextFull: value.contextFull === true,
      idle, retired: Boolean(aliases.successor(id, links)), link: links[id], now: now(), uptimeMs: uptime(),
      linksReadable: storedLinks !== null, depth: predecessors.length, lastAutoAt, lastHumanAt: value.lastHumanAt, userStopped: value.userStopped === true });
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
          if (step.origin === 'auto' && !allowed(agent)) return { ...step, act: null };
          if (step.act === 'ask') {
            if (quiet) Object.assign(record, { open: 'ask', askedAt: at, askedMessages: value.messages });
          } else if (!quiet) giveUp(agent, record, paused, agent.status === 'idle' ? '有 Codex 任务在运行' : '会话又开始了新回合', agent.status !== 'idle');
          else {
            submit({ sessionId: id, origin: step.origin, requestedAt: at, ...(paused ? { pausedGoal: { id: paused.id } } : {}) });
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
    // 回合一直不结束的会话（目标或 LoopX 续跑一个回合可以跑好几个小时）等不到空闲：此刻若空闲就会自动交接时返回 true，
    // 由调用方在步骤边界结束这一回合，转为空闲后照上面的流程交接。只看自动交接，询问仍等会话自己停下。
    // 用户亲手发消息开始的回合从不掐断（11-24、11-25 各有一次在用户发话后 1 分钟内被掐断）。
    due(agent, value) {
      const id = agent?.id;
      if (!file || !value?.suggest || value.turnHuman || summarizing.has(id) || !validSessionId(id) || checking.has(id) || agent.session?.header?.origin === 'subagent') return false;
      return decision(id, value, read(), true).act === 'auto';
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
        giveUp(agentOf(id), record, result.reason === 'user_stopped' ? undefined : record.pending.goal, `交接${result.status}${result.reason ? `：${result.reason}` : ''}`,
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
