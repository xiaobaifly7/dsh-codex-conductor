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
      if (typeof value !== 'string' || !/[\u3400-\u9fff]/.test(value) || /[A-Za-z_]/.test(value.replace(/\b(?:Codex|DSH|DeepSeek|Gemini)\b/g, ''))) return fallback;
      return /请|重试|重新|检查|联系/.test(value) ? value : `${value}。请刷新后重试；仍然失败请联系维护者。`;
    }

    function pendingError(value) {
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

    const reportPath = (jobId, offset) => `/output?job_id=${encodeURIComponent(jobId)}&offset=${offset}&limit=8000`;
    async function loadReport(jobId, signal, read = api) {
      const pages = [];
      let offset = 0, length = 0;
      while (true) {
        const page = await read(reportPath(jobId, offset), signal);
        pages.push({ ...page, offset });
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

    const fieldValue = (settings, key) => key.startsWith('gemini.')
      ? settings.gemini?.[key.slice(7)] : settings[key];
    const displayValue = (value) => value == null ? '' : String(value);

    function settingsPatch(settings, edits) {
      const patch = {};
      for (const [key, raw] of Object.entries(edits)) {
        const old = fieldValue(settings, key);
        if (displayValue(raw) === displayValue(old)) continue;
        let value = raw;
        if (key === 'model' || key === 'gemini.model') {
          if (!/^[A-Za-z0-9._/:-]{1,80}$/.test(value)) throw new Error('模型名请填 1 到 80 个字母、数字或 . _ / : -。');
        } else if (['effort', 'readOnlyEffort', 'gemini.effort'].includes(key)) {
          const allowed = key === 'gemini.effort' ? ['low', 'medium', 'high']
            : key === 'readOnlyEffort' ? ['', ...EFFORTS.map(([v]) => v)] : EFFORTS.map(([v]) => v);
          if (!allowed.includes(value)) throw new Error('请从列表中选择思考程度。');
        } else if (key === 'serviceTier') {
          if (!['', 'fast', 'ultrafast'].includes(value)) throw new Error('请从列表中选择服务速度。');
        } else if (key === 'lockTimeoutSeconds' || key === 'maxStorageMb') {
          value = Number(raw);
          if (String(raw).trim() === '' || !Number.isFinite(value) || value <= 0) throw new Error('等待秒数和存储上限请填大于 0 的有限数字。');
          if (value === old) continue;
        }
        if (key.startsWith('gemini.')) {
          if (settings.gemini) (patch.gemini ||= {})[key.slice(7)] = value;
        } else patch[key] = value;
      }
      return patch;
    }

    function mergeSettings(settings, changes = {}) {
      return { ...settings, ...changes, ...(changes.gemini ? { gemini: { ...settings?.gemini, ...changes.gemini } } : {}) };
    }

    function pendingPatch(settings, pending, edits) {
      const changes = pending?.changes || {};
      const values = Object.fromEntries(Object.entries(changes).filter(([key]) => key !== 'gemini'));
      for (const [key, value] of Object.entries(changes.gemini || {})) values[`gemini.${key}`] = value;
      return settingsPatch(settings, { ...values, ...edits });
    }

    function Message({ text, error = false }) {
      return text ? h('p', { className: error ? 'dcc-error' : 'dcc-muted', role: error ? 'alert' : 'status' }, text) : null;
    }

    function Status({ status, attention, errors = {}, messages = {}, busy = '', onRefresh, onReload, onCancel }) {
      const runtime = status?.runtime;
      const pending = runtime?.pending_settings;
      const activeSettings = status?.settings;
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
          h('p', { className: 'dcc-muted' }, '每 7 秒自动查看状态和任务。未保存的输入会保留。'),
          h(Message, { text: errors.status, error: true }),
          errors.status && status ? h('small', null, '下面保留的是上次成功读取的状态。') : null,
          !status ? h('p', null, errors.status ? '暂时读不到运行状态。' : '正在读取运行状态…') : null,
          status ? h('div', null,
            statusRow('生效情况', runtimeState[0], runtimeState[1]),
            statusRow('正在运行的版本', runtime?.loaded?.version || '未读到', '这是本次运行实际使用的插件版本。'),
            statusRow('加载时间', runtime?.loaded?.loadedAt ? new Date(runtime.loaded.loadedAt).toLocaleString('zh-CN') : '未读到', '这是当前运行版本的加载时间。'),
            statusRow('已保存的版本', runtime?.source?.version || '未读到', '这是磁盘上可供下一次加载的插件版本。'),
            statusRow('当前模型', activeSettings ? activeSettings.model || '跟随 Codex 配置' : '未读到', '这是当前正在使用的模型，不包含待生效或未保存的修改。'),
            statusRow('思考程度', activeSettings ? EFFORTS.find(([value]) => value === activeSettings.effort)?.[1] || activeSettings.effort || '跟随 Codex 配置' : '未读到', '控制 Codex 做任务时思考得多深入。'),
            statusRow('速度档', activeSettings ? activeSettings.serviceTier || '跟随 Codex 配置' : '未读到', '使用 Codex 配置或账号支持的 fast、ultrafast 档位。'),
            statusRow('自动回答 Codex 的问题', activeSettings ? activeSettings.plannerAnswers ? '已开启' : '已关闭' : '未读到', '打开后 DeepSeek 会替你回答 Codex 的问题并继续干活，不再等你'),
            statusRow('Gemini 写作', activeSettings ? activeSettings.gemini ? '已开启' : '未开启' : '未读到', '已配置时，可以让 Gemini 写教程和文档。'),
            statusRow('正在执行的任务', runtime?.active_tasks ?? '未读到', '保存设置时，可等这些任务结束后自动生效。'),
            statusRow('最近 24 小时内需要关注的任务', attention ?? (errors.attention ? '未读到' : '正在读取…'), '只统计最近 24 小时内开始、需要你查看的任务。'),
            h(Message, { text: errors.attention, error: true }),
            statusRow('重新加载', runtime?.can_reload ? '现在可以操作' : '暂时不能操作', '只有服务确认可以加载时，下面的按钮才可用。'),
            statusRow('设置读取', runtime?.profile_error ? '无法读取已保存的设置，请联系维护者检查设置文件后刷新。' : '未发现错误', '读取已保存设置遇到的问题会显示在这里。'),
            statusRow('运行版本读取', runtime?.loaded_error ? '无法读取当前运行版本，请刷新；仍然失败请联系维护者。' : '未发现错误', '读取当前运行版本遇到的问题会显示在这里。'),
            runtime?.active_error ? h(Message, { error: true, text: '无法确认正在执行的任务数量，请刷新后重试；仍然失败请联系维护者。' }) : null) : null,
          pending ? h('div', { className: 'dcc-status' },
            h(Message, { text: pending.awaiting_load ? '设置已写入，等待加载生效。' : pending.error ? '设置已保存，但未能生效。' : runtime.active_tasks == null
              ? '设置已保存，确认当前任务结束后自动生效。' : `已保存，等 ${runtime.active_tasks} 个 Codex 任务结束后自动生效` }),
            h('small', null, pending.awaiting_load ? '设置已经写入，不能再撤销。请刷新运行状态确认是否生效。' : '待生效修改尚未用于当前任务。可以继续修改设置后保存，也可以撤销。'),
            pending.error ? h(Message, { error: true, text: `待生效设置未能生效：${pendingError(pending.error)} ${pending.awaiting_load ? '请刷新状态，仍未生效请联系维护者。' : '可修改设置后重新保存，或撤销这次修改。'}` }) : null,
            !pending.awaiting_load ? h(Button, { size: 'sm', disabled: !!busy, onClick: onCancel }, '撤销这次修改') : null) : null,
          h(Button, { variant: 'outline', disabled: !!busy || !!errors.status || !runtime?.can_reload,
            onClick: onReload }, busy === 'reload' ? '正在重新加载…' : '重新加载插件（等任务结束）'),
          h(Message, { text: messages.reload }), h(Message, { text: errors.reload, error: true }));
    }

    function Report({ jobId, onClose, selftest }) {
      const [document, setDocument] = useState(null);
      const [pageIndex, setPageIndex] = useState(0);
      const [raw, setRaw] = useState(false);
      const [error, setError] = useState('');
      const [loading, setLoading] = useState(true);
      const [revision, setRevision] = useState(0);
      const life = useRef(null);
      const page = document?.pages[pageIndex];
      useEffect(() => {
        const controller = new AbortController();
        life.current = controller;
        setLoading(true);
        setError('');
        setDocument(null);
        setPageIndex(0);
        loadReport(jobId, controller.signal, selftest?.read || api)
          .then((value) => { if (!controller.signal.aborted) setDocument(value); })
          .catch((err) => { if (!controller.signal.aborted) setError(userError(err.message)); })
          .finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
      }, [jobId, revision]);
      useEffect(() => { if (!loading) selftest?.finish(); }, [loading, selftest]);
      async function nextPage() {
        if (document.pages[pageIndex + 1]) { setPageIndex(pageIndex + 1); return; }
        const controller = life.current;
        setLoading(true);
        setError('');
        try {
          const next = await api(reportPath(jobId, page.next_offset), controller.signal);
          if (!controller.signal.aborted) {
            setDocument((old) => ({ ...old, pages: [...old.pages, { ...next, offset: page.next_offset }] }));
            setPageIndex(pageIndex + 1);
          }
        } catch (err) { if (!controller.signal.aborted) setError(userError(err.message)); }
        finally { if (!controller.signal.aborted) setLoading(false); }
      }
      const readable = document?.report && !raw;
      return h('div', { className: 'dcc-actions', 'data-dcc-report': jobId },
        h('div', { className: 'dcc-row' },
          h('strong', null, readable ? '任务报告' : `任务报告 · 第 ${pageIndex + 1} 页`),
          document?.report ? h(Button, { size: 'sm', onClick: () => setRaw((value) => !value) }, raw ? '查看易读报告' : '查看原文') : null,
          h(Button, { size: 'sm', onClick: onClose }, '收起报告')),
        h('small', null, `任务编号：${jobId}。${readable ? '已读完报告。' : '原文每页最多 8000 字符，可翻页查看。'}`),
        document?.tooLarge ? h('small', null, '报告超过 262144 字符，仅提供原文分页。') : null,
        document && !document.report && !document.tooLarge ? h('small', null, '这份报告不支持易读视图，以下显示原文。') : null,
        h(Message, { text: error, error: true }),
        loading ? h('p', { role: 'status' }, '正在读取报告…') : null,
        readable ? h(ReadableReport, { report: document.report, acceptance: document.pages[0].acceptance }) : page ? h('pre', { className: 'dcc-report', tabIndex: 0, 'aria-label': '本页报告全文' }, page.text || '这一页还没有输出。') : null,
        h('div', { className: 'dcc-row' },
          !readable ? h(Button, { size: 'sm', disabled: loading || pageIndex === 0, onClick: () => setPageIndex((v) => v - 1) }, '上一页') : null,
          !readable ? h(Button, { size: 'sm', disabled: loading || !page || page.eof || !(page.next_offset > page.offset), onClick: nextPage }, '下一页') : null,
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
      const [prompt, setPrompt] = useState(null);
      const [promptDraft, setPromptDraft] = useState(null);
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
        let timer;
        async function refresh() {
          if (!mutation.current) {
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
            const reads = [
              read('status', '/status', setStatus),
              read('settings', '/settings', setSettings),
              read('jobs', `/jobs?filter=${filter}&offset=${jobOffset}`, setJobs),
              read('prompt', '/prompt', (value) => setPrompt(value.text)),
              read('attention', '/attention', (value) => setAttention(value.total)),
            ];
            await Promise.all(reads);
          }
          if (!controller.signal.aborted && !selftest) timer = setTimeout(refresh, 7000);
        }
        refresh();
        return () => { controller.abort(); clearTimeout(timer); };
      }, [filter, revision, jobOffset]);

      useEffect(() => {
        if (!selftest || !['status', 'settings', 'jobs', 'prompt', 'attention'].every((key) => Object.hasOwn(errors, key))) return;
        if (jobs?.jobs.length) setReportJob(jobs.jobs[0].job_id);
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
            if (err.saved && key === 'promptSave') { setPrompt(body.text); setPromptDraft(null); }
            setErrors((old) => ({ ...old, [key]: err.saved
              ? `内容已保存，但后续处理没有完成：${userError(err.message)} 请查看运行状态，草稿已保留。`
              : userError(err.message) }));
          }
        } finally {
          mutation.current = false;
          if (!controller.signal.aborted) { setBusy(''); setRevision((v) => v + 1); }
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
        const text = waiting ? `已保存，等 ${result.active_tasks} 个 Codex 任务结束后自动生效`
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
          setStatus((old) => ({ ...old, runtime: { ...old?.runtime, pending_settings: null } }));
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
            type: key === 'lockTimeoutSeconds' || key === 'maxStorageMb' ? 'number' : 'text',
            ...(['lockTimeoutSeconds', 'maxStorageMb'].includes(key) ? { min: 0, step: 'any' } : { maxLength: 80, spellCheck: false }),
            onChange: (event) => edit(key, event.target.value) });
        return h('label', { className: 'dcc-field', key }, h('span', null, label), control, h('small', null, hint));
      }
      const executionText = { running: '运行中', completed: '已结束', failed: '执行失败', cancelled: '已取消', unknown: '状态待确认' };
      const pageJobs = jobs?.jobs ?? [];
      const promptValue = promptDraft === null ? prompt ?? '' : promptDraft;
      const promptDirty = prompt !== null && promptValue !== prompt;

      return h('div', { className: 'dcc-panel' },
        h('style', null, CSS),
        h(Status, { status, attention, errors, messages, busy, onRefresh: () => setRevision((v) => v + 1),
          onCancel: () => cancelPending(), onReload: () => mutate('reload', '/reload', {}, (value) => {
            const text = { reloaded: '已重新加载，正在刷新运行状态。', already_current: '当前已经是已保存的版本。',
              unconfirmed: '已请求加载，但还没有确认生效，请刷新运行状态查看。',
              waiting_for_idle: '已安排，任务结束后自动重新加载。', failed: '重新加载失败，请刷新运行状态后重试。'
            }[value.status] || '服务没有确认加载结果，请刷新运行状态查看。';
            if (value.status === 'failed') setErrors((old) => ({ ...old, reload: text }));
            else setMessages((old) => ({ ...old, reload: text }));
          }) }),

        h('section', { 'aria-label': '常用设置' }, h('h3', null, '常用设置'),
          h(Message, { text: errors.settings, error: true }),
          settings ? h('div', null,
            h('div', { className: 'dcc-grid' },
              field('model', 'Codex 模型', '填写要使用的模型名。'),
              field('effort', '执行时的思考程度', '越高通常想得越久，也可能花更多时间。', EFFORTS),
              field('readOnlyEffort', '只读任务的思考程度', '用于查看代码、分析和复核。', [['', '跟随执行设置'], ...EFFORTS]),
              field('serviceTier', '速度档', '跟随 Codex 配置，或使用账号支持的加速档位。', [['', '跟随 Codex 配置'], ['fast', 'fast'], ['ultrafast', 'ultrafast']]),
              field('lockTimeoutSeconds', '等待其他任务的秒数', '要修改同一目录时，最多等其他任务多久；未设置时可留空。'),
              field('maxStorageMb', '任务记录占用空间上限（MiB）', '超过上限时会清理最旧的已结束任务记录；未设置时可留空。'),
              settings.gemini ? field('gemini.model', 'Gemini 模型', '只影响已经配置好的 Gemini 写作功能。') : null,
              settings.gemini ? field('gemini.effort', 'Gemini 思考程度', 'Gemini 支持低、中、高三档。', EFFORTS.slice(0, 3)) : null),
            h('div', { className: 'dcc-actions' },
              h(Checkbox, { label: '自动回答 Codex 的问题', checked: Object.hasOwn(edits, 'plannerAnswers') ? edits.plannerAnswers : editingSettings.plannerAnswers === true,
                disabled: !!busy, onChange: (value) => edit('plannerAnswers', value) }),
              h('small', null, '打开后 DeepSeek 会替你回答 Codex 的问题并继续干活，不再等你')),
            h(Message, { text: validation, error: true }),
            h('div', { className: 'dcc-row dcc-actions' },
              h(Button, { variant: 'primary', disabled: !!busy || (!dirty && !(pending?.error && !pending.awaiting_load)) || !!validation,
                onClick: () => saveSettings() }, busy === 'settingsSave' ? '正在保存设置…' : '等当前任务结束后自动生效'),
              h(Button, { disabled: !!busy || (!dirty && !pending) || !!validation || !Object.keys(patch).length,
                onClick: () => setConfirmApply(true) }, '立即生效'),
              h(Button, { disabled: !!busy || !dirty, onClick: () => { setEdits({}); setConfirmApply(false); setErrors((old) => ({ ...old, settingsSave: '' })); } }, '放弃未保存的更改'),
              dirty ? h('small', null, '有未保存的设置。') : null),
            h('small', null, '没有任务正在执行时，保存后立即生效。再次保存会替换上一次待生效修改。'),
            confirmApply ? h('div', { className: 'dcc-confirm' },
              h('p', null, '确定让这些设置立即生效吗？正在跑的 Codex 任务不会被打断，重载后会自动接回。'),
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
          h('small', null, jobs ? `第 ${jobOffsets.length} 页，共 ${jobs.total} 项，本页 ${pageJobs.length} 项。` : errors.jobs ? '暂时读不到任务。' : '正在读取任务…'),
          h(Message, { text: errors.jobs, error: true }),
          jobs && !pageJobs.length ? h('p', null, '本页没有任务。') : null,
          h('ul', { className: 'dcc-jobs' }, ...pageJobs.map((job) => {
            const running = (job.execution_status || job.status) === 'running';
            return h('li', { key: job.job_id, className: 'dcc-job' },
              h('strong', null, job.title || '未填写任务标题'),
              h('small', null, `${executionText[job.execution_status || job.status] || '状态待确认'}${job.needs_attention ? ' · 需要关注' : ''} · ${new Date(job.started_at * 1000).toLocaleString('zh-CN')}`),
              h('small', null, `任务编号：${job.job_id}`),
              h('div', { className: 'dcc-row' },
                h(Button, { size: 'sm', onClick: () => setReportJob(job.job_id) }, '查看报告'),
                running ? h(Button, { size: 'sm', disabled: !!busy, onClick: () => setConfirmJob(job.job_id) }, '取消任务') : null),
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
          reportJob ? h(Report, { key: reportJob, jobId: reportJob, onClose: () => setReportJob(null), selftest }) : null),

        h('section', { 'aria-label': '规划提示词' }, h('h3', null, '规划提示词'),
          h('p', { className: 'dcc-muted' }, '填写给 DeepSeek 的要求，例如怎样安排任务、判断做完没有。自动刷新不会覆盖正在编辑的草稿。'),
          h(Message, { text: errors.prompt, error: true }),
          h('label', { className: 'dcc-field' }, h('span', null, '给 DeepSeek 的具体要求'),
            h('textarea', { value: promptValue, disabled: prompt === null || !!busy,
              placeholder: prompt === null ? '正在读取规划提示词…' : '在这里填写规划要求，也可以留空。',
              onChange: (event) => { setPromptDraft(event.target.value); setMessages((old) => ({ ...old, promptSave: '' })); setErrors((old) => ({ ...old, promptSave: '' })); } })),
          h('div', { className: 'dcc-row dcc-actions' },
            h(Button, { variant: 'primary', disabled: !!busy || !promptDirty,
              onClick: () => mutate('promptSave', '/prompt', { text: promptValue }, () => {
                setPrompt(promptValue); setPromptDraft(null);
                setMessages((old) => ({ ...old, promptSave: '规划提示词已保存。' }));
              }) }, busy === 'promptSave' ? '正在保存提示词…' : '保存规划提示词'),
            h(Button, { disabled: !!busy || !promptDirty, onClick: () => { setPromptDraft(null); setErrors((old) => ({ ...old, promptSave: '' })); } }, '放弃提示词更改'),
            promptDirty ? h('small', null, '有未保存的提示词。') : null),
          h(Message, { text: messages.promptSave }), h(Message, { text: errors.promptSave, error: true })));
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
