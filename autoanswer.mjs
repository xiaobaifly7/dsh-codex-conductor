import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const { validSessionId, writeJsonAtomic, writeTextAtomic } = await import(new URL(`./handover.mjs${new URL(import.meta.url).search}`, import.meta.url));

const MINUTE = 60_000;
const RELOAD_GRACE = 30_000;
const HISTORY_LIMIT = 300;
const RECOMMENDED = /recommended|推荐/i;
const PRIVATE = /密码|密钥|口令|凭据|token|secret|passw[o]rd|credentials?|bearer|api[ _-]?key|PRIVATE KEY-----|\b(?:sk-|gh[pousr]_)[\w-]{12,}|\beyJ[\w-]+\.[\w-]+\.[\w-]+/i;
const PENDING = Symbol.for('dsh-codex-conductor.auto-answer.pending');

export const AUTO_ANSWER_DEFAULTS = {
  enabled: true,
  afterMinutes: 10,
  freeText: '用户暂时不在。请按你认为最合适、最稳妥的方案继续，并在回复里说明你替用户做了哪些决定。',
  riskyPattern: '删除|清空|不可恢复|不可逆|覆盖|格式化|卸载|重置|drop |truncate|rm -rf|force.?push|付款|支付|购买|转账|充值|密码|密钥|口令|凭据|token|secret|发布到|上线到生产|生产环境|对外发送|发邮件|真实目标|授权范围',
  subagents: true,
  excludeSessions: [],
};

const validators = {
  enabled: (v) => typeof v === 'boolean',
  afterMinutes: (v) => Number.isFinite(v) && v >= 1 && v * MINUTE <= Number.MAX_SAFE_INTEGER,
  freeText: (v) => typeof v === 'string' && v.trim() !== '',
  riskyPattern: (v) => {
    if (typeof v !== 'string') return false;
    try { new RegExp(v, 'i'); return true; } catch { return false; }
  },
  subagents: (v) => typeof v === 'boolean',
  excludeSessions: (v) => Array.isArray(v) && v.every(validSessionId),
};

export function normalizeAutoAnswer(value, unknownConfig, logger) {
  const unknown = Object.keys(value).filter((key) => !Object.hasOwn(validators, key)).map((key) => 'autoAnswer.' + key);
  if (unknown.length) {
    unknownConfig.push(...unknown);
    logger?.warn?.('[codex-conductor] 未知配置项 ' + unknown.join(', ') + ' 已忽略，请核对拼写');
  }
  return Object.fromEntries(Object.entries(AUTO_ANSWER_DEFAULTS).map(([key, fallback]) => {
    if (value[key] === undefined || validators[key](value[key])) return [key, value[key] ?? fallback];
    logger?.warn?.('[codex-conductor] 忽略无效的配置 autoAnswer.' + key + '，使用默认值');
    return [key, fallback];
  }));
}

function recommendation(question, freeText, notice) {
  const options = question.options ?? [];
  const marked = options.filter((option) => RECOMMENDED.test(option.label) || RECOMMENDED.test(option.description ?? ''));
  const preferred = marked.length ? marked : options.slice(0, 1);
  const selected = (question.multiSelect ? preferred : preferred.slice(0, 1)).map((option) => option.label);
  const custom = [selected.length ? '' : freeText, notice].filter(Boolean).join('\n');
  return {
    answer: { id: question.id, selected, ...(custom ? { custom } : {}) },
    reason: marked.length ? 'marked_recommended' : selected.length ? 'first_option' : 'free_text',
  };
}

const preview = (text, max) => PRIVATE.test(text) ? '[敏感内容已隐藏]' : Array.from(text).slice(0, max).join('');
const minutes = (ms) => Math.max(0, Math.round(ms / 6_000) / 10);
const wasStopped = (event) => event.type === 'turn/end' && event.data.reason?.kind === 'aborted' &&
  event.data.reason.reason?.kind !== 'interrupted';
