window.__ModuleLoader__.load({
  id: 'dsh-codex-conductor',
  factory(require) {
    const React = require('react');
    const { useEffect, useRef, useState } = React;
    const { Button, Input, Checkbox } = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;
    const PREFIX = '/dsh-codex-conductor';
    const EFFORTS = [['low', '低'], ['medium', '中'], ['high', '高'], ['xhigh', '很高'], ['max', '最高']];
    const CSS = `
      .dcc-panel { color: var(--dsw-alias-label-primary); font: inherit; line-height: 1.6; min-width: 0; }
      .dcc-panel section + section { border-top: 1px solid var(--dsw-alias-border-l2); margin-top: 24px; padding-top: 20px; }
      .dcc-panel h3 { font-size: 15px; margin: 0 0 12px; }
      .dcc-panel p { margin: 4px 0; }
      .dcc-muted, .dcc-panel small { color: var(--dsw-alias-label-secondary); }
      .dcc-panel small { display: block; font-size: 12px; }
      .dcc-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .dcc-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(230px, 100%), 1fr)); gap: 14px 20px; }
      .dcc-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
      .dcc-field > span:first-child { font-size: 13px; font-weight: 500; }
      .dcc-field > span, .dcc-field input { min-width: 0; }
      .dcc-panel select, .dcc-panel textarea { box-sizing: border-box; width: 100%; border: 1px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; padding: 7px 10px; }
      .dcc-panel select:focus-visible, .dcc-panel textarea:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
      .dcc-panel textarea { min-height: 260px; resize: vertical; line-height: 1.6; }
      .dcc-actions { margin-top: 12px; }
      .dcc-error { color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }
      .dcc-status { margin-bottom: 10px; overflow-wrap: anywhere; }
      .dcc-warn { color: var(--dsw-alias-state-error-primary); font-weight: 600; overflow-wrap: anywhere; }
      .dcc-panel summary { cursor: pointer; margin: 8px 0; }
      .dcc-panel textarea.dcc-short { min-height: 80px; }
      .dcc-jobs { padding: 0; list-style: none; margin: 12px 0; }
      .dcc-job { padding: 12px 0; border-bottom: 1px solid var(--dsw-alias-border-l2); overflow-wrap: anywhere; }
      .dcc-job strong { font-size: 13px; }
      .dcc-report { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 480px; overflow: auto; padding: 12px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); font-size: 12px; }
      .dcc-confirm { margin-top: 8px; }
      .dcc-readable { overflow-wrap: anywhere; }
      .dcc-readable h4 { margin: 14px 0 6px; }
      .dcc-readable p { white-space: pre-wrap; }
      .dcc-readable li { margin-bottom: 8px; }
    `;

    async function api(path, signal, body, http) {
      const entry = http && { path, status: null };
      if (entry) http.push(entry);
      let response;
      try {
        response = await fetch(PREFIX + path, {
          credentials: 'same-origin', signal,
          ...(body === undefined ? {} : {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          }),
        });
      } finally { if (entry) entry.status = response?.status ?? null; }
      let value;
      try { value = await response.json(); }
      catch (_) { throw new Error('服务没有返回有效数据，请稍后重试。'); }
      if (!response.ok || value.error) {
        const error = new Error(userError(value.error, `请求失败（${response.status}），请稍后重试。`));
        error.saved = value.saved === true;
        error.status = response.status;
        throw error;
      }
      return value;
    }

    function userError(value, fallback = '暂时无法完成操作，请刷新后重试；仍然失败请联系维护者。') {
      if (typeof value !== 'string' || !/[\u3400-\u9fff]/.test(value) || /[A-Za-z_]/.test(value.replace(/\b(?:Codex|DSH|DeepSeek|Gemini|Harness|MiB|KiB)\b/g, ''))) return fallback;
      return /请|重试|重新|检查|联系/.test(value) ? value : `${value}。请刷新后重试；仍然失败请联系维护者。`;
    }

    function pendingError(value) {
      if (/等待空闲已超过 10 分钟/.test(value)) return '等待空闲已超过 10 分钟，未请求重载；请重新保存设置、重新请求等空闲，或确认立即生效。';
      if (/EACCES|EPERM|权限|只读|denied/i.test(value)) return '无法写入设置，请联系维护者检查文件权限后重试。';
      if (/EBUSY|占用|locked/i.test(value)) return '保存设置的文件正被占用，请稍后重试。';
      if (/YAML|字段|格式|parse|scalar|encoding/i.test(value)) return '已保存的设置格式不支持修改，请联系维护者检查设置文件后重试。';
      if (/reload|加载|重载/i.test(value)) return '设置未能加载，请刷新运行状态；仍未生效请联系维护者。';
      return userError(value, '设置未能生效，请重新保存；仍然失败请联系维护者检查设置。');
    }

    const REPORT_LIMIT = 256 * 1024;
    function parseReport(text) {
      try {
        const report = JSON.parse(text);
        const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
        const strings = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');
        const fields = ['summary', 'criteria', 'files_changed', 'deviations', 'unresolved'];
        if (!object(report) || !fields.every((key) => Object.hasOwn(report, key)) ||
            !Object.keys(report).every((key) => [...fields, 'blockers'].includes(key)) ||
            typeof report.summary !== 'string' || !['files_changed', 'deviations', 'unresolved'].every((key) => strings(report[key])) ||
            !Array.isArray(report.criteria) || !report.criteria.every((item) => object(item) && Object.keys(item).length === 3 &&
              typeof item.criterion === 'string' && typeof item.evidence === 'string' && ['met', 'not_met', 'blocked'].includes(item.status))) return null;
        if (Object.hasOwn(report, 'blockers')) {
          const keys = ['id', 'kind', 'message', 'question', 'resolution'];
          if (!Array.isArray(report.blockers) || !report.blockers.every((item) => object(item) && Object.keys(item).length === keys.length &&
              keys.every((key) => typeof item[key] === 'string') && item.id.trim() && item.message.trim() &&
              ['user_input', 'task_conflict', 'environment', 'implementation'].includes(item.kind) &&
              (!['user_input', 'task_conflict'].includes(item.kind) || item.question.trim())) ||
              new Set(report.blockers.map((item) => item.id)).size !== report.blockers.length) return null;
        }
        return report;
      } catch (_) { return null; }
    }

    const ARTIFACTS = [['report', '报告'], ['context', '任务书与验收'], ['review', '核验记录'], ['stderr', '错误日志'], ['diff', '改动 diff']];
    const reportPath = (jobId, offset, artifact = 'report') =>
      `/output?job_id=${encodeURIComponent(jobId)}&offset=${offset}&limit=8000${artifact === 'report' ? '' : `&artifact=${artifact}`}`;
    async function loadReport(jobId, signal, read = api, artifact = 'report') {
      const pages = [];
      let offset = 0, length = 0;
      while (true) {
        const page = await read(reportPath(jobId, offset, artifact), signal);
        if (page.status === 'pending' || page.error_kind === 'artifact_pending') return { pages: [], report: null, pending: true };
        pages.push({ ...page, offset });
        // 其他产物只按原文分页看，后续页点“下一页”时再读。
        if (artifact !== 'report') return { pages, report: null, tooLarge: false };
        // Python offsets count Unicode code points, not bytes or JavaScript UTF-16 units.
        length += Array.from(page.text || '').length;
        if (page.total_chars > REPORT_LIMIT || length > REPORT_LIMIT) return { pages, report: null, tooLarge: true };
        if (page.eof) return { pages, report: parseReport(pages.map((p) => p.text || '').join('')), tooLarge: false };
        if (!(page.next_offset > offset)) throw new Error('报告没有返回下一页的位置，请刷新报告后重试。');
        if (length >= REPORT_LIMIT) return { pages, report: null, tooLarge: true };
        offset = page.next_offset;
      }
    }

    function ReadableReport({ report, acceptance = [] }) {
      const list = (title, items) => items.length ? h('div', null, h('h4', null, title),
        h('ul', null, ...items.map((text, i) => h('li', { key: i }, text)))) : null;
      return h('div', { className: 'dcc-readable' },
        h('h4', null, '概述'), h('p', null, report.summary || 'Codex 没有填写概述。'),
        h('h4', null, '逐条验收（Codex 自述）'),
        h('small', null, '以下是 Codex 的汇报，还需要核对实际结果。'),
        h('ol', null, ...report.criteria.map((item, i) => {
          const number = /^\s*(?:第\s*)?\(?(\d+)\s*(?:条|[.):、]|$)/.exec(item.criterion.normalize('NFKC'))?.[1];
          const index = number === undefined ? i + 1 : Number(number);
          const original = (number !== undefined || acceptance.length === report.criteria.length) && acceptance[index - 1];
          const chars = typeof original === 'string' ? Array.from(original) : [];
          const status = { met: '通过', not_met: '未通过', blocked: '受阻' }[item.status];
          return h('li', { key: i },
            h('strong', null, chars.length ? `第 ${index} 条：${chars.slice(0, 300).join('')}${chars.length > 300 ? '…' : ''} —— ${status}`
              : `${status}：${item.criterion}`),
            chars.length > 300 ? h('details', null, h('summary', null, '展开验收标准原文'), h('p', null, original)) : null,
            item.evidence.length > 300 ? h('details', null, h('summary', null, '展开 Codex 给的证据'), h('p', null, item.evidence))
              : h('p', null, `证据：${item.evidence || '未提供'}`));
        })),
        report.blockers?.length ? h('div', null, h('h4', null, 'Codex 留下的问题（以下为 Codex 原话）'),
          ...report.blockers.map((item) => h('div', { key: item.id, className: 'dcc-status' },
            h('p', null, `问题：${item.message}`), h('p', null, `它想问：${item.question || '未填写'}`),
            h('p', null, `它说的解除条件：${item.resolution || '未填写'}`)))) : null,
        list('改动了哪些文件', report.files_changed), list('与原计划不同的地方（Codex 原话）', report.deviations),
        list('还没解决的事（Codex 原话）', report.unresolved));
    }

    // 嵌套设置在表单里用“父.子”作键。
    const NESTED = ['gemini', 'autoResume', 'repeatFailureGuard'];
    const nestedKey = (key) => NESTED.includes(key.split('.')[0]) && key.includes('.') ? key.split('.') : null;
    const fieldValue = (settings, key) => nestedKey(key)
      ? settings[nestedKey(key)[0]]?.[nestedKey(key)[1]] : settings[key];
    const displayValue = (value) => value == null ? '' : String(value);
    // 留空提交 null，表示恢复默认；check 之外的输入给出 message。
    const NUMBERS = {
      timeoutSeconds: [(v) => v > 0, '超时秒数请填大于 0 的数字，或留空。'],
      idleTimeoutSeconds: [(v) => v > 0, '超时秒数请填大于 0 的数字，或留空。'],
      retries: [(v) => Number.isInteger(v) && v >= 0, '自动重试次数请填 0 或正整数，或留空。'],
      'repeatFailureGuard.minSeconds': [(v) => v > 0, '计入失败的最短秒数请填大于 0 的数字。'],
      'repeatFailureGuard.failures': [(v) => Number.isSafeInteger(v) && v > 0, '触发拦截的失败次数请填正整数。'],
      'repeatFailureGuard.windowHours': [(v) => v > 0, '重复失败的统计窗口请填大于 0 的小时数。'],
      maxRunningJobs: [(v) => Number.isInteger(v) && v > 0, '同时运行的任务数上限请填正整数，或留空。'],
      lockTimeoutSeconds: [(v) => v > 0, '等待秒数和存储上限请填大于 0 的数字，或留空。'],
      maxStorageMb: [(v) => v > 0, '等待秒数和存储上限请填大于 0 的数字，或留空。'],
      maxSessionJobs: [(v) => Number.isInteger(v) && v > 0, '每个会话最多派几单请填正整数，或留空。'],
      maxSessionTokens: [(v) => Number.isInteger(v) && v > 0, '每个会话的用量上限请填正整数，或留空。'],
      handoverSuggestMessages: [(v) => Number.isInteger(v) && v >= 0, '建议交接的消息数请填 0 或正整数（0 表示关闭），或留空恢复默认 5000。'],
      acceptanceWarnAbove: [(v) => Number.isInteger(v) && v >= 0, '验收标准条数提醒请填 0 或正整数（0 表示关闭），或留空恢复默认 8。'],
      continueFreshAboveTokens: [(v) => Number.isInteger(v) && v >= 0, '续接开新线程的阈值请填 0 或正整数（0 表示总是沿用原线程），或留空恢复默认 100000。'],
    };
    // 多行文本框一行一个，空行忽略；提交时整体替换数组。[最多几项, 单项检查, 提示]
    const LISTS = {
      allowTools: [200, (v) => /^[A-Za-z0-9_.:*-]{1,120}$/.test(v), '白名单工具请一行填一个，只用字母、数字和 _ . : * -，最多 200 个。'],
      plannerReadAllow: [50, (v) => v.length <= 500 && /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(v), '额外允许读取的路径请一行填一个完整路径，最多 50 个。'],
    };
    const listLines = (value) => Array.isArray(value) ? value
      : String(value ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const effectiveLength = (text) => Array.from(text.replace(/<!--[\s\S]*?-->/g, '').trim()).length;

    function settingsPatch(settings, edits) {
      const patch = {};
      for (const [key, raw] of Object.entries(edits)) {
        const old = fieldValue(settings, key);
        if (LISTS[key]) {
          const [most, check, message] = LISTS[key], list = listLines(raw);
          if (list.length > most || !list.every(check)) throw new Error(message);
          if (JSON.stringify(list) !== JSON.stringify(old ?? [])) patch[key] = list;
          continue;
        }
        if (displayValue(raw) === displayValue(old)) continue;
        let value = raw;
        if (key === 'model' || key === 'gemini.model') {
          // 空的 Codex 模型表示沿用 Codex 配置。
          if (!(key === 'model' && value === '') && !/^[A-Za-z0-9._/:-]{1,80}$/.test(value)) throw new Error('模型名请填 1 到 80 个字母、数字或 . _ / : -；Codex 模型可留空。');
        } else if (['effort', 'readOnlyEffort', 'gemini.effort'].includes(key)) {
          const allowed = key === 'gemini.effort' ? ['low', 'medium', 'high'] : ['', ...EFFORTS.map(([v]) => v)];
          if (!allowed.includes(value)) throw new Error('请从列表中选择思考程度。');
        } else if (key === 'serviceTier') {
          if (!['', 'fast', 'ultrafast'].includes(value)) throw new Error('请从列表中选择服务速度。');
        } else if (key === 'plannerReads') {
          if (!['open', 'products'].includes(value)) throw new Error('请选择规划端的读取范围。');
        } else if (key === 'toolPolicy') {
          if (!['denylist', 'allowlist'].includes(value)) throw new Error('请从列表中选择工具放行方式。');
        } else if (NUMBERS[key]) {
          const [check, message] = NUMBERS[key];
          value = raw == null || String(raw).trim() === '' ? null : Number(raw);
          if (value === null ? key.startsWith('repeatFailureGuard.') : !(Number.isFinite(value) && check(value))) throw new Error(message);
          if (value === (old ?? null)) continue;
        }
        const nested = nestedKey(key);
        if (nested) {
          if (settings[nested[0]]) (patch[nested[0]] ||= {})[nested[1]] = value;
        } else patch[key] = value;
      }
      return patch;
    }

    function mergeSettings(settings, changes = {}) {
      return { ...settings, ...changes, ...Object.fromEntries(NESTED.filter((key) => changes[key])
        .map((key) => [key, { ...settings?.[key], ...changes[key] }])) };
    }

    function pendingPatch(settings, pending, edits) {
      const changes = pending?.changes || {};
      const values = Object.fromEntries(Object.entries(changes).filter(([key]) => !NESTED.includes(key)));
      for (const parent of NESTED) for (const [key, value] of Object.entries(changes[parent] || {})) values[`${parent}.${key}`] = value;
      return settingsPatch(settings, { ...values, ...edits });
    }

    function Message({ text, error = false }) {
      return text ? h('p', { className: error ? 'dcc-error' : 'dcc-muted', role: error ? 'alert' : 'status' }, text) : null;
    }

    function idleWaitText(runtime, action) {
      if (runtime.idle_wait?.status === 'timed_out') return '等待空闲已超过 10 分钟，已停止自动重载。请重新保存设置、重新请求等空闲，或确认立即生效；待生效设置可撤销。';
      const reasons = [];
      if (runtime.active_tasks == null) reasons.push('确认 Codex 任务均已结束');
      else if (runtime.active_tasks > 0) reasons.push(`${runtime.active_tasks} 个 Codex 任务结束`);
      if (runtime.active_sessions == null || runtime.sessions_error) reasons.push('确认所有 DeepSeek 会话的当前一轮已结束');
      else if (runtime.active_sessions > 0) reasons.push(`${runtime.active_sessions} 个会话的当前一轮结束`);
      const countdown = runtime.idle_wait?.remaining_seconds;
      return `等${reasons.length ? ` ${reasons.join('，并等 ')}` : '待确认 Codex 任务和 DeepSeek 会话均空闲'}后${action}。最长等 10 分钟${countdown == null ? '' : `，剩余 ${countdown} 秒`}；超时停止自动重载，保留待生效设置。`;
    }

    const HANDOVER_MODES = { off: '关闭（只标记建议交接）', notify: '只提醒', confirm: '空闲时询问，同意后交接', auto: '空闲时自动交接' };
    const QUEUED_HINT = '旧会话输入框里还有排队未发的消息的话，请先发出或清空——它们不会跟到新会话。';
    const CHECK_TEXT = { goal: '目标逐字接上', settings: '预设、模型、权限和工作目录一致', jobs: '新会话能查到待处理的任务', delivered: '交接单已送达',
      instructions: '完整用户指令档案', predecessorFrozen: '旧会话已冻结', workspace: '新会话在原会话的分组里' };
    const ORIGIN_TEXT = { panel: '面板', auto: '自动交接', confirm: '询问后同意', tool: '工具', file: '请求文件', startup: '启动修复' };
    // 交接被拒或撤回被拦时，把结果里的原因说成人话。
    function handoverReason(result) {
      const reason = result?.reason;
      return {
        turn_running: '当前有回合在运行，结束后再交接。',
        jobs_running: `当前有 ${result?.running?.length ?? '若干'} 个 Codex 任务在运行，结束后再交接。`,
        successor_active: `继任会话已有 ${result?.newTurns ?? '若干'} 个新回合${result?.successorRunning ? '且正在运行' : ''}，撤回会造成两个会话并行。`,
        successor_turn_running: '要接手的会话正在运行，结束后再交接。',
        already_handed_over: `这个会话已经交接给 ${result?.successor ?? '其他会话'}。`,
        session_not_found: '找不到这个会话。', session_unavailable: '暂时打不开这个会话。',
        jobs_unreadable: '暂时读不到这个会话的 Codex 任务，没有交接。', successor_unavailable: '没能建立或打开新会话，没有交接。',
        alias_failed: '没能记下交接关系，没有交接。', not_linked: '这两个会话之间没有交接记录。', invalid_request: '请求格式不正确。',
      }[reason] || (reason ? `没有执行（${reason}）。` : '');
    }
    function handoverResultText(result) {
      if (!result) return '还没有交接记录。';
      const from = ORIGIN_TEXT[result.origin] ? `，来自${ORIGIN_TEXT[result.origin]}` : '';
      if (result.status === 'handed_over' || result.status === 'handed_over_with_issues') {
        return `已交接：${result.from} → ${result.to}${from}。` + (result.status === 'handed_over_with_issues' ? '交接后自检有问题，见下方各项。' : '') +
          (result.steps?.autoContinue === 'manual_required' ? `请在界面把旧会话 ${result.from} 的“自动继续”开关关掉。` : '');
      }
      if (result.status === 'rolled_back') {
        return `交接已自动撤回：${{ delivery_failed: '交接单没能送到新会话', successor_goal_failed: '新会话的目标没能建立' }[result.rollback?.reason] || '交接没有完成'}，` +
          `${result.from} 恢复原状，${result.to} 不再作为继任会话${from}。`;
      }
      if (result.status === 'reverted') {
        return `已撤回：${result.from} 恢复派活，${result.to} 的目标已暂停${from}。` +
          (result.warning === 'parallel_sessions' ? '两个会话都已开工，请决定保留哪一个，另一个停下。' : '');
      }
      return `${result.from || '会话'}${result.to ? ` → ${result.to}` : ''} 没有执行：${handoverReason(result)}`;
    }

    function Status({ status, attention, errors = {}, messages = {}, busy = '', doctor, onRefresh, onReload, onCancel, onDoctor }) {
      const runtime = status?.runtime;
      const pending = runtime?.pending_settings;
      const activeSettings = status?.settings;
      const roots = activeSettings?.roots || [];
      const unknownConfig = activeSettings?.unknownConfig || [];
      const profileError = runtime?.profile_error ? '无法读取已保存的设置，请联系维护者检查设置文件后刷新。' : '';
      const loadedError = runtime?.loaded_error ? '无法读取当前运行版本，请刷新；仍然失败请联系维护者。' : '';
      function statusRow(label, value, hint) {
        return h('div', { className: 'dcc-status', key: label }, h('div', null, h('strong', null, `${label}：`), value), h('small', null, hint));
      }
      const runtimeState = pending ? ['有修改等待生效', '当前任务仍使用下方显示的运行设置。'] : {
        synchronized: ['已生效', '当前运行的版本与已保存的版本一致。'],
        pending: ['等待生效', '已保存的版本还没有完全用于当前运行。'],
        unknown: ['暂时无法确认', '请查看下面的读取情况，再决定是否重新加载。'],
      }[runtime?.state] || ['暂时无法确认', '还没有读到可用的运行状态。'];
      return h('section', { 'aria-label': '运行状态' },
          h('div', { className: 'dcc-row' }, h('h3', null, '运行状态'),
            h(Button, { size: 'sm', disabled: !!busy, onClick: onRefresh }, '刷新状态')),
          h('p', { className: 'dcc-muted' }, '每 7 秒自动查看运行状态；任务、关注数和提示词约每 28 秒刷新，有任务在跑时任务列表每 7 秒刷新。未保存的输入会保留。'),
          h(Message, { text: errors.status, error: true }),
          errors.status && status ? h('small', null, '下面保留的是上次成功读取的状态。') : null,
          !status ? h('p', null, errors.status ? '暂时读不到运行状态。' : '正在读取运行状态…') : null,
          status ? h('div', null,
            statusRow('生效情况', runtimeState[0], runtimeState[1]),
            statusRow('正在运行的版本', runtime?.loaded?.version || '未读到', '这是本次运行实际使用的插件版本。'),
            statusRow('当前模型', activeSettings ? activeSettings.model || '跟随 Codex 配置' : '未读到', '这是当前正在使用的模型，不包含待生效或未保存的修改。'),
            statusRow('思考程度', activeSettings ? EFFORTS.find(([value]) => value === activeSettings.effort)?.[1] || activeSettings.effort || '跟随 Codex 配置' : '未读到', '控制 Codex 做任务时思考得多深入。'),
            statusRow('速度档', activeSettings ? activeSettings.serviceTier || '跟随 Codex 配置' : '未读到', '使用 Codex 配置或账号支持的 fast、ultrafast 档位。'),
            statusRow('自动回答 Codex 的问题', activeSettings ? activeSettings.plannerAnswers ? '已开启' : '已关闭' : '未读到', '打开后 DeepSeek 会替你回答 Codex 的问题并继续干活，不再等你'),
            statusRow('规划端读取范围', activeSettings ? activeSettings.plannerReads === 'products' ? '只读 Codex 的产物' : '不限制读取' : '未读到', '这是当前正在生效的读取范围。'),
            statusRow('额外允许读取的路径', activeSettings ? `${activeSettings.plannerReadAllowCount ?? 0} 条` : '未读到', '这里只显示数量，需要修改时请编辑插件配置。'),
            statusRow('Gemini 写作', activeSettings ? activeSettings.gemini ? '已开启' : '未开启' : '未读到', '已配置时，可以让 Gemini 写教程和文档。'),
            statusRow('建议交接的会话', !status.history ? '未读到' : !status.history.threshold ? '提示已关闭'
              : status.history.sessions.filter((s) => s.suggest).map((s) => `${s.sessionId}（${s.messages} 条消息）`).join('、') || '暂无',
              `消息数超过 ${status.history?.threshold || '设定值'} 条的会话每一步都会变慢，可以在下方“会话交接”里交接到新会话。`),
            statusRow('护栏工作区', !activeSettings ? '未读到' : roots.includes('*') ? '所有会话' : roots.length ? roots.join('、') : '未启用护栏',
              '在这些目录里的会话，规划端不能直接改文件，改动交给 Codex。'),
            statusRow('主机访问', !activeSettings ? '未读到' : !activeSettings.allowHostAccess ? '未开启'
              : activeSettings.defaultHostAccess ? '已开启且默认使用' : '已开启，需逐单指定', '主机访问让 Codex 能启动 Windows 程序。'),
            activeSettings?.allowHostAccess ? h('p', { className: 'dcc-warn', role: 'status' },
              `使用主机访问的任务里，Codex 不在沙箱内运行，对整台机器有完全访问权限${activeSettings.defaultHostAccess ? '；当前每一单默认使用。' : '。'}`) : null,
            unknownConfig.length ? h(Message, { error: true, text: `未识别的配置项：${unknownConfig.join('、')}。这些配置没有生效，请核对拼写。` }) : null,
            statusRow('正在执行的任务', runtime?.active_tasks ?? '未读到', 'Codex 活任务数量；等空闲会同时等待 DeepSeek 会话的当前回合结束。'),
            statusRow('正在运行的 DeepSeek 会话回合', runtime?.active_sessions ?? '未读到', '统计所有会话中正在进行的回合，包括等待模型回复的会话。'),
            statusRow('最近 24 小时内需要关注的任务', attention ?? (errors.attention ? '未读到' : '正在读取…'), '只统计最近 24 小时内开始、需要你查看的任务。'),
            h(Message, { text: errors.attention, error: true }),
            h(Message, { text: profileError, error: true }), h(Message, { text: loadedError, error: true }),
            h('details', null, h('summary', null, '更多运行信息'),
              statusRow('加载时间', runtime?.loaded?.loadedAt ? new Date(runtime.loaded.loadedAt).toLocaleString('zh-CN') : '未读到', '这是当前运行版本的加载时间。'),
              statusRow('已保存的版本', runtime?.source?.version || '未读到', '这是磁盘上可供下一次加载的插件版本。'),
              statusRow('重新加载', runtime?.can_reload ? '现在可以操作' : '暂时不能操作', '只有服务确认可以加载时，下面的按钮才可用。'),
              statusRow('设置读取', profileError ? '有错误，见上方提示' : '未发现错误', '读取已保存设置遇到的问题会显示在折叠外。'),
              statusRow('运行版本读取', loadedError ? '有错误，见上方提示' : '未发现错误', '读取当前运行版本遇到的问题会显示在折叠外。')),
            runtime?.active_error ? h(Message, { error: true, text: '无法确认正在执行的任务数量，请刷新后重试；仍然失败请联系维护者。' }) : null,
            runtime?.sessions_error ? h(Message, { error: true, text: '无法确认正在运行的 DeepSeek 会话回合，不能执行等空闲重载。请刷新后重试；仍然失败请联系维护者。' }) : null) : null,
          runtime?.idle_wait ? h(Message, { error: runtime.idle_wait.status === 'timed_out',
            text: idleWaitText(runtime, pending ? '自动生效' : '自动重新加载') }) : null,
          pending ? h('div', { className: 'dcc-status' },
            h(Message, { text: pending.awaiting_load ? '设置已写入，等待加载生效。' : pending.error ? '设置已保存，但未能生效。'
              : runtime.idle_wait ? '设置已保存，等待空闲后自动生效。' : `已保存，${idleWaitText(runtime, '自动生效')}` }),
            h('small', null, pending.awaiting_load ? '设置已经写入，不能再撤销。请刷新运行状态确认是否生效。' : '待生效修改尚未用于当前任务。可以继续修改设置后保存，也可以撤销。'),
            pending.error ? h(Message, { error: true, text: `待生效设置未能生效：${pendingError(pending.error)} ${pending.awaiting_load ? '请刷新状态，仍未生效请联系维护者。' : '可修改设置后重新保存，或撤销这次修改。'}` }) : null,
            !pending.awaiting_load ? h(Button, { size: 'sm', disabled: !!busy, onClick: onCancel }, '撤销这次修改') : null) : null,
          h(Button, { variant: 'outline', disabled: !!busy || !!errors.status || !runtime?.can_reload,
            onClick: onReload }, busy === 'reload' ? '正在重新加载…' : '重新加载插件（等任务结束）'),
          h('small', null, '等 Codex 活任务和所有 DeepSeek 会话的当前一轮结束后重载，最长等 10 分钟；超时不强制重载，请重新请求。'),
          h(Message, { text: messages.reload }), h(Message, { text: errors.reload, error: true }),
          onDoctor ? h('div', { className: 'dcc-actions' },
            h(Button, { size: 'sm', disabled: !!busy, onClick: onDoctor }, '环境自检'),
            h('small', null, '只读检查 Codex 运行环境，不启动任务；点一次查一次。'),
            h(Message, { text: messages.doctor }), h(Message, { text: errors.doctor, error: true }),
            doctor ? h('ul', { className: 'dcc-jobs', 'aria-label': '环境自检结果' }, ...(doctor.checks || []).map((check) => {
              // 用 API Key 或自定义提供方时没有 auth.json，属于正常情况。
              const hint = !check.ok && check.name === 'codex_auth';
              return h('li', { key: check.name, className: check.ok || hint ? 'dcc-muted' : 'dcc-error' },
                `${check.name}：${check.ok ? '通过' : hint ? '提示' : '未通过'}${check.detail ? ` — ${check.detail}` : ''}`,
                hint ? h('small', null, '没有检测到登录文件；用 API Key 或自定义提供方时属于正常。') : null);
            })) : null) : null);
    }

    function Report({ jobId, refreshKey, onClose, selftest }) {
      const [document, setDocument] = useState(null);
      const [pageIndex, setPageIndex] = useState(0);
      const [raw, setRaw] = useState(false);
      const [error, setError] = useState('');
      const [loading, setLoading] = useState(true);
      const [revision, setRevision] = useState(0);
      const [artifact, setArtifact] = useState('report');
      const life = useRef(null);
      const page = document?.pages[pageIndex];
      useEffect(() => {
        const controller = new AbortController();
        life.current = controller;
        setLoading(true);
        setError('');
        setDocument(null);
        setPageIndex(0);
        loadReport(jobId, controller.signal, selftest?.read || api, artifact)
          .then((value) => { if (!controller.signal.aborted) setDocument(value); })
          .catch((err) => { if (!controller.signal.aborted) setError(userError(err.message)); })
          .finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
      }, [jobId, revision, artifact]);
      useEffect(() => {
        if (document?.pending && !selftest) setRevision((value) => value + 1);
      }, [refreshKey]);
      useEffect(() => { if (!loading) selftest?.finish(); }, [loading, selftest]);
      async function nextPage() {
        if (document.pages[pageIndex + 1]) { setPageIndex(pageIndex + 1); return; }
        const controller = life.current;
        setLoading(true);
        setError('');
        try {
          const next = await api(reportPath(jobId, page.next_offset, artifact), controller.signal);
          if (!controller.signal.aborted) {
            setDocument((old) => ({ ...old, pages: [...old.pages, { ...next, offset: page.next_offset }] }));
            setPageIndex(pageIndex + 1);
          }
        } catch (err) { if (!controller.signal.aborted) setError(userError(err.message)); }
        finally { if (!controller.signal.aborted) setLoading(false); }
      }
      const readable = document?.report && !raw;
      const pending = document?.pending;
      return h('div', { className: 'dcc-actions', 'data-dcc-report': jobId },
        h('div', { className: 'dcc-row' },
          h('strong', null, readable || pending ? '任务报告' : `任务报告 · 第 ${pageIndex + 1} 页`),
          document?.report ? h(Button, { size: 'sm', onClick: () => setRaw((value) => !value) }, raw ? '查看易读报告' : '查看原文') : null,
          h(Button, { size: 'sm', onClick: onClose }, '收起报告')),
        selftest ? null : h('div', { className: 'dcc-row', role: 'group', 'aria-label': '查看内容' },
          ...ARTIFACTS.map(([value, label]) => h(Button, { key: value, size: 'sm', variant: artifact === value ? 'primary' : 'ghost',
            'aria-pressed': artifact === value, onClick: () => setArtifact(value) }, label))),
        h('small', null, `任务编号：${jobId}。${pending ? '' : readable ? '已读完报告。' : '原文每页最多 8000 字符，可翻页查看。'}`),
        document?.tooLarge ? h('small', null, '报告超过 262144 字符，仅提供原文分页。') : null,
        document && !pending && !document.report && !document.tooLarge && artifact === 'report' ? h('small', null, '这份报告不支持易读视图，以下显示原文。') : null,
        h(Message, { text: error, error: true }),
        loading ? h('p', { role: 'status' }, '正在读取报告…') : null,
        pending ? h('p', { role: 'status', 'data-dcc-report-pending': true }, '这个任务还在运行，报告会在任务结束后生成。') : null,
        readable ? h(ReadableReport, { report: document.report, acceptance: document.pages[0].acceptance }) : page ? h('pre', { className: 'dcc-report', tabIndex: 0, 'aria-label': '本页报告全文' }, page.text || '这一页还没有输出。') : null,
        h('div', { className: 'dcc-row' },
          !readable && !pending ? h(Button, { size: 'sm', disabled: loading || pageIndex === 0, onClick: () => setPageIndex((v) => v - 1) }, '上一页') : null,
          !readable && !pending ? h(Button, { size: 'sm', disabled: loading || !page || page.eof || !(page.next_offset > page.offset), onClick: nextPage }, '下一页') : null,
          h(Button, { size: 'sm', disabled: loading, onClick: () => setRevision((v) => v + 1) }, '刷新报告'),
          !readable && page?.eof ? h('small', null, '已到当前输出末尾；任务运行中可刷新报告。') : null));
    }

    function Panel({ selftest } = {}) {
      const [status, setStatus] = useState(null);
      const [attention, setAttention] = useState(null);
      const [settings, setSettings] = useState(null);
      const [edits, setEdits] = useState({});
      const [jobs, setJobs] = useState(null);
      const [filter, setFilter] = useState('all');
      const [jobOffsets, setJobOffsets] = useState([0]);
      const jobOffset = jobOffsets[jobOffsets.length - 1];
      // 两份提示词（planner / executor）共用一套状态：已保存的原文、未保存的草稿、展开的备份列表。
      const [prompts, setPrompts] = useState({});
      const [drafts, setDrafts] = useState({});
      const [backups, setBackups] = useState({});
      const [injected, setInjected] = useState(null);
      const [search, setSearch] = useState('');
      const [searchDraft, setSearchDraft] = useState('');
      const [gemini, setGemini] = useState(null);
      const [doctor, setDoctor] = useState(null);
      const [session, setSession] = useState({});
      const [confirmSession, setConfirmSession] = useState(null);
      // 正在走回滚流程的任务：先检查（checked 之前只有 id），通过后再确认。
      const [rollback, setRollback] = useState(null);
      const [sessionResults, setSessionResults] = useState(null);
      const [errors, setErrors] = useState({});
      const [messages, setMessages] = useState({});
      const [busy, setBusy] = useState('');
      const [confirmJob, setConfirmJob] = useState(null);
      const [confirmApply, setConfirmApply] = useState(false);
      const [reportJob, setReportJob] = useState(null);
      const [revision, setRevision] = useState(0);
      const life = useRef(null);
      const mutation = useRef(false);
      const generation = useRef(0);

      useEffect(() => {
        const controller = new AbortController();
        life.current = controller;
        return () => { controller.abort(); life.current = null; };
      }, []);

      useEffect(() => {
        const controller = new AbortController();
        let timer, round = 0, running = false;
        async function refresh() {
          // 页面不可见时不读取，只排下一轮；自检在离屏节点里只读一次，不受此限制。
          if (!mutation.current && (selftest || !globalThis.document?.hidden)) {
            const version = generation.current;
            // A poll started before a save must not replace the newly saved values.
            const fresh = () => !controller.signal.aborted && version === generation.current && !mutation.current;
            async function read(key, route, update) {
              try {
                const value = await (selftest?.read || api)(route, controller.signal);
                if (!fresh()) return;
                update(value);
                setErrors((old) => ({ ...old, [key]: '' }));
              } catch (error) {
                if (fresh()) setErrors((old) => ({ ...old, [key]: userError(error.message) }));
              }
            }
            // /jobs 和 /attention 各启动一次 wsl.exe：只有状态每轮读，其余首轮读、之后每 4 轮读一次；有任务在跑时任务列表每轮读。
            const full = round++ % 4 === 0;
            const reads = [
              // /status 自带当前设置，表单不必等下一次完整读取。
              read('status', '/status', (value) => { setStatus(value); if (value.settings) setSettings(value.settings); }),
              full && read('settings', '/settings', setSettings),
              (full || running) && read('jobs', `/jobs?filter=${filter}&offset=${jobOffset}${search ? `&q=${encodeURIComponent(search)}` : ''}`, (value) => {
                running = value.jobs.some((job) => (job.execution_status || job.status) === 'running');
                setJobs(value);
              }),
              full && read('prompt', '/prompt', (value) => {
                setPrompts((old) => ({ ...old, planner: value.text }));
                setInjected(value.injected ?? null);
              }),
              full && read('attention', '/attention', (value) => setAttention(value.total)),
              // 自检只读原有的五个接口。
              full && !selftest && read('executor', '/prompt?kind=executor', (value) => setPrompts((old) => ({ ...old, executor: value.text }))),
              full && !selftest && read('gemini', '/gemini', (value) => setGemini(value.entries || [])),
            ];
            await Promise.all(reads);
          }
          if (!controller.signal.aborted && !selftest) timer = setTimeout(refresh, 7000);
        }
        refresh();
        return () => { controller.abort(); clearTimeout(timer); };
      }, [filter, revision, jobOffset, search]);

      useEffect(() => {
        if (!selftest || !['status', 'settings', 'jobs', 'prompt', 'attention'].every((key) => Object.hasOwn(errors, key))) return;
        if (jobs?.jobs.length) setReportJob((jobs.jobs.find((job) => ['completed', 'failed', 'cancelled'].includes(job.execution_status || job.status)) || jobs.jobs[0]).job_id);
        else selftest.finish();
      }, [selftest, errors, jobs]);

      function selectJobPage(offsets) {
        generation.current += 1;
        setJobOffsets(offsets);
        setJobs(null);
        setConfirmJob(null);
        setErrors((old) => ({ ...old, jobs: '' }));
      }

      async function mutate(key, path, body, success) {
        if (selftest || mutation.current || !life.current) return;
        const controller = life.current;
        mutation.current = true;
        generation.current += 1;
        setBusy(key);
        setMessages((old) => ({ ...old, [key]: '' }));
        setErrors((old) => ({ ...old, [key]: '' }));
        try {
          const value = await api(path, controller.signal, body);
          if (!controller.signal.aborted) success(value);
        } catch (err) {
          if (!controller.signal.aborted) {
            const kind = { promptSave: 'planner', executorSave: 'executor' }[key];
            if (err.saved && kind) { setPrompts((old) => ({ ...old, [kind]: body.text })); setDrafts((old) => ({ ...old, [kind]: null })); }
            setErrors((old) => ({ ...old, [key]: err.saved
              ? `内容已保存，但后续处理没有完成：${userError(err.message)} 请查看运行状态，草稿已保留。`
              : userError(err.message) }));
          }
        } finally {
          mutation.current = false;
          if (!controller.signal.aborted) { setBusy(''); setRevision((v) => v + 1); }
        }
      }

      // 点击才读一次的只读请求（备份、环境自检、最近结果）；不进轮询，自检渲染里不发。
      async function fetchOnce(key, path, apply) {
        if (selftest || !life.current) return;
        const controller = life.current;
        setErrors((old) => ({ ...old, [key]: '' }));
        setMessages((old) => ({ ...old, [key]: '正在读取…' }));
        try {
          const value = await api(path, controller.signal);
          if (!controller.signal.aborted) apply(value);
        } catch (err) {
          if (!controller.signal.aborted) setErrors((old) => ({ ...old, [key]: userError(err.message) }));
        } finally {
          if (!controller.signal.aborted) setMessages((old) => ({ ...old, [key]: '' }));
        }
      }

      function acceptSettings(patch, value) {
        const result = value.runtime;
        const waiting = result?.status === 'waiting_for_idle';
        if (!waiting) setSettings((old) => mergeSettings(old, patch));
        setStatus((old) => ({ ...old, runtime: { ...old?.runtime, ...result,
          pending_settings: result?.pending_settings ?? null } }));
        setEdits({});
        setConfirmApply(false);
        const text = waiting ? ''
          : result?.status === 'reloaded' || result?.status === 'already_current' ? '设置已保存并生效。'
            : '设置已保存，但还没有确认生效。请刷新运行状态查看。';
        setMessages((old) => ({ ...old, settingsSave: text }));
      }

      const runtime = status?.runtime;
      const pending = runtime?.pending_settings;
      const editingSettings = mergeSettings(settings, pending?.changes);
      let patch = {};
      let validation = '';
      let dirty = false;
      if (settings) {
        try {
          patch = pendingPatch(settings, pending, edits);
          dirty = Object.keys(settingsPatch(editingSettings, edits)).length > 0;
        }
        catch (err) { validation = err.message; }
      }
      dirty ||= !!validation;
      function cancelPending(clearDraft = false) {
        return mutate('settingsSave', '/settings/cancel', {}, () => {
          setStatus((old) => ({ ...old, runtime: { ...old?.runtime, pending_settings: null, idle_wait: null } }));
          setConfirmApply(false);
          if (clearDraft) setEdits({});
          setMessages((old) => ({ ...old, settingsSave: '已撤销待生效修改，当前运行设置不变。' }));
        });
      }
      function saveSettings(now = false) {
        if (!Object.keys(patch).length) return cancelPending(true);
        return mutate('settingsSave', now ? '/settings/apply' : '/settings', now ? { changes: patch, confirm: true } : patch,
          (value) => acceptSettings(patch, value));
      }
      const edit = (key, value) => {
        setConfirmApply(false);
        setEdits((old) => ({ ...old, [key]: value }));
        setMessages((old) => ({ ...old, settingsSave: '' }));
        setErrors((old) => ({ ...old, settingsSave: '' }));
      };
      function field(key, label, hint, options) {
        const value = Object.hasOwn(edits, key) ? edits[key] : fieldValue(editingSettings, key);
        const control = options
          ? h('select', { value: displayValue(value), disabled: !!busy, onChange: (event) => edit(key, event.target.value) },
            !options.some(([v]) => v === displayValue(value)) ? h('option', { value: displayValue(value), disabled: true }, value ? '当前值不在列表中，请重新选择' : '请选择') : null,
            ...options.map(([v, label]) => h('option', { key: v, value: v }, label)))
          : h(Input, { value: displayValue(value), disabled: !!busy,
            type: NUMBERS[key] ? 'number' : 'text',
            ...(NUMBERS[key] ? { min: 0, step: 'any' } : { maxLength: 80, spellCheck: false }),
            onChange: (event) => edit(key, event.target.value) });
        return h('label', { className: 'dcc-field', key }, h('span', null, label), control, h('small', null, hint));
      }
      const listDraft = (key) => Object.hasOwn(edits, key) ? edits[key] : (fieldValue(editingSettings, key) || []).join('\n');
      function listField(key, label, hint) {
        return h('label', { className: 'dcc-field', key }, h('span', null, label),
          h('textarea', { className: 'dcc-short', value: listDraft(key), disabled: !!busy, spellCheck: false,
            onChange: (event) => edit(key, event.target.value) }), h('small', null, hint));
      }
      const allowDraft = settings ? listLines(listDraft('allowTools')) : [];
      const diffText = { empty: '没有文件改动', skipped: '这一单没有记录改动 diff', not_git: '任务目录不是 git 仓库，没有记录改动 diff',
        too_large: '改动太大，没有记录 diff' };
      const executionText = { running: '运行中', completed: '已结束', failed: '执行失败', cancelled: '已取消', unknown: '状态待确认' };
      const pageJobs = jobs?.jobs ?? [];
      const verificationText = { unreviewed: '未核验', verified: '已通过', needs_changes: '待修正', accepted_deviations: '已接受偏差', invalid: '记录异常' };
      const phaseText = { lock_wait: '排队等待目录写锁', codex_running: 'Codex 执行中', codex_reconnecting: '正在重连' };
      const when = (value) => new Date(value).toLocaleString('zh-CN');

      // 规划提示词和给 Codex 的固定要求共用这一段界面；planner 沿用原有的请求体。
      function promptSection(kind, title, intro, label, longHint) {
        const readKey = kind === 'planner' ? 'prompt' : 'executor', saveKey = `${readKey}Save`, backupKey = `${readKey}Backups`;
        const saved = prompts[kind] ?? null, draft = drafts[kind] ?? null;
        const value = draft === null ? saved ?? '' : draft;
        const dirty = saved !== null && value !== saved;
        const count = effectiveLength(value);
        const list = backups[kind];
        const setDraft = (text) => setDrafts((old) => ({ ...old, [kind]: text }));
        return h('section', { 'aria-label': title }, h('h3', null, title),
          h('p', { className: 'dcc-muted' }, intro),
          h(Message, { text: errors[readKey], error: true }),
          kind === 'planner' && injected !== null ? h('small', null, injected ? '已注入系统提示词。'
            : '未注入系统提示词：宿主没有提供系统提示词服务，这段内容当前不会生效。') : null,
          h('label', { className: 'dcc-field' }, h('span', null, label),
            h('textarea', { value, disabled: saved === null || !!busy,
              placeholder: saved === null ? (errors[readKey] ? '暂时无法读取。' : '正在读取…') : '在这里填写，也可以留空。',
              onChange: (event) => { setDraft(event.target.value); setMessages((old) => ({ ...old, [saveKey]: '' })); setErrors((old) => ({ ...old, [saveKey]: '' })); } })),
          h('small', null, `有效字数：${count}（不含注释和首尾空白）`),
          count > 4000 ? h(Message, { text: longHint }) : null,
          h('div', { className: 'dcc-row dcc-actions' },
            h(Button, { variant: 'primary', disabled: !!busy || !dirty,
              onClick: () => mutate(saveKey, '/prompt', kind === 'planner' ? { text: value } : { text: value, kind }, () => {
                setPrompts((old) => ({ ...old, [kind]: value })); setDraft(null);
                setBackups((old) => ({ ...old, [kind]: null }));
                setMessages((old) => ({ ...old, [saveKey]: `${title}已保存。` }));
              }) }, busy === saveKey ? '正在保存…' : `保存${title}`),
            h(Button, { disabled: !!busy || !dirty, onClick: () => { setDraft(null); setErrors((old) => ({ ...old, [saveKey]: '' })); } },
              kind === 'planner' ? '放弃提示词更改' : '放弃固定要求的更改'),
            dirty ? h('small', null, kind === 'planner' ? '有未保存的提示词。' : '有未保存的固定要求。') : null),
          h(Message, { text: messages[saveKey] }), h(Message, { text: errors[saveKey], error: true }),
          h('div', { className: 'dcc-actions' },
            h(Button, { size: 'sm', disabled: saved === null, onClick: () => list ? setBackups((old) => ({ ...old, [kind]: null }))
              : fetchOnce(backupKey, `/prompt/backups?kind=${kind}`, (result) => setBackups((old) => ({ ...old, [kind]: result.backups || [] }))) },
            list ? '收起历史备份' : '查看历史备份'),
            h('small', null, '每次保存前自动备份，保留最近 10 份。'),
            h(Message, { text: messages[backupKey] }), h(Message, { text: errors[backupKey], error: true }),
            list && !list.length ? h('p', null, '还没有历史备份。') : null,
            list?.length ? h('ul', { className: 'dcc-jobs', 'aria-label': `${title}的历史备份` }, ...list.map((backup) =>
              h('li', { key: backup.name, className: 'dcc-job' },
                h('small', null, `${when(backup.savedAt)} · ${backup.size} 字节`),
                h(Button, { size: 'sm', disabled: !!busy,
                  onClick: () => fetchOnce(backupKey, `/prompt/backup?kind=${kind}&name=${encodeURIComponent(backup.name)}`, (result) => {
                    setDraft(result.text);
                    setMessages((old) => ({ ...old, [saveKey]: '已把备份内容放进编辑框，核对后点保存才会生效。' }));
                  }) }, '载入到编辑框')))) : null));
      }

      const sessionField = (key, label, props = {}, control = Input) => h('label', { className: 'dcc-field' }, h('span', null, label),
        h(control, { value: session[key] || '', disabled: !!busy, spellCheck: false, ...props,
          onChange: (event) => { setConfirmSession(null); setSession((old) => ({ ...old, [key]: event.target.value })); } }));
      const sessionSubmit = (key, path, body) => mutate(key, path, body, () => {
        setConfirmSession(null);
        setMessages((old) => ({ ...old, [key]: '请求已提交，稍后点“查看最近结果”确认处理情况。' }));
      });
      const sessionIds = (session.resumeIds || '').split(/[\s,，、]+/).filter(Boolean);
      const resultLines = (label, value) => !value ? [`${label}：暂无结果`]
        : [`${label}（${value.completedAt ? when(value.completedAt) : '时间未知'}）${value.status ? `：${value.status}${value.reason ? ` / ${value.reason}` : ''}` : ''}${value.error ? ` / ${value.error}` : ''}`,
          ...(Array.isArray(value.sessions) ? value.sessions.map((entry) =>
            `${entry.sessionId}：${entry.status} / ${entry.reason}${entry.error ? ` / ${entry.error}` : ''}`) : value.sessionId ? [`会话 ${value.sessionId}`] : [])];

      return h('div', { className: 'dcc-panel' },
        h('style', null, CSS),
        h(Status, { status, attention, errors, messages, busy, doctor, onRefresh: () => setRevision((v) => v + 1),
          onDoctor: selftest ? undefined : () => fetchOnce('doctor', '/doctor', setDoctor),
          onCancel: () => cancelPending(), onReload: () => mutate('reload', '/reload', {}, (value) => {
            setStatus((old) => ({ ...old, runtime: { ...old?.runtime, ...value } }));
            const text = { reloaded: '已重新加载，正在刷新运行状态。', already_current: '当前已经是已保存的版本。',
              unconfirmed: '已请求加载，但还没有确认生效，请刷新运行状态查看。',
              waiting_for_idle: '', failed: '重新加载失败，请刷新运行状态后重试。'
            }[value.status] ?? '服务没有确认加载结果，请刷新运行状态查看。';
            if (value.status === 'failed') setErrors((old) => ({ ...old, reload: text }));
            else setMessages((old) => ({ ...old, reload: text }));
          }) }),

        h('section', { 'aria-label': '常用设置' }, h('h3', null, '常用设置'),
          h(Message, { text: errors.settings, error: true }),
          settings ? h('div', null,
            h('div', { className: 'dcc-grid' },
              field('model', 'Codex 模型', '填写要使用的模型名；留空则沿用 Codex 配置。'),
              field('effort', '执行时的思考程度', '越高通常想得越久，也可能花更多时间。', [['', '跟随 Codex 配置'], ...EFFORTS]),
              field('readOnlyEffort', '只读任务的思考程度', '用于查看代码、分析和复核。', [['', '跟随执行设置'], ...EFFORTS]),
              field('effortOverride', '单次推理强度覆盖', '控制 codex_run 能否覆盖写入或只读任务的默认强度。', [['planner', '由规划端指定（默认）'], ['raise-only-listed', '提高强度须填写列明的原因'], ['config', '使用配置强度']]),
              field('serviceTier', '速度档', '跟随 Codex 配置，或使用账号支持的加速档位。', [['', '跟随 Codex 配置'], ['fast', 'fast'], ['ultrafast', 'ultrafast']]),
              field('timeoutSeconds', '每次尝试的总超时秒数', 'Codex 的一次尝试最多跑多久；留空表示沿用默认。'),
              field('idleTimeoutSeconds', '空闲超时秒数', 'Codex 多久没有动静就判定卡住；留空表示沿用默认。'),
              field('retries', '自动重试次数', '连接出问题时最多自动重试几次，可填 0；留空表示沿用默认。'),
              field('repeatFailureGuard.minSeconds', '计入失败的最短秒数', '用时达到此值的失败步骤才计数。'),
              field('repeatFailureGuard.failures', '触发拦截的失败次数', '同一步骤达到该次数后，再次运行会被拦下。'),
              field('repeatFailureGuard.windowHours', '重复失败的统计窗口（小时）', '从最后一次失败起保留计数的时长。'),
              field('maxRunningJobs', '同时运行的任务数上限', '达到上限后不再启动新任务；留空表示不限制。'),
              field('lockTimeoutSeconds', '等待其他任务的秒数', '要修改同一目录时，最多等其他任务多久；留空表示不限制，一直等。'),
              field('maxStorageMb', '任务记录占用空间上限（MiB）', '超过上限时会清理最旧的已结束任务记录；留空表示不限制。'),
              field('maxSessionJobs', '每个会话最多派几单', '一个会话累计派出的任务数上限；留空表示不限制。'),
              field('maxSessionTokens', '每个会话的用量上限（token）', '一个会话里 Codex 任务累计用量的上限；留空表示不限制。'),
              field('handoverSuggestMessages', '建议交接的消息数', '会话消息数超过这个值时提示可以交接到新会话（只提示）；0 表示关闭，留空恢复默认 5000。'),
              field('acceptanceWarnAbove', '验收标准条数提醒', '新派活的验收标准超过这么多条时，提醒 DeepSeek 把偏好写进任务正文（不拦截）；0 表示关闭，留空恢复默认 8。'),
              field('continueFreshAboveTokens', '续接开新线程的阈值（token）', '不带回答的续接，原线程上次请求超过这么多输入 token 时改开新线程，只带上轮交接内容；0 表示总是沿用原线程，留空恢复默认 100000。'),
              field('closeoutEvidence', '结案依据要求', '原报告自标未满足的条目要记成满足时需要什么依据。', [['independent', '需要独立依据（默认）'], ['planner', '规划端自己的证据即可'], ['off', '不检查']]),
              field('acceptOpenEvidence', '接受未完成项的依据', '保留原报告标出的未完成项时需要什么依据。', [['strict', '未满足须核验或用户确认（默认）'], ['relaxed', '也接受返工结果或待用户处理的阻塞'], ['off', '不检查']]),
              field('autoVerify', '完成后自动核验', '写任务完成且报告有未完成项或任务有 must_verify 时，自动派出只读核验。', [['flagged', '自动核验（默认）'], ['off', '关闭']]),
              field('toolPolicy', '工具放行方式', '决定受护栏会话里规划端能用哪些工具。',
                [['denylist', '按拒绝名单（默认）'], ['allowlist', '只放行白名单内的工具']]),
              settings.gemini ? field('gemini.model', 'Gemini 模型', '只影响已经配置好的 Gemini 写作功能。') : null,
              settings.gemini ? field('gemini.effort', 'Gemini 思考程度', 'Gemini 支持低、中、高三档。', EFFORTS.slice(0, 3)) : null),
            h('div', { className: 'dcc-actions' },
              h(Checkbox, { label: '自动回答 Codex 的问题', checked: Object.hasOwn(edits, 'plannerAnswers') ? edits.plannerAnswers : editingSettings.plannerAnswers === true,
                disabled: !!busy, onChange: (value) => edit('plannerAnswers', value) }),
              h('small', null, '打开后 DeepSeek 会替你回答 Codex 的问题并继续干活，不再等你')),
            h('div', { className: 'dcc-actions' },
              h(Checkbox, { label: '规划端只读 Codex 的产物，不直接读源码',
                checked: (Object.hasOwn(edits, 'plannerReads') ? edits.plannerReads : editingSettings.plannerReads) === 'products',
                disabled: !!busy, onChange: (value) => edit('plannerReads', value ? 'products' : 'open') }),
              h('small', null, '打开后，源码和资料交给 Codex 去读，规划端只看产物；需要核对内容时也交给 Codex。')),
            h('div', { className: 'dcc-actions' },
              h(Checkbox, { label: '重启后自动续接',
                checked: (Object.hasOwn(edits, 'autoResume.enabled') ? edits['autoResume.enabled'] : editingSettings.autoResume?.enabled) !== false,
                disabled: !!busy, onChange: (value) => edit('autoResume.enabled', value) }),
              h('small', null, 'Harness 重启后，自动接着做上次被打断的会话。')),
            h('div', { className: 'dcc-actions' },
              h(Checkbox, { label: '拦截重复失败的步骤',
                checked: (Object.hasOwn(edits, 'repeatFailureGuard.enabled') ? edits['repeatFailureGuard.enabled'] : editingSettings.repeatFailureGuard?.enabled) !== false,
                disabled: !!busy, onChange: (value) => edit('repeatFailureGuard.enabled', value) })),
            h('div', { className: 'dcc-actions' },
              h(Checkbox, { label: '记录每单的改动 diff', checked: (Object.hasOwn(edits, 'jobDiff') ? edits.jobDiff : editingSettings.jobDiff) === true,
                disabled: !!busy, onChange: (value) => edit('jobDiff', value) }),
              h('small', null, '记录后可以在任务报告里查看这一单改了什么，也可以回滚这一单的改动。')),
            h('div', { className: 'dcc-actions' },
              h(Checkbox, { label: '未收尾时拒绝开新任务', checked: (Object.hasOwn(edits, 'closeoutGuard') ? edits.closeoutGuard : editingSettings.closeoutGuard) !== false,
                disabled: !!busy, onChange: (value) => edit('closeoutGuard', value) }),
              h('small', null, '还有报告标出问题却没验收、或判为需修改却没返工的任务时，DeepSeek 不能开新任务，要先收尾。')),
            (Object.hasOwn(edits, 'toolPolicy') ? edits.toolPolicy : editingSettings.toolPolicy) === 'allowlist' ? h('p', { className: 'dcc-warn', role: 'status' },
              '白名单模式下，未列入白名单的工具在受护栏会话里会被拒绝。') : null,
            h('div', { className: 'dcc-grid dcc-actions' },
              listField('allowTools', '白名单工具', '一行一个工具名；以 * 结尾表示放行这个前缀开头的所有工具。只在白名单模式下生效。'),
              listField('plannerReadAllow', '额外允许读取的路径', '一行一个完整路径，可以是文件或目录；“规划端只读 Codex 的产物”打开时，这些路径仍可直接读取。')),
            settings.seenTools?.length ? h('div', { className: 'dcc-actions' },
              h('small', null, '这些工具在受护栏会话里出现过，白名单模式下会被拒绝：'),
              h('ul', { className: 'dcc-jobs', 'aria-label': '出现过但不在白名单里的工具' }, ...settings.seenTools.map((tool) =>
                h('li', { key: tool, className: 'dcc-row' }, h('span', null, tool),
                  h(Button, { size: 'sm', disabled: !!busy || allowDraft.includes(tool),
                    onClick: () => edit('allowTools', [...allowDraft, tool].join('\n')) },
                  allowDraft.includes(tool) ? '已在白名单草稿里' : '加入白名单'))))) : null,
            h(Message, { text: validation, error: true }),
            h('div', { className: 'dcc-row dcc-actions' },
              h(Button, { variant: 'primary', disabled: !!busy || (!dirty && !(pending?.error && !pending.awaiting_load)) || !!validation,
                onClick: () => saveSettings() }, busy === 'settingsSave' ? '正在保存设置…' : '等当前任务结束后自动生效'),
              h(Button, { disabled: !!busy || (!dirty && !pending) || !!validation || !Object.keys(patch).length,
                onClick: () => setConfirmApply(true) }, '立即生效'),
              h(Button, { disabled: !!busy || !dirty, onClick: () => { setEdits({}); setConfirmApply(false); setErrors((old) => ({ ...old, settingsSave: '' })); } }, '放弃未保存的更改'),
              dirty ? h('small', null, '有未保存的设置。') : null),
            h('small', null, 'Codex 活任务和所有 DeepSeek 会话的当前一轮均结束时，保存后立即生效；否则最长等 10 分钟。超时停止自动重载，保留待生效设置，请重新保存或撤销。再次保存会替换上一次待生效修改。'),
            confirmApply ? h('div', { className: 'dcc-confirm' },
              h('p', null, '确定让这些设置立即生效吗？Codex 后台任务会继续运行，重载后会自动接回；正在进行的 DeepSeek 回合可能被中止，包括正在等待模型回复的回合。要保留当前回合，请选择等空闲生效。'),
              h('div', { className: 'dcc-row' },
                h(Button, { variant: 'outline', disabled: !!busy || !!validation, onClick: () => saveSettings(true) }, '确认立即生效'),
                h(Button, { disabled: !!busy, onClick: () => setConfirmApply(false) }, '先不生效'))) : null,
            h(Message, { text: messages.settingsSave }), h(Message, { text: errors.settingsSave, error: true }))
            : h('p', null, errors.settings ? '设置暂时无法读取，请刷新后重试。' : '正在读取设置…')),

        h('section', { 'aria-label': '最近任务' }, h('h3', null, '最近任务'),
          h('div', { className: 'dcc-row', role: 'group', 'aria-label': '筛选任务' },
            ...[['running', '正在跑'], ['attention', '待关注'], ['all', '全部']].map(([value, label]) =>
              h(Button, { key: value, size: 'sm', variant: filter === value ? 'primary' : 'ghost', 'aria-pressed': filter === value,
                onClick: () => { if (value !== filter) { setFilter(value); selectJobPage([0]); } } }, label)),
            h('small', null, '“待关注”包含历史任务')),
          h('div', { className: 'dcc-row' },
            h(Input, { value: searchDraft, placeholder: '任务编号或会话编号', 'aria-label': '搜索任务', maxLength: 100, spellCheck: false,
              onChange: (event) => setSearchDraft(event.target.value) }),
            h(Button, { size: 'sm', disabled: searchDraft.trim() === search,
              onClick: () => { setSearch(searchDraft.trim()); selectJobPage([0]); } }, '搜索'),
            search ? h(Button, { size: 'sm', onClick: () => { setSearch(''); setSearchDraft(''); selectJobPage([0]); } }, '清除搜索') : null),
          h('small', null, jobs ? `第 ${jobOffsets.length} 页，共 ${jobs.total} 项，本页 ${pageJobs.length} 项。` : errors.jobs ? '暂时读不到任务。' : '正在读取任务…'),
          h(Message, { text: errors.jobs, error: true }),
          jobs && !pageJobs.length ? h('p', null, '本页没有任务。') : null,
          h('ul', { className: 'dcc-jobs' }, ...pageJobs.map((job) => {
            const running = (job.execution_status || job.status) === 'running';
            const counts = job.criteria_counts;
            const canRollback = ['completed', 'failed', 'cancelled'].includes(job.execution_status || job.status) &&
              job.diff_status === 'captured' && !job.rolled_back_at;
            // 只显示任务记录里实际有的信息。
            const facts = [job.owner && `会话 ${job.owner}`, job.cwd && `目录 ${job.cwd}`,
              job.duration_s != null && `耗时 ${Math.round(job.duration_s)} 秒`,
              !running && counts && `验收 ${counts.met} 通过 / ${counts.not_met} 未通过 / ${counts.blocked} 受阻`,
              job.error_kind && `失败原因 ${job.error_kind}`,
              job.verification_status && `独立核验 ${verificationText[job.verification_status] || job.verification_status}`,
              running && job.phase && `当前阶段 ${phaseText[job.phase] || job.phase}${job.attempt ? `（第 ${job.attempt} 轮）` : ''}`,
              running && (job.last_activity ? `最近活动 ${job.last_activity}` : job.updated_at && `最近活动 ${when(job.updated_at * 1000)}`),
              job.diff_status === 'captured' ? `改动 diff ${job.diff_files != null ? `${job.diff_files} 个文件` : '已记录'}` : diffText[job.diff_status],
              job.rolled_back_at && `已回滚 ${when(typeof job.rolled_back_at === 'number' ? job.rolled_back_at * 1000 : job.rolled_back_at)}`].filter(Boolean);
            return h('li', { key: job.job_id, className: 'dcc-job' },
              h('strong', null, job.title || '未填写任务标题'),
              h('small', null, `${executionText[job.execution_status || job.status] || '状态待确认'}${job.needs_attention ? ' · 需要关注' : ''} · ${new Date(job.started_at * 1000).toLocaleString('zh-CN')}`),
              h('small', null, `任务编号：${job.job_id}`),
              facts.length ? h('small', null, facts.join(' · ')) : null,
              h('div', { className: 'dcc-row' },
                h(Button, { size: 'sm', onClick: () => setReportJob(job.job_id) }, '查看报告'),
                running ? h(Button, { size: 'sm', disabled: !!busy, onClick: () => setConfirmJob(job.job_id) }, '取消任务') : null,
                canRollback ? h(Button, { size: 'sm', disabled: !!busy, onClick: () => {
                  setRollback({ id: job.job_id });
                  setMessages((old) => ({ ...old, rollback: '' })); setErrors((old) => ({ ...old, rollback: '' }));
                } }, '回滚这单的改动') : null),
              canRollback && rollback?.id === job.job_id ? h('div', { className: 'dcc-confirm' },
                h('p', null, '只撤销这一单在任务目录里的文件改动，不动提交记录。这些文件在任务之后又被改过时不会回滚，也不会改动任何文件。'),
                rollback.checked ? h('p', null, `检查通过${rollback.files != null ? `，可以回滚 ${rollback.files} 个文件` : ''}。确定现在回滚吗？`) : null,
                h('div', { className: 'dcc-row' },
                  rollback.checked
                    ? h(Button, { size: 'sm', variant: 'outline', disabled: !!busy,
                      onClick: () => mutate('rollback', '/rollback', { job_id: job.job_id, confirm: true }, (value) => {
                        setRollback(null);
                        setMessages((old) => ({ ...old, rollback: value.rolled_back ? '已回滚这一单的改动，正在刷新列表。'
                          : '回滚请求已返回，但没有确认已回滚，请查看刷新后的任务列表。' }));
                      }) }, busy === 'rollback' ? '正在回滚…' : '确认回滚')
                    : h(Button, { size: 'sm', variant: 'outline', disabled: !!busy,
                      onClick: () => mutate('rollback', '/rollback', { job_id: job.job_id, confirm: true, check: true },
                        (value) => setRollback({ id: job.job_id, checked: true, files: value.files })) },
                    busy === 'rollback' ? '正在检查…' : '检查能否回滚'),
                  h(Button, { size: 'sm', disabled: !!busy, onClick: () => setRollback(null) }, '先不回滚'))) : null,
              confirmJob === job.job_id && running ? h('div', { className: 'dcc-confirm' },
                h('p', null, '确定停止这个任务吗？已经产生的文件改动会保留。'),
                h('div', { className: 'dcc-row' },
                  h(Button, { size: 'sm', variant: 'outline', disabled: !!busy,
                    onClick: () => mutate('cancel', '/cancel', { job_id: job.job_id, confirm: true }, (value) => {
                      setConfirmJob(null);
                      const state = value.execution_status || value.status;
                      if (state === 'failed') { setErrors((old) => ({ ...old, cancel: '取消失败，请查看任务状态后重试。' })); return; }
                      setMessages((old) => ({ ...old, cancel: state === 'cancelled' ? '任务已取消，正在刷新列表。'
                        : state === 'completed' ? '任务已经结束，正在刷新列表。' : '取消请求已返回，请查看刷新后的任务状态。' }));
                    }) }, busy === 'cancel' ? '正在取消…' : '确认停止这个任务'),
                  h(Button, { size: 'sm', disabled: !!busy, onClick: () => setConfirmJob(null) }, '继续执行'))) : null);
          })),
          h('div', { className: 'dcc-row', role: 'group', 'aria-label': '任务分页' },
            h(Button, { size: 'sm', disabled: !!busy || jobOffsets.length === 1,
              onClick: () => selectJobPage(jobOffsets.slice(0, -1)) }, '上一页'),
            h(Button, { size: 'sm', disabled: !!busy || !(jobs?.next_offset > jobOffset),
              onClick: () => selectJobPage([...jobOffsets, jobs.next_offset]) }, '下一页')),
          h(Message, { text: messages.cancel }), h(Message, { text: errors.cancel, error: true }),
          h(Message, { text: messages.rollback }), h(Message, { text: errors.rollback, error: true }),
          reportJob ? h(Report, { key: reportJob, jobId: reportJob, refreshKey: jobs,
            onClose: () => setReportJob(null), selftest }) : null),

        settings?.gemini ? h('section', { 'aria-label': 'Gemini 写作记录' }, h('h3', null, 'Gemini 写作记录'),
          h(Message, { text: errors.gemini, error: true }),
          !gemini ? h('p', null, errors.gemini ? '暂时读不到写作记录。' : '正在读取写作记录…') : !gemini.length ? h('p', null, '还没有写作记录。')
            : h('ul', { className: 'dcc-jobs' }, ...gemini.map((entry, i) => h('li', { key: i, className: 'dcc-job' },
              h('strong', null, entry.output || '未记录目标文件'),
              h('small', null, [entry.status === 'completed' ? '成功' : '失败', entry.at && when(entry.at),
                entry.chars != null && `${entry.chars} 字`, entry.background && '后台'].filter(Boolean).join(' · ')),
              entry.error ? h('p', { className: 'dcc-error' }, `失败原因：${entry.error}`) : null,
              entry.draft_path ? h('small', null, `草稿：${entry.draft_path}`) : null)))) : null,

        promptSection('planner', '规划提示词', '填写给 DeepSeek 的要求，例如怎样安排任务、判断做完没有。自动刷新不会覆盖正在编辑的草稿。',
          '给 DeepSeek 的具体要求', '这段内容每个会话每一步都会带上，超过 4000 字会明显占用上下文，建议精简。'),
        selftest ? null : promptSection('executor', '给 Codex 的固定要求', '这里的内容会附在每一单交给 Codex 的任务书后面，Codex 每单都会看到；不增加权限。',
          '附在每一单任务书后面的内容', '这段内容每一单任务书都会带上，超过 4000 字建议精简。'),

        selftest ? null : (() => {
          const handover = status?.handover;
          const submitted = () => { setConfirmSession(null); setMessages((old) => ({ ...old, handover: '交接请求已提交，几秒后在下面的“最近结果”查看。' })); };
          const answer = (sessionId, accept) => mutate('handover', '/handover/answer', { sessionId, accept }, (value) => setMessages((old) => ({ ...old, handover: value.declined
            ? '已记下，冷却期内不再询问。' : '已同意：会话停在两个回合之间时自动交接（目标循环会先暂停，交接没成会恢复）。' })));
          const result = handover?.result;
          return h('section', { 'aria-label': '会话交接' }, h('h3', null, '会话交接'),
            h('p', { className: 'dcc-muted' }, '交接把目标和 Codex 任务转到一个新会话，原会话只读保留。提交后由插件在几秒内处理；有回合或 Codex 任务在跑时会被拒绝。'),
            !handover ? h('p', null, errors.status ? '暂时读不到交接状态。' : '正在读取交接状态…') : h('div', null,
              h('small', null, `自动交接：${HANDOVER_MODES[handover.mode] || handover.mode}`),
              handover.prompts.length ? h('ul', { className: 'dcc-jobs', 'aria-label': '需要处理的交接提醒' }, ...handover.prompts.map((prompt) =>
                h('li', { key: prompt.sessionId, className: 'dcc-job' },
                  h('strong', null, `会话 ${prompt.sessionId} 已有 ${prompt.messages} 条消息，${prompt.kind === 'ask' ? '建议现在交接到新会话' : '可以交接到新会话'}`),
                  h('small', null, QUEUED_HINT),
                  h('div', { className: 'dcc-row' },
                    h(Button, { size: 'sm', disabled: !!busy, onClick: () => answer(prompt.sessionId, true) }, prompt.kind === 'ask' ? '同意交接' : '现在交接'),
                    h(Button, { size: 'sm', variant: 'outline', disabled: !!busy, onClick: () => answer(prompt.sessionId, false) }, prompt.kind === 'ask' ? '暂不交接' : '知道了'))))) : null,
              h('h4', null, '建议交接的会话'),
              handover.suggestions.length ? h('ul', { className: 'dcc-jobs', 'aria-label': '建议交接的会话' }, ...handover.suggestions.map((item) =>
                h('li', { key: item.sessionId, className: 'dcc-job' },
                  h('strong', null, item.sessionId), h('small', null, `${item.cwd || '工作目录未知'} · ${item.messages} 条消息`),
                  item.blocked ? h('small', { className: 'dcc-warn' }, item.blocked) : null,
                  h(Button, { size: 'sm', disabled: !!busy, onClick: () => setConfirmSession(`handover:${item.sessionId}`) }, '交接到新会话'),
                  confirmSession === `handover:${item.sessionId}` ? h('div', { className: 'dcc-confirm' },
                    h('label', { className: 'dcc-field' }, h('span', null, '给新会话的下一步（可空）'),
                      h(Input, { value: session.handoverNote || '', disabled: !!busy, maxLength: 4000,
                        onChange: (event) => setSession((old) => ({ ...old, handoverNote: event.target.value })) })),
                    h('p', null, '确定交接吗？插件会新建会话、发去交接单，并暂停这个会话的目标；之后这个会话只能查看。'),
                    h('p', null, QUEUED_HINT),
                    h('div', { className: 'dcc-row' },
                      h(Button, { size: 'sm', variant: 'outline', disabled: !!busy, onClick: () => mutate('handover', '/handover/request',
                        { sessionId: item.sessionId, ...((session.handoverNote || '').trim() ? { note: session.handoverNote } : {}) }, submitted) }, '确认交接'),
                      h(Button, { size: 'sm', disabled: !!busy, onClick: () => setConfirmSession(null) }, '先不交接'))) : null))) : h('p', null, '暂无。'),
              h('h4', null, '当前交接'),
              handover.links.length ? h('ul', { className: 'dcc-jobs', 'aria-label': '当前交接' }, ...handover.links.map((link) => {
                const blocked = result?.reason === 'successor_active' && result.from === link.from && result.to === link.to;
                const revert = (force) => mutate('handover', '/handover/request', { revert: { from: link.from, to: link.to }, ...(force ? { force: true } : {}) }, submitted);
                return h('li', { key: link.to, className: 'dcc-job' },
                  h('strong', null, `${link.from} → ${link.to}`),
                  h('small', null, `${link.at ? when(link.at) : '时间未知'} · ${ORIGIN_TEXT[link.origin] || '来源未记录'}${link.workspace ? ` · 分组 ${link.workspace}` : ''}`),
                  h(Button, { size: 'sm', disabled: !!busy, onClick: () => setConfirmSession(`revert:${link.to}`) }, '撤回'),
                  confirmSession === `revert:${link.to}` ? h('div', { className: 'dcc-confirm' },
                    h('p', null, '确定撤回吗？原会话恢复派活和目标，继任会话的目标暂停。继任会话已经开工时插件会拒绝，并在这里说明。'),
                    h('div', { className: 'dcc-row' },
                      h(Button, { size: 'sm', variant: 'outline', disabled: !!busy, onClick: () => revert(false) }, '确认撤回'),
                      h(Button, { size: 'sm', disabled: !!busy, onClick: () => setConfirmSession(null) }, '先不撤回'))) : null,
                  blocked ? h('div', { className: 'dcc-confirm' },
                    h('p', { className: 'dcc-warn' }, `${handoverReason(result)}仍要撤回的话，请确认之后只保留一个会话继续工作。`),
                    h(Button, { size: 'sm', variant: 'outline', disabled: !!busy, onClick: () => revert(true) }, '仍然撤回（两个会话会并行）')) : null);
              })) : h('p', null, '暂无。'),
              h(Message, { text: messages.handover }), h(Message, { text: errors.handover, error: true }),
              h('p', { className: ['handed_over_with_issues', 'rolled_back'].includes(result?.status) ? 'dcc-warn' : undefined },
                h('strong', null, '最近结果：'), handoverResultText(result)),
              result?.checks ? h('ul', { className: 'dcc-jobs', 'aria-label': '交接自检' }, ...Object.entries(result.checks).map(([key, value]) =>
                h('li', { key, className: value.startsWith('failed') ? 'dcc-warn' : 'dcc-muted' },
                  `${CHECK_TEXT[key] || key}：${value === 'ok' ? '通过' : value.startsWith('skipped') ? `跳过（${value.slice(8)}）` : `有问题（${value.slice(7)}）`}`))) : null,
              result?.rollback && result.status !== 'rolled_back' ? h('p', { className: 'dcc-warn' },
                `自动撤回没有成功（${result.rollback.refused || result.rollback.status}），请在“当前交接”里手动处理。`) : null,
              handover.recent.length ? h('details', null, h('summary', null, '最近的交接记录'),
                h('ul', { className: 'dcc-jobs', 'aria-label': '最近的交接记录' }, ...handover.recent.slice().reverse().map((entry, index) =>
                  h('li', { key: `${entry.at}-${index}` }, `${entry.at ? when(entry.at) : '时间未知'} · ${{ handover: '交接', adopt: '认领', revert: '撤回' }[entry.action] || entry.action}` +
                    ` · ${entry.from || '?'} → ${entry.to || '?'} · ${ORIGIN_TEXT[entry.origin] || entry.origin} · ${entry.status}${entry.reason ? ` / ${entry.reason}` : ''}${entry.workspace ? ` · 分组 ${entry.workspace}` : ''}`)))) : null));
        })(),

        !selftest && status?.autoAnswer ? (() => {
          const { enabled, available, afterMinutes, pending, recent } = status.autoAnswer;
          const act = (id, action) => mutate('autoAnswer', '/auto-answer/action', { id, action }, (value) => {
            setStatus((old) => ({ ...old, autoAnswer: value.autoAnswer }));
            setMessages((old) => ({ ...old, autoAnswer: action === 'answer' ? '已按推荐提交回答。' : '已取消这条提问的自动代答。' }));
          });
          const reasons = { risky: '高风险', excluded: '已排除', manual: '已选择自己回答', failed: '宿主提交失败' };
          const decisions = { marked_recommended: '有推荐标记', first_option: '首项', free_text: '自由文本',
            skipped_risky: '跳过高风险', skipped_excluded: '跳过已排除提问' };
          return h('section', { 'aria-label': '自动代答' }, h('h3', null, '自动代答'),
            h('small', null, [enabled ? '已开启' : '已关闭', `${afterMinutes} 分钟`, enabled && !available ? '宿主提问服务不可用' : ''].filter(Boolean).join(' · ')),
            available && !pending.length ? h('p', null, '当前没有待答提问。') : null,
            pending.length ? h('ul', { className: 'dcc-jobs', 'aria-label': '待答提问' }, ...pending.map((item) =>
              h('li', { key: item.id, className: 'dcc-job' },
                h('strong', null, item.sessionId), ...item.questions.map((question, i) => h('div', { key: i }, question)),
                h('small', null, `已等 ${item.waitedMinutes} 分钟 · ${item.reason
                  ? '需要你亲自回答（' + reasons[item.reason] + '）' : '还有 ' + item.remainingMinutes + ' 分钟自动代答'}`),
                !item.reason ? h('div', { className: 'dcc-row' },
                  h(Button, { size: 'sm', disabled: !!busy, onClick: () => act(item.id, 'answer') }, '现在就按推荐回答'),
                  h(Button, { size: 'sm', variant: 'outline', disabled: !!busy, onClick: () => act(item.id, 'manual') }, '这条我自己答')) : null))) : null,
            h(Message, { text: messages.autoAnswer }), h(Message, { text: errors.autoAnswer, error: true }),
            recent.length ? h('details', null, h('summary', null, '最近的代答记录'),
              h('ul', { className: 'dcc-jobs' }, ...recent.map((entry, i) =>
                h('li', { key: i }, [when(entry.at), entry.sessionId, entry.question, entry.selected.join('、'),
                  decisions[entry.reason], `等待 ${entry.waitedMinutes} 分钟`].filter(Boolean).join(' · '))))) : null);
        })() : null,

        selftest ? null : h('section', { 'aria-label': '会话操作' },
          h('details', null, h('summary', null, h('h3', { style: { display: 'inline' } }, '会话操作')),
            h('p', { className: 'dcc-muted' }, '通过本机请求文件交给插件处理；提交后不会立刻有结果，请用“查看最近结果”确认。'),
            h('div', { className: 'dcc-grid' },
              h('div', null,
                sessionField('sendId', '发送到的会话编号', { maxLength: 100 }),
                sessionField('sendMessage', '要发送的消息', { className: 'dcc-short', maxLength: 4000 }, 'textarea'),
                h(Checkbox, { label: '会话正在运行时排到它的下一轮', checked: session.sendQueue === true, disabled: !!busy,
                  onChange: (value) => { setConfirmSession(null); setSession((old) => ({ ...old, sendQueue: value })); } }),
                h('div', { className: 'dcc-actions' }, h(Button, { size: 'sm', disabled: !!busy || !session.sendId || !(session.sendMessage || '').trim(),
                  onClick: () => setConfirmSession('send') }, '向会话发送消息')),
                confirmSession === 'send' ? h('div', { className: 'dcc-confirm' },
                  h('p', null, '确定发送吗？这会以用户身份向该会话提交这条消息，会话会照这条消息继续工作。'),
                  h('div', { className: 'dcc-row' },
                    h(Button, { size: 'sm', variant: 'outline', disabled: !!busy, onClick: () => sessionSubmit('sessionSend', '/session/send',
                      { sessionId: session.sendId, message: session.sendMessage, ...(session.sendQueue ? { queue: true } : {}) }) }, '确认发送'),
                    h(Button, { size: 'sm', disabled: !!busy, onClick: () => setConfirmSession(null) }, '先不发送'))) : null,
                h(Message, { text: messages.sessionSend }), h(Message, { text: errors.sessionSend, error: true })),
              h('div', null,
                sessionField('resumeIds', '要续接的会话编号', { placeholder: '多个用空格或逗号分隔，最多 20 个' }),
                sessionField('resumeMessage', '续接时发送的话', { placeholder: '留空用“继续”', maxLength: 2000 }),
                h('div', { className: 'dcc-actions' }, h(Button, { size: 'sm', disabled: !!busy || !sessionIds.length,
                  onClick: () => setConfirmSession('resume') }, '续接被中断的会话')),
                confirmSession === 'resume' ? h('div', { className: 'dcc-confirm' },
                  h('p', null, '确定续接吗？这会以用户身份让这些会话接着做，被中断的会话会收到上面这句话。'),
                  h('div', { className: 'dcc-row' },
                    h(Button, { size: 'sm', variant: 'outline', disabled: !!busy, onClick: () => sessionSubmit('sessionResume', '/session/resume',
                      { sessions: sessionIds, ...(session.resumeMessage ? { message: session.resumeMessage } : {}) }) }, '确认续接'),
                    h(Button, { size: 'sm', disabled: !!busy, onClick: () => setConfirmSession(null) }, '先不续接'))) : null,
                h('small', null, '只处理被中断或被拒绝后停下的会话，正常结束的会话会跳过。'),
                h(Message, { text: messages.sessionResume }), h(Message, { text: errors.sessionResume, error: true })),
              h('div', null,
                sessionField('goalId', '要改 Goal 的会话编号', { maxLength: 100 }),
                sessionField('goalObjective', '新的目标', { className: 'dcc-short', placeholder: '留空表示不改目标' }, 'textarea'),
                sessionField('goalRounds', '新的轮数上限', { type: 'number', min: 1, step: 1, placeholder: '留空表示不改' }),
                h('div', { className: 'dcc-actions' }, h(Button, { size: 'sm',
                  disabled: !!busy || !session.goalId || (!(session.goalObjective || '').trim() && !session.goalRounds),
                  onClick: () => setConfirmSession('goal') }, '修改会话 Goal')),
                confirmSession === 'goal' ? h('div', { className: 'dcc-confirm' },
                  h('p', null, '确定修改吗？这会以用户身份改写该会话当前 Goal 的目标或轮数上限。'),
                  h('div', { className: 'dcc-row' },
                    h(Button, { size: 'sm', variant: 'outline', disabled: !!busy, onClick: () => sessionSubmit('sessionGoal', '/session/goal',
                      { sessionId: session.goalId, ...((session.goalObjective || '').trim() ? { objective: session.goalObjective } : {}),
                        ...(session.goalRounds ? { maxGoalRounds: Number(session.goalRounds) } : {}) }) }, '确认修改'),
                    h(Button, { size: 'sm', disabled: !!busy, onClick: () => setConfirmSession(null) }, '先不修改'))) : null,
                h(Message, { text: messages.sessionGoal }), h(Message, { text: errors.sessionGoal, error: true }))),
            h('div', { className: 'dcc-actions' },
              h(Button, { size: 'sm', onClick: () => fetchOnce('sessionResults', '/session/results', setSessionResults) }, '查看最近结果'),
              h(Message, { text: messages.sessionResults }), h(Message, { text: errors.sessionResults, error: true }),
              sessionResults ? h('pre', { className: 'dcc-report', 'aria-label': '最近的会话操作结果' },
                [['发送消息', 'send'], ['续接会话', 'resume'], ['修改 Goal', 'goal'], ['重启后自动续接', 'autoresume']]
                  .flatMap(([label, key]) => resultLines(label, sessionResults[key])).join('\n')) : null))));
    }

    function collectSelftest(node, http, errors, timedOut) {
      const headings = Array.from(node.querySelectorAll('h3'), (item) => item.textContent);
      const rows = Array.from(node.querySelectorAll('.dcc-status'));
      const value = (label) => {
        const row = rows.find((item) => item.querySelector('strong')?.textContent === `${label}：`);
        return row ? row.firstElementChild.textContent.slice(label.length + 1).slice(0, 256) : null;
      };
      const report = node.querySelector('.dcc-readable');
      const titles = Array.from(report?.querySelectorAll('h4') || [], (item) => item.textContent);
      return {
        settingsRegistered: true,
        sections: Object.fromEntries(['运行状态', '常用设置', '最近任务', '规划提示词'].map((title) => [title, headings.includes(title)])),
        status: { version: value('正在运行的版本'), model: value('当前模型'), effort: value('思考程度'), serviceTier: value('速度档') },
        taskCount: node.querySelectorAll('.dcc-job').length,
        report: { opened: !!node.querySelector('[data-dcc-report]'), summary: titles.includes('概述'),
          criteria: titles.some((title) => title.startsWith('逐条验收')),
          ...(node.querySelector('[data-dcc-report-pending]') ? { note: '报告尚未生成（任务运行中）' } : {}),
          firstCriterion: Array.from(report?.querySelector('ol > li')?.textContent || '').slice(0, 80).join('') },
        http,
        errors: [...new Set([...errors, ...Array.from(node.querySelectorAll('.dcc-error'), (item) => item.textContent)])]
          .slice(0, 40).map((text) => Array.from(text).slice(0, 1000).join('')),
        userAgent: navigator.userAgent, origin: location.origin, timedOut,
      };
    }

    async function runSelftest(request, signal, http = []) {
      const node = document.createElement('div');
      node.setAttribute('aria-hidden', 'true');
      node.inert = true;
      node.style.cssText = 'position:fixed;left:-100000px;top:0;width:960px;visibility:hidden;pointer-events:none';
      const errors = [];
      let root, timedOut = false, finish;
      const finished = new Promise((resolve) => { finish = resolve; });
      const capture = (error) => errors.push(String(error?.message ?? error));
      const onError = (event) => capture(event.error ?? event.reason ?? event.message);
      const timeout = setTimeout(() => { timedOut = true; capture('面板自检超过 30 秒。'); finish(); }, 30000);
      signal.addEventListener('abort', finish, { once: true });
      window.addEventListener('error', onError);
      window.addEventListener('unhandledrejection', onError);
      document.body.appendChild(node);
      let result;
      try {
        const { createRoot } = require('react-dom/client');
        class Boundary extends React.Component {
          constructor(props) { super(props); this.state = { failed: false }; }
          static getDerivedStateFromError() { return { failed: true }; }
          componentDidCatch(error) { capture(error); finish(); }
          render() { return this.state.failed ? null : this.props.children; }
        }
        const selftest = { finish, read: (path, readSignal) => api(path, readSignal, undefined, http) };
        root = createRoot(node);
        root.render(h(Boundary, null, h(Panel, { selftest })));
        await finished;
      } catch (error) { capture(error); }
      finally {
        clearTimeout(timeout);
        signal.removeEventListener('abort', finish);
        try { result = collectSelftest(node, http, errors, timedOut); }
        finally {
          try { root?.unmount(); } catch (error) {
            if (result?.errors.length < 40) result.errors.push(Array.from(String(error?.message ?? error)).slice(0, 1000).join(''));
          }
          node.remove();
          window.removeEventListener('error', onError);
          window.removeEventListener('unhandledrejection', onError);
        }
      }
      if (!signal.aborted) await api('/selftest/result', signal, { ...request, result });
      return result;
    }

    function startSelftests() {
      if (typeof document === 'undefined') return () => {};
      const controller = new AbortController();
      let timer;
      async function check() {
        const http = [];
        try {
          const { request } = await api('/selftest/request', controller.signal, undefined, http);
          if (request && !controller.signal.aborted) await runSelftest(request, controller.signal, http);
        } catch (_) { /* A failed probe must not affect the settings entry. */ }
        if (!controller.signal.aborted) timer = setTimeout(check, 60000);
      }
      check();
      return () => { controller.abort(); clearTimeout(timer); };
    }

    function apply(ctx) {
      ctx.inject(['slots'], (ctx) => {
        const slots = ctx.get('slots');
        return slots.inject('settings.section', () => {
          const unregister = slots.register({
            name: 'settings.section', id: 'dsh-codex-conductor', order: 80, label: () => 'Codex 指挥',
          }, Panel);
          const stop = startSelftests();
          return () => { stop(); unregister(); };
        });
      });
    }

    return { apply, Panel, Status, ReadableReport, Report, parseReport, loadReport, settingsPatch, pendingPatch, REPORT_LIMIT,
      collectSelftest, runSelftest, startSelftests };
  },
});
