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
    `;

    async function api(path, signal, body) {
      const response = await fetch(PREFIX + path, {
        credentials: 'same-origin', signal,
        ...(body === undefined ? {} : {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        }),
      });
      let value;
      try { value = await response.json(); }
      catch (_) { throw new Error('服务没有返回有效数据，请稍后重试。'); }
      if (!response.ok || value.error) {
        const error = new Error(value.error || `请求失败（${response.status}），请稍后重试。`);
        error.saved = value.saved === true;
        error.status = response.status;
        throw error;
      }
      return value;
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

    function Message({ text, error = false }) {
      return text ? h('p', { className: error ? 'dcc-error' : 'dcc-muted', role: error ? 'alert' : 'status' }, text) : null;
    }

    function Report({ jobId, onClose }) {
      const [offsets, setOffsets] = useState([0]);
      const [page, setPage] = useState(null);
      const [error, setError] = useState('');
      const [loading, setLoading] = useState(true);
      const [revision, setRevision] = useState(0);
      const offset = offsets[offsets.length - 1];
      useEffect(() => {
        const controller = new AbortController();
        setLoading(true);
        setError('');
        setPage(null);
        api(`/output?job_id=${encodeURIComponent(jobId)}&offset=${offset}&limit=8000`, controller.signal)
          .then((value) => { if (!controller.signal.aborted) setPage(value); })
          .catch((err) => { if (!controller.signal.aborted) setError(err.message); })
          .finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
      }, [jobId, offset, revision]);
      return h('div', { className: 'dcc-actions' },
        h('div', { className: 'dcc-row' },
          h('strong', null, `任务报告 · 第 ${offsets.length} 页`),
          h(Button, { size: 'sm', onClick: onClose }, '收起报告')),
        h('small', null, `任务编号：${jobId}。每页最多读取 8000 字符，可翻页查看全文。`),
        h(Message, { text: error, error: true }),
        loading ? h('p', { role: 'status' }, '正在读取报告…') : null,
        page ? h('pre', { className: 'dcc-report', tabIndex: 0, 'aria-label': '本页报告全文' }, page.text || '这一页还没有输出。') : null,
        h('div', { className: 'dcc-row' },
          h(Button, { size: 'sm', disabled: loading || offsets.length === 1, onClick: () => setOffsets((v) => v.slice(0, -1)) }, '上一页'),
          h(Button, { size: 'sm', disabled: loading || !page || page.eof || !(page.next_offset > offset), onClick: () => setOffsets((v) => [...v, page.next_offset]) }, '下一页'),
          h(Button, { size: 'sm', disabled: loading, onClick: () => setRevision((v) => v + 1) }, '刷新这一页'),
          page?.eof ? h('small', null, '已到当前输出末尾；任务运行中可刷新这一页。') : null));
    }

    function Panel() {
      const [status, setStatus] = useState(null);
      const [attention, setAttention] = useState(null);
      const [settings, setSettings] = useState(null);
      const [edits, setEdits] = useState({});
      const [jobs, setJobs] = useState(null);
      const [filter, setFilter] = useState('all');
      const [prompt, setPrompt] = useState(null);
      const [promptDraft, setPromptDraft] = useState(null);
      const [errors, setErrors] = useState({});
      const [messages, setMessages] = useState({});
      const [busy, setBusy] = useState('');
      const [confirmJob, setConfirmJob] = useState(null);
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
                const value = await api(route, controller.signal);
                if (!fresh()) return;
                update(value);
                setErrors((old) => ({ ...old, [key]: '' }));
              } catch (error) {
                if (fresh()) setErrors((old) => ({ ...old, [key]: error.message }));
              }
            }
            const reads = [
              read('status', '/status', setStatus),
              read('settings', '/settings', setSettings),
              read('jobs', `/jobs?filter=${filter}`, (page) => {
                setJobs(page);
                if (filter === 'attention') setAttention(page.total);
              }),
              read('prompt', '/prompt', (value) => setPrompt(value.text)),
            ];
            if (filter !== 'attention') reads.push(read('attention', '/attention', (value) => setAttention(value.total)));
            await Promise.all(reads);
          }
          if (!controller.signal.aborted) timer = setTimeout(refresh, 7000);
        }
        refresh();
        return () => { controller.abort(); clearTimeout(timer); };
      }, [filter, revision]);

      async function mutate(key, path, body, success) {
        if (mutation.current || !life.current) return;
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
            if (err.saved && key === 'settingsSave') acceptSettings(body);
            if (err.saved && key === 'promptSave') { setPrompt(body.text); setPromptDraft(null); }
            setErrors((old) => ({ ...old, [key]: err.saved
              ? `内容已保存，但后续处理没有完成：${err.message}。请查看运行状态，不要重复保存。`
              : key === 'settingsSave' && err.status === 409
                ? `配置尚未修改，草稿已保留。${err.message}` : err.message }));
          }
        } finally {
          mutation.current = false;
          if (!controller.signal.aborted) { setBusy(''); setRevision((v) => v + 1); }
        }
      }

      function acceptSettings(patch) {
        setSettings((old) => ({ ...old, ...patch,
          ...(patch.gemini ? { gemini: { ...old.gemini, ...patch.gemini } } : {}),
        }));
        setEdits({});
      }

      let patch = {};
      let validation = '';
      if (settings) {
        try { patch = settingsPatch(settings, edits); }
        catch (err) { validation = err.message; }
      }
      const dirty = Object.keys(patch).length > 0 || !!validation;
      const runtime = status?.runtime;
      const activeSettings = status?.settings;
      const edit = (key, value) => {
        setEdits((old) => ({ ...old, [key]: value }));
        setMessages((old) => ({ ...old, settingsSave: '' }));
        setErrors((old) => ({ ...old, settingsSave: '' }));
      };
      function field(key, label, hint, options) {
        const value = Object.hasOwn(edits, key) ? edits[key] : fieldValue(settings, key);
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
      function statusRow(label, value, hint) {
        return h('div', { className: 'dcc-status', key: label }, h('div', null, h('strong', null, `${label}：`), value), h('small', null, hint));
      }
      const runtimeState = {
        synchronized: ['已生效', '当前运行的版本与已保存的版本一致。'],
        pending: ['等待生效', '已保存的版本还没有完全用于当前运行。'],
        unknown: ['暂时无法确认', '请查看下面的读取情况，再决定是否重新加载。'],
      }[runtime?.state] || ['暂时无法确认', '还没有读到可用的运行状态。'];
      const executionText = { running: '运行中', completed: '已结束', failed: '执行失败', cancelled: '已取消', unknown: '状态待确认' };
      const recent = [...(jobs?.jobs || [])].sort((a, b) => b.started_at - a.started_at).slice(0, 20);
      const promptValue = promptDraft === null ? prompt ?? '' : promptDraft;
      const promptDirty = prompt !== null && promptValue !== prompt;

      return h('div', { className: 'dcc-panel' },
        h('style', null, CSS),
        h('section', { 'aria-label': '运行状态' },
          h('div', { className: 'dcc-row' }, h('h3', null, '运行状态'),
            h(Button, { size: 'sm', disabled: !!busy, onClick: () => setRevision((v) => v + 1) }, '刷新状态')),
          h('p', { className: 'dcc-muted' }, '每 7 秒自动查看状态和任务。未保存的输入会保留。'),
          h(Message, { text: errors.status, error: true }),
          errors.status && status ? h('small', null, '下面保留的是上次成功读取的状态。') : null,
          !status ? h('p', null, errors.status ? '暂时读不到运行状态。' : '正在读取运行状态…') : null,
          status ? h('div', null,
            statusRow('生效情况', runtimeState[0], runtimeState[1]),
            statusRow('正在运行的版本', runtime?.loaded?.version || '未读到', '这是本次运行实际使用的插件版本。'),
            statusRow('加载时间', runtime?.loaded?.loadedAt ? new Date(runtime.loaded.loadedAt).toLocaleString('zh-CN') : '未读到', '这是当前运行版本的加载时间。'),
            statusRow('已保存的版本', runtime?.source?.version || '未读到', '这是磁盘上可供下一次加载的插件版本。'),
            statusRow('当前模型', activeSettings ? activeSettings.model || '跟随 Codex 配置' : '未读到', '这是状态接口报告的模型，不包含下面尚未保存的更改。'),
            statusRow('思考程度', activeSettings ? EFFORTS.find(([value]) => value === activeSettings.effort)?.[1] || activeSettings.effort || '跟随 Codex 配置' : '未读到', '控制 Codex 做任务时思考得多深入。'),
            statusRow('速度档', activeSettings ? activeSettings.serviceTier || '跟随 Codex 配置' : '未读到', '使用 Codex 配置或账号支持的 fast、ultrafast 档位。'),
            statusRow('自动回答 Codex 的问题', activeSettings ? activeSettings.plannerAnswers ? '已开启' : '已关闭' : '未读到', '打开后 DeepSeek 会替你回答 Codex 的问题并继续干活，不再等你'),
            statusRow('Gemini 写作', activeSettings ? activeSettings.gemini ? '已开启' : '未开启' : '未读到', '已配置时，可以让 Gemini 写教程和文档。'),
            statusRow('正在执行的任务', runtime?.active_tasks ?? '未读到', '任务执行期间不应强行重新加载。'),
            statusRow('需要关注的任务', attention ?? ((filter === 'attention' ? errors.jobs : errors.attention) ? '未读到' : '正在读取…'), '这些任务有问题或结果需要你查看。'),
            filter !== 'attention' ? h(Message, { text: errors.attention, error: true }) : null,
            statusRow('重新加载', runtime?.can_reload ? '现在可以操作' : '暂时不能操作', '只有服务确认可以加载时，下面的按钮才可用。'),
            statusRow('配置读取', runtime?.profile_error || '未发现错误', '读取已保存配置遇到的问题会显示在这里。'),
            statusRow('运行版本读取', runtime?.loaded_error || '未发现错误', '读取当前运行版本遇到的问题会显示在这里。')) : null,
          h(Button, { variant: 'outline', disabled: !!busy || !!errors.status || !runtime?.can_reload,
            onClick: () => mutate('reload', '/reload', {}, (value) => {
              const text = {
                reloaded: '已重新加载，正在刷新运行状态。', already_current: '当前已经是已保存的版本。',
                unconfirmed: '已请求加载，但还没有确认生效，请查看运行状态。',
                waiting_for_idle: '已安排，任务结束后自动重载', failed: '重新加载失败，请查看运行状态后重试。',
              }[value.status] || '服务没有确认加载结果，请查看运行状态。';
              if (value.status === 'failed') setErrors((old) => ({ ...old, reload: text }));
              else setMessages((old) => ({ ...old, reload: text }));
            }) }, busy === 'reload' ? '正在重载插件…' : '立即重载插件'),
          h(Message, { text: messages.reload }), h(Message, { text: errors.reload, error: true })),

        h('section', { 'aria-label': '常用设置' }, h('h3', null, '常用设置'),
          h(Message, { text: errors.settings, error: true }),
          settings ? h('div', null,
            h('div', { className: 'dcc-grid' },
              field('model', 'Codex 模型', '填写要使用的模型名。'),
              field('effort', '执行时的思考程度', '越高通常想得越久，也可能花更多时间。', EFFORTS),
              field('readOnlyEffort', '只读任务的思考程度', '用于查看代码、分析和复核。', [['', '跟随执行设置'], ...EFFORTS]),
              field('serviceTier', '速度档', '跟随 Codex 配置，或使用账号支持的加速档位。', [['', '跟随 Codex 配置'], ['fast', 'fast'], ['ultrafast', 'ultrafast']]),
              field('lockTimeoutSeconds', '等待写入锁的秒数', '等其他写入任务让出位置的最长时间；未设置时留空即可。'),
              field('maxStorageMb', '任务记录上限（MiB）', '超过上限时会清理最旧的已结束任务记录；未设置时可留空。'),
              settings.gemini ? field('gemini.model', 'Gemini 模型', '只影响已经配置好的 Gemini 执行端。') : null,
              settings.gemini ? field('gemini.effort', 'Gemini 思考程度', 'Gemini 支持低、中、高三档。', EFFORTS.slice(0, 3)) : null),
            h('div', { className: 'dcc-actions' },
              h(Checkbox, { label: '允许规划端回答阻塞问题', checked: Object.hasOwn(edits, 'plannerAnswers') ? edits.plannerAnswers : settings.plannerAnswers === true,
                disabled: !!busy, onChange: (value) => edit('plannerAnswers', value) }),
              h('small', null, '打开后 DeepSeek 会替你回答 Codex 的问题并继续干活，不再等你')),
            h(Message, { text: validation, error: true }),
            h('div', { className: 'dcc-row dcc-actions' },
              h(Button, { variant: 'primary', disabled: !!busy || !dirty || !!validation,
                onClick: () => mutate('settingsSave', '/settings', patch, (value) => {
                  acceptSettings(patch);
                  if (value.runtime?.state) setStatus((old) => ({ ...old, runtime: value.runtime }));
                  const text = value.runtime?.status === 'unconfirmed'
                    ? '设置已保存，但尚未加载生效。请查看运行状态，不要重复保存。'
                    : value.runtime?.status === 'waiting_for_idle'
                      ? '设置已保存。已安排，任务结束后自动重载'
                      : '设置已保存。是否已生效，请看上方运行状态。';
                  setMessages((old) => ({ ...old, settingsSave: text }));
                }) }, busy === 'settingsSave' ? '正在保存并生效…' : '保存并生效'),
              h(Button, { disabled: !!busy || !dirty, onClick: () => { setEdits({}); setErrors((old) => ({ ...old, settingsSave: '' })); } }, '放弃设置更改'),
              dirty ? h('small', null, '有未保存的设置。') : null),
            h(Message, { text: messages.settingsSave }), h(Message, { text: errors.settingsSave, error: true }))
            : h('p', null, errors.settings ? '设置暂时无法读取，请刷新后重试。' : '正在读取设置…')),

        h('section', { 'aria-label': '最近任务' }, h('h3', null, '最近任务'),
          h('div', { className: 'dcc-row', role: 'group', 'aria-label': '筛选任务' },
            ...[['running', '正在跑'], ['attention', '待关注'], ['all', '全部']].map(([value, label]) =>
              h(Button, { key: value, size: 'sm', variant: filter === value ? 'primary' : 'ghost', 'aria-pressed': filter === value,
                onClick: () => { if (value !== filter) { setFilter(value); setJobs(null); setConfirmJob(null); } } }, label))),
          h('small', null, jobs ? `当前筛选共 ${jobs.total} 项，显示最近 ${recent.length} 项，最多 20 项。` : '正在读取任务…'),
          h(Message, { text: errors.jobs, error: true }),
          jobs && !recent.length ? h('p', null, '当前筛选下没有任务。') : null,
          h('ul', { className: 'dcc-jobs' }, ...recent.map((job) => {
            const running = (job.execution_status || job.status) === 'running';
            return h('li', { key: job.job_id, className: 'dcc-job' },
              h('strong', null, job.title || '未填写任务标题'),
              h('small', null, `${executionText[job.execution_status || job.status] || '状态待确认'}${job.needs_attention ? ' · 需要关注' : ''} · ${new Date(job.started_at * 1000).toLocaleString('zh-CN')}`),
              h('small', null, `任务编号：${job.job_id}`),
              h('div', { className: 'dcc-row' },
                h(Button, { size: 'sm', onClick: () => setReportJob(job.job_id) }, '查看全文报告'),
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
          h(Message, { text: messages.cancel }), h(Message, { text: errors.cancel, error: true }),
          reportJob ? h(Report, { key: reportJob, jobId: reportJob, onClose: () => setReportJob(null) }) : null),

        h('section', { 'aria-label': '规划提示词' }, h('h3', null, '规划提示词'),
          h('p', { className: 'dcc-muted' }, '填写给规划端的要求，例如怎样拆任务、写验收标准。自动刷新不会覆盖正在编辑的草稿。'),
          h(Message, { text: errors.prompt, error: true }),
          h('label', { className: 'dcc-field' }, h('span', null, '给规划端的具体要求'),
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

    function apply(ctx) {
      ctx.inject(['slots'], (ctx) => {
        const slots = ctx.get('slots');
        return slots.inject('settings.section', () => slots.register({
          name: 'settings.section', id: 'dsh-codex-conductor', order: 80, label: () => 'Codex 指挥',
        }, Panel));
      });
    }

    return { apply, Panel };
  },
});