const isReply = (source, callId) => source?.kind === 'user-question-reply' && source.callId === callId;

function originalCall(session, callId) {
  return session.log?.findLast((event) => event.data.name === 'ask_user_question' &&
    ((event.type === 'tool/call' && event.data.callId === callId) ||
      (event.type === 'tool/ptc-dispatch' && event.data.subCallId === callId)));
}

function readOptional(file) {
  if (!file) return '';
  try { return fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

export function registerAutoAnswer({ ctx, settings, directory, now = Date.now }) {
  const status = { enabled: settings.enabled, afterMinutes: settings.afterMinutes, available: false, pending: [], recent: [] };
  const panel = { snapshot: () => status, act: () => false };
  if (!settings.enabled) return panel;

  ctx.inject?.(['userQuestions'], (scope) => {
    const service = scope.get?.('userQuestions');
    if (typeof service?.ask !== 'function') return;
    const warn = (message) => scope.logger?.warn?.('[codex-conductor] ' + message);
    const risk = settings.riskyPattern ? new RegExp(settings.riskyPattern, 'i') : null;
    const historyFile = directory && path.join(directory, 'auto-answer-history.jsonl');
    const manualFile = directory && path.join(directory, 'auto-answer-manual.json');
    const history = () => readOptional(historyFile).split('\n').filter(Boolean);
    let manual;
    try {
      const saved = JSON.parse(readOptional(manualFile) || '[]');
      if (!Array.isArray(saved) || !saved.every((id) => typeof id === 'string')) throw new Error('invalid manual answer record');
      manual = new Set(saved);
    }
    catch { warn('读取自动代答的人工接管记录失败，已有宿主编号的提问暂由用户回答'); }
    function setManual(key, value) {
      if (!key || !manual || manual.has(key) === value) return;
      if (value) manual.add(key); else manual.delete(key);
      if (manualFile) try {
        fs.mkdirSync(directory, { recursive: true });
        writeJsonAtomic(manualFile, [...manual]);
      } catch { warn('保存自动代答的人工接管记录失败'); }
    }

    // 热重载时宿主仍在等待原来的 waterfall，保留它的回答回调和提出时间。
    const hosts = globalThis[PENDING] ??= new WeakMap();
    const host = scope.root ?? ctx;
    const pending = hosts.get(host) ?? new Map();
    hosts.set(host, pending);
    const makeKey = (agent, callId) => callId ? JSON.stringify([agent.id, callId]) : '';
    function forget(item) {
      clearTimeout(item.timer);
      if (pending.get(item.id) === item) pending.delete(item.id);
    }
    function block(item) {
      if (item.questions.some(q => q.question?.startsWith('[owner_only]'))) return 'owner_only';
      if (item.manual || (item.key && (!manual || manual.has(item.key)))) return 'manual';
      if (risk && item.questions.some((q) => [q.question, q.header, q.detail,
        ...(q.options ?? []).flatMap((o) => [o.label, o.description])].some((value) => value && risk.test(value)))) return 'risky';
      if (settings.excludeSessions.includes(item.agent.id) || (settings.subagents === false && item.agent.session.header?.origin === 'subagent') ||
          item.questions.some((q) => q.intent)) return 'excluded';
      return item.failed ? 'failed' : null;
    }
    function record(item, choices, skip) {
      if (!historyFile || (skip && item.recordedSkip === skip)) return;
      try {
        const lines = history();
        const callId = item.callId ?? item.id;
        if (skip && item.key && lines.some((line) => {
          const row = JSON.parse(line);
          return row.sessionId === item.agent.id && row.callId === callId && row.reason === skip;
        })) return;
        const at = now();
        const added = item.questions.map((q, i) => JSON.stringify({
          at: new Date(at).toISOString(), sessionId: item.agent.id, callId, questionId: preview(q.id, 120),
          question: preview(q.question, 120), selected: choices?.[i].answer.selected.map((label) => preview(label, 80)) ?? [],
          reason: skip ?? choices[i].reason, waitedMinutes: minutes(at - item.askedAt),
        }));
        fs.mkdirSync(directory, { recursive: true });
        writeTextAtomic(historyFile, [...lines, ...added].slice(-HISTORY_LIMIT).join('\n') + '\n');
        item.recordedSkip = skip;
      } catch { warn('写入自动代答历史失败'); }
    }

    const continued = (agent) => service.continued?.(agent) ?? [];
    const queued = (agent, callId) => ['nextStep', 'nextTurn'].some((lane) =>
      agent.inbox?.[lane]?.some((message) => isReply(message.source, callId)));
    const live = (item) => !item.signal?.aborted && (item.respond ||
      (scope.get?.('agents')?.get(item.agent.id) === item.agent &&
        continued(item.agent).some((q) => q.callId === item.callId) && !queued(item.agent, item.callId)));
    async function answer(item, immediate = false) {
      if (item.answering || pending.get(item.id) !== item) return false;
      if (!live(item)) { forget(item); return false; }
      const reason = block(item);
      if (reason) {
        if (!immediate && ['risky', 'excluded', 'owner_only'].includes(reason)) record(item, null, 'skipped_' + reason);
        return false;
      }
      clearTimeout(item.timer);
      item.answering = true;
      const notice = immediate ? '（已按用户在面板的请求选择推荐项。）'
        : '（用户超过 ' + settings.afterMinutes + ' 分钟未回答，已自动选择推荐项；用户回来后可能会修正。）';
      const choices = item.questions.map((q, i) => recommendation(q, settings.freeText, i === 0 ? notice : ''));
      const result = { answers: choices.map(({ answer }) => answer) };
      try {
        const accepted = item.respond ? await item.respond(result) : service.answer(item.agent, item.callId, result);
        if (accepted) record(item, choices);
        forget(item);
        return accepted;
      } catch (error) {
        if (['REPLY_QUEUED', 'CALLER_NOT_LIVE', 'DELEGATED_CALLER'].includes(error?.code)) forget(item);
        else {
          item.failed = true;
          warn('宿主未接受自动代答，请在会话中亲自回答');
        }
        return false;
      } finally { item.answering = false; }
    }

    function arm(item, restored = false) {
      const dueAt = item.askedAt + settings.afterMinutes * MINUTE;
      item.dueAt = restored && dueAt <= now() ? now() + RELOAD_GRACE : dueAt;
      if (block(item) === 'manual' || item.failed) return;
      const tick = () => {
        const delay = item.dueAt - now();
        if (delay <= 0) void answer(item);
        else item.timer = setTimeout(tick, Math.min(delay, 2_147_483_647));
      };
      item.timer = setTimeout(tick, Math.min(Math.max(0, item.dueAt - now()), 2_147_483_647));
    }

    function add(agent, callId, questions, askedAt, rest = {}, restored = false) {
      const item = { id: randomUUID(), agent, callId, key: makeKey(agent, callId), questions, askedAt, ...rest };
      pending.set(item.id, item);
      arm(item, restored);
      return item;
    }

    scope.on('user-questions/request', async (request, next) => {
      const { agent, questions, signal } = request;
      if (!validSessionId(agent?.id) || !questions?.length || signal?.aborted) return next();
      const callId = request.wait?.callId;
      const call = callId && originalCall(agent.session, callId);
      const askedAt = call?.time ?? now();
      const provider = new AbortController();
      const automatic = Promise.withResolvers();
      // Cordis 的 next() 转发同一个 request，独立的 signal 只用于关闭作答卡片。
      request.signal = signal ? AbortSignal.any([signal, provider.signal]) : provider.signal;
      let item;
      const cancelled = () => item && forget(item);
      try {
        const delivery = Promise.race([next(), automatic.promise]);
        item = add(agent, callId, questions, askedAt, {
          signal, turn: call?.data.turn, respond: (value) => {
            automatic.resolve(value);
            return delivery.then((delivered) => delivered === value, () => false);
          },
        });
        signal?.addEventListener('abort', cancelled, { once: true });
        return await delivery;
      } finally {
        cancelled();
        signal?.removeEventListener('abort', cancelled);
        provider.abort();
        request.signal = signal;
      }
    }, { global: true, prepend: true });

    function reconcile(agent, restored = false) {
      if (typeof service.answer !== 'function') return;
      const answerable = continued(agent).filter((q) => !queued(agent, q.callId));
      for (const item of pending.values()) {
        if (item.agent === agent && !item.respond && !answerable.some((q) => q.callId === item.callId)) forget(item);
      }
      if (!answerable.length) return;
      try { service.assertLiveRoot?.(agent); } catch { return; }
      for (const q of answerable) {
        if ([...pending.values()].some((item) => item.agent === agent && item.callId === q.callId)) continue;
        const call = originalCall(agent.session, q.callId);
        if (!Number.isFinite(call?.time) || agent.session.log.some((event) => wasStopped(event) && event.data.turn === call.data.turn)) continue;
        add(agent, q.callId, q.questions, call.time, { turn: call.data.turn }, restored);
      }
    }
    scope.on('session/event', (session, event) => {
      const stopped = wasStopped(event);
      if (!stopped && event.type !== 'tool/result' && !(event.type === 'tool/ptc-dispatch' && event.data.name === 'ask_user_question') &&
          !(event.type === 'user/message' && event.data.source?.kind === 'user-question-reply')) return;
      const agent = scope.get?.('agents')?.get(session.id);
      if (agent?.session !== session) return;
      if (stopped) {
        for (const item of pending.values()) if (item.agent === agent && item.turn === event.data.turn) forget(item);
        return;
      }
      const callId = event.data.source?.callId ?? event.data.message?.toolCallId;
      const key = makeKey(agent, callId);
      if (manual?.has(key) && !continued(agent).some((q) => q.callId === callId)) setManual(key, false);
      reconcile(agent);
    }, { global: true });
    for (const event of ['agent/inbox/inserted', 'agent/inbox/discarded']) scope.on(event, ({ agent, message }) => {
      if (message.source?.kind === 'user-question-reply') reconcile(agent);
    }, { global: true });
    scope.on('agent/created', ({ agent }) => reconcile(agent, true), { global: true });
    scope.on('agent/disposed', ({ agent }) => {
      for (const item of pending.values()) if (item.agent === agent) forget(item);
    }, { global: true });

    panel.snapshot = () => {
      let recent = [];
      try { recent = history().slice(-10).reverse().map((line) => JSON.parse(line)); }
      catch { warn('读取自动代答历史失败'); }
      const at = now();
      return { ...status, available: true, recent, pending: [...pending.values()].filter((item) => !item.answering).map((item) => {
        const reason = block(item);
        return { id: item.id, sessionId: item.agent.id, questions: item.questions.map((q) => preview(q.question, 60)),
          waitedMinutes: minutes(at - item.askedAt), remainingMinutes: reason ? null : minutes(item.dueAt - at), reason };
      }) };
    };
    panel.act = (id, action) => {
      const item = pending.get(id);
      if (!item || !live(item) || item.answering) return false;
      if (action === 'manual') {
        item.manual = true;
        setManual(item.key, true);
        clearTimeout(item.timer);
        return true;
      }
      return answer(item, true);
    };
    for (const item of pending.values()) arm(item, true);
    for (const agent of scope.get?.('agents')?.list?.() ?? []) reconcile(agent, true);
    scope.effect?.(() => () => {
      for (const item of pending.values()) {
        if (item.respond) clearTimeout(item.timer); else forget(item);
      }
      panel.snapshot = () => status;
      panel.act = () => false;
    });
  });
  return panel;
}
