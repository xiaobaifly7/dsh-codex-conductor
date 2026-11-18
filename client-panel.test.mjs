import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { validReport } from './workflow.mjs';

const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8');
const sample = () => ({
  summary: '已修复设置保存，报告可直接阅读。',
  criteria: [
    { criterion: '保存设置', status: 'met', evidence: '测试通过' },
    { criterion: '查看报告', status: 'not_met', evidence: '仍需核对' },
    { criterion: '验证接回', status: 'blocked', evidence: '证据'.repeat(200) },
  ],
  files_changed: ['client.js'], deviations: ['未连接真实服务'], unresolved: ['等待人工核对'],
  blockers: [{ id: 'B1', kind: 'user_input', message: '需要确认显示效果', question: '是否合适？', resolution: '用户确认后继续' }],
});
const plain = (value) => JSON.parse(JSON.stringify(value));

// A small hook host exercises real handlers/effects without installing React or using a browser.
function clientHost(handler = () => ({}), { window = {}, modules = {}, ...globals } = {}) {
  const slots = [], effects = [], requests = [], timers = new Map();
  let index = 0, dirty = false, root, tree, definition, timerId = 0;
  const react = {
    Component: class { constructor(props) { this.props = props; } },
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState(initial) {
      const i = index++;
      slots[i] ??= { value: initial };
      return [slots[i].value, (value) => { slots[i].value = typeof value === 'function' ? value(slots[i].value) : value; dirty = true; }];
    },
    useRef(current) { const i = index++; slots[i] ??= { current }; return slots[i]; },
    useEffect(fn, deps) {
      const i = index++, prior = slots[i];
      if (!prior || deps.some((v, n) => v !== prior.deps[n])) {
        slots[i] = { deps, cleanup: prior?.cleanup };
        effects.push(() => { slots[i].cleanup?.(); slots[i].cleanup = fn(); });
      }
    },
  };
  vm.runInNewContext(source, {
    ...globals, window: { ...window, __ModuleLoader__: { load: (value) => { definition = value; } } }, AbortController,
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; }, clearTimeout: (id) => timers.delete(id),
    fetch: async (url, options) => {
      const path = url.replace('/dsh-codex-conductor', '');
      const body = options.body ? JSON.parse(options.body) : undefined;
      requests.push({ path, body });
      const result = await handler(path, body, options.signal);
      return { ok: !result?.error, status: result?.error ? 500 : 200, json: async () => result };
    },
  });
  const exports = definition.factory((name) => name === 'react' ? react : modules[name] || { Button: 'button', Input: 'input', Checkbox: 'checkbox' });
  function render() { index = 0; dirty = false; tree = root(); while (effects.length) effects.shift()(); }
  return {
    exports, requests, timers,
    mount(component, props = {}) { root = () => component(props); render(); },
    async flush() { for (let n = 0; n < 12; n++) { await new Promise(setImmediate); if (dirty) render(); } },
    get tree() { return tree; },
    poll() { for (const [id, { fn }] of [...timers]) { timers.delete(id); fn(); } },
    dispose() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

function nodes(node) {
  if (node == null || node === false) return [];
  if (typeof node !== 'object') return [node];
  if (typeof node.type === 'function') return nodes(node.type({ ...node.props, children: node.children }));
  return [node, ...node.children.flatMap(nodes)];
}
const text = (node) => nodes(node).filter((n) => typeof n !== 'object').join(' ');
const button = (host, label) => {
  const result = nodes(host.tree).find((node) => node.type === 'button' && text(node) === label);
  assert.ok(result, `button ${label} exists`);
  return result;
};
const click = async (host, label) => { const b = button(host, label); assert.ok(!b.props.disabled, `${label} enabled`); await b.props.onClick(); await host.flush(); };
const field = (host, label) => {
  const container = nodes(host.tree).find((node) => node.type === 'label' && text(node).startsWith(label));
  assert.ok(container, label);
  return nodes(container).find((node) => ['input', 'select', 'checkbox', 'textarea'].includes(node.type));
};
const change = async (host, label, value) => { field(host, label).props.onChange({ target: { value } }); await host.flush(); };

// Expose the test-rendered element tree through the selectors used by the collector.
function renderedNode(tree) {
  const all = nodes(tree).filter((node) => typeof node === 'object');
  const matches = (node, selector) => selector.startsWith('.') ? node.props.className?.split(' ').includes(selector.slice(1))
    : selector.startsWith('[') ? Object.hasOwn(node.props, selector.slice(1, -1)) : node.type === selector;
  return {
    textContent: nodes(tree).filter((node) => typeof node !== 'object').join(''),
    get firstElementChild() { return renderedNode(tree.children.find((node) => node && typeof node === 'object')); },
    querySelectorAll(selector) {
      const found = selector === 'ol > li' ? all.filter((node) => node.type === 'ol').flatMap((node) => node.children)
        .filter((node) => node?.type === 'li') : all.filter((node) => matches(node, selector));
      return found.map(renderedNode);
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; },
  };
}

test('selftest waits for panel reads, opens the first real Report and blocks mutation handlers', async (t) => {
  const service = panelService();
  const host = clientHost(service.handle); t.after(() => host.dispose());
  const reads = [];
  let finished = 0;
  const selftest = { finish: () => { finished++; }, read: async (path) => { reads.push(path); return service.handle(path); } };
  const job = { job_id: 'first-job', title: 'first', status: 'completed', started_at: 0 };
  service.handle = (path) => path.startsWith('/jobs') ? { total: 1, jobs: [job] } : panelService().handle(path);
  host.mount(host.exports.Panel, { selftest }); await host.flush();
  assert.deepEqual(reads.sort(), ['/attention', '/jobs?filter=all&offset=0', '/prompt', '/settings', '/status']);
  const report = host.tree.children.flatMap((node) => node?.children || []).find((node) => node?.type === host.exports.Report);
  assert.equal(report.props.jobId, 'first-job');
  assert.equal(report.props.selftest, selftest);
  assert.equal(finished, 0, 'must wait for the report');
  const status = host.tree.children.find((node) => node?.type === host.exports.Status);
  const reload = nodes(host.exports.Status(status.props)).find((node) => node.type === 'button' && text(node) === '重新加载插件（等任务结束）');
  await reload.props.onClick();
  assert.equal(host.requests.length, 0, 'even an invoked mutation handler cannot write in selftest mode');
  assert.equal(host.timers.size, 0, 'offscreen panel does not start normal seven-second polling');

  const reportHost = clientHost(); t.after(() => reportHost.dispose());
  const output = reportReader(JSON.stringify(sample()), []);
  reportHost.mount(reportHost.exports.Report, { jobId: 'first-job', selftest: { finish: () => { finished++; }, read: output } });
  await reportHost.flush();
  assert.equal(finished, 1);
  assert.match(text(reportHost.tree), /概述.*逐条验收/s);
  assert.equal(reportHost.requests.length, 0);
});

test('selftest prefers the newest finished task and falls back to the first running task', async (t) => {
  for (const state of ['completed', 'failed', 'cancelled', null]) {
    const jobs = [
      { job_id: 'running', status: 'running', started_at: 4 },
      { job_id: 'unknown', status: 'unknown', started_at: 3 },
      ...(state ? [{ job_id: 'finished', status: 'running', execution_status: state, started_at: 2 },
        { job_id: 'older', status: 'completed', started_at: 1 }] : []),
    ];
    const service = panelService();
    const selftest = { finish: () => assert.fail('must wait for Report'),
      read: async (path) => path.startsWith('/jobs') ? { total: jobs.length, jobs } : service.handle(path) };
    const host = clientHost(); t.after(() => host.dispose());
    host.mount(host.exports.Panel, { selftest }); await host.flush();
    const report = host.tree.children.flatMap((node) => node?.children || []).find((node) => node?.type === host.exports.Report);
    assert.equal(report.props.jobId, state ? 'finished' : 'running');
  }
});

test('selftest with no tasks finishes after reads, including a failed interface', async (t) => {
  for (const failed of [false, true]) {
    const service = panelService(), host = clientHost(); t.after(() => host.dispose());
    let finished = 0;
    host.mount(host.exports.Panel, { selftest: {
      finish: () => { finished++; },
      read: async (path) => { if (failed && path === '/status') throw new Error('状态读取失败，请重试。'); return service.handle(path); },
    } });
    await host.flush();
    assert.ok(finished > 0);
    assert.equal(host.requests.length, 0);
    if (failed) assert.match(text(host.tree), /状态读取失败/);
  }
});

test('selftest collector reads rendered headings, displayed status and 80 Unicode report characters', () => {
  const host = clientHost(undefined, { navigator: { userAgent: 'test Electron/40' }, location: { origin: 'http://test' } });
  const report = sample(); report.criteria[0].criterion = '🙂'.repeat(100);
  const tree = { type: 'div', props: {}, children: [
    host.exports.Status({ status: { runtime: { loaded: { version: '0.9.61' } }, settings: settings() } }),
    ...['常用设置', '最近任务', '规划提示词'].map((title) => ({ type: 'h3', props: {}, children: [title] })),
    { type: 'li', props: { className: 'dcc-job' }, children: ['task'] },
    { type: 'div', props: { 'data-dcc-report': 'J' }, children: [host.exports.ReadableReport({ report })] },
  ] };
  const result = host.exports.collectSelftest(renderedNode(tree), [{ path: '/status', status: 200 }], ['failure'], false);
  assert.deepEqual(plain(result.sections), { 运行状态: true, 常用设置: true, 最近任务: true, 规划提示词: true });
  assert.deepEqual(plain(result.status), { version: '0.9.61', model: 'old-model', effort: '高', serviceTier: '跟随 Codex 配置' });
  assert.equal(result.taskCount, 1);
  assert.deepEqual(plain(result.report), { opened: true, summary: true, criteria: true, firstCriterion: '通过：' + '🙂'.repeat(77) });
  assert.deepEqual(plain(result.errors), ['failure']);
  assert.equal(result.userAgent, 'test Electron/40');
  assert.equal(result.origin, 'http://test');
});

function offscreenHost(handler, render) {
  const events = new Map();
  const node = Object.assign(renderedNode(null), { style: {}, setAttribute(name, value) { this[name] = value; },
    remove() { this.removed = true; } });
  const root = { render: (element) => render(element), unmount() { this.unmounted = true; } };
  const host = clientHost(handler, {
    navigator: { userAgent: 'test Electron/40' }, location: { origin: 'http://test' },
    document: { createElement: () => node, body: { appendChild: () => { node.appended = true; } } },
    window: { addEventListener: (name, fn) => events.set(name, fn), removeEventListener: (name) => events.delete(name) },
    modules: { 'react-dom/client': { createRoot: () => root } },
  });
  return { host, node, root, events };
}

test('selftest without a request only polls once a minute after settings registration', async () => {
  let registered = false;
  const { host, node } = offscreenHost(() => { assert.equal(registered, true); return { request: null }; }, () => assert.fail('unexpected render'));
  let cleanup;
  const slots = { register() { registered = true; return () => { registered = false; }; },
    inject(_name, fn) { cleanup = fn(); return cleanup; } };
  host.exports.apply({ inject: (_names, fn) => fn({ get: () => slots }) });
  await host.flush();
  assert.equal(node.appended, undefined);
  assert.deepEqual(host.requests, [{ path: '/selftest/request', body: undefined }]);
  assert.deepEqual([...host.timers.values()].map(({ ms }) => ms), [60000]);
  host.poll(); await host.flush();
  assert.equal(host.requests.length, 2);
  cleanup();
  assert.equal(host.timers.size, 0);
  assert.equal(registered, false);
});

test('selftest unmounts offscreen before posting and records timeout, render errors and disposal', async () => {
  for (const mode of ['complete', 'timeout', 'error', 'dispose']) {
    const { host, node, root, events } = offscreenHost((_path, body) => {
      if (body === undefined) return mode === 'timeout' ? new Promise(() => {}) : {};
      assert.equal(node.removed, true); assert.equal(root.unmounted, true);
      assert.equal(body.result.settingsRegistered, true); return { saved: true };
    }, (element) => {
      if (mode === 'complete') {
        const selftest = element.children[0].props.selftest;
        selftest.read('/status').then(selftest.finish);
      }
      if (mode === 'timeout') element.children[0].props.selftest.read('/status');
      if (mode === 'error') throw new Error('primitive render failed');
    });
    const controller = new AbortController();
    const pending = host.exports.runSelftest({ id: 'test', claim: 'claim' }, controller.signal);
    assert.equal(node.appended, true); assert.equal(node.inert, true); assert.equal(node['aria-hidden'], 'true');
    assert.match(node.style.cssText, /left:-100000px.*visibility:hidden/);
    if (mode === 'timeout') host.poll();
    if (mode === 'dispose') controller.abort();
    const result = await pending;
    assert.equal(result.timedOut, mode === 'timeout');
    if (mode === 'error') assert.deepEqual(plain(result.errors), ['primitive render failed']);
    assert.equal(node.removed, true); assert.equal(root.unmounted, true);
    assert.equal(events.size, 0); assert.equal(host.timers.size, 0);
    assert.deepEqual(host.requests.map(({ path }) => path), mode === 'dispose' ? []
      : ['complete', 'timeout'].includes(mode) ? ['/status', '/selftest/result'] : ['/selftest/result']);
    if (mode === 'complete') assert.deepEqual(plain(result.http), [{ path: '/status', status: 200 }]);
    if (mode === 'timeout') assert.deepEqual(plain(result.http), [{ path: '/status', status: null }]);
  }
});

test('client parser matches workflow validation for v2, legacy, and malformed structures', () => {
  const { parseReport } = clientHost().exports;
  const v2 = sample(), legacy = sample(); delete legacy.blockers;
  const cases = [v2, legacy, null, [], {}, { ...v2, extra: 1 }, { ...v2, criteria: [{ ...v2.criteria[0], status: 'done' }] },
    { ...v2, files_changed: [1] }, { ...v2, blockers: [{ ...v2.blockers[0], question: '' }] },
    { ...v2, blockers: [v2.blockers[0], v2.blockers[0]] }, { ...v2, blockers: null },
    { ...v2, blockers: [{ ...v2.blockers[0], extra: true }] }, { ...v2, unresolved: 'lost' }];
  for (const value of cases) assert.equal(parseReport(JSON.stringify(value)) !== null, validReport(value));
  assert.equal(parseReport('{bad JSON'), null);
  assert.deepEqual(plain(parseReport(JSON.stringify(v2))), v2);
});

test('readable report preserves evidence, questions, deviations and unresolved items', () => {
  const { ReadableReport } = clientHost().exports;
  const report = sample(), tree = ReadableReport({ report });
  for (const value of ['通过：保存设置', '未通过：查看报告', '受阻：验证接回', report.summary, report.criteria[2].evidence,
    report.blockers[0].message, report.blockers[0].question, report.blockers[0].resolution, 'Codex 原话', 'client.js', '未连接真实服务', '等待人工核对']) {
    assert.ok(text(tree).includes(value), value);
  }
  assert.equal(nodes(tree).filter((node) => node.type === 'details').length, 1);
});

test('readable report maps original criteria by number and expands long Unicode requirements', () => {
  const { ReadableReport } = clientHost().exports;
  const acceptance = Array.from({ length: 10 }, (_, i) => `验收要求 ${i + 1}`);
  acceptance[9] = '🙂'.repeat(350);
  const report = { ...sample(), criteria: [
    { criterion: '1', status: 'met', evidence: '刷新后设置仍然可见' },
    { criterion: '２）', status: 'not_met', evidence: '仍需补充验证' },
    { criterion: '第10条', status: 'blocked', evidence: '没有测试设备' },
    { criterion: '11', status: 'blocked', evidence: '旧记录没有原文' },
  ] };
  const tree = ReadableReport({ report, acceptance });
  const headings = nodes(tree).filter((node) => node.type === 'strong').map(text);
  assert.deepEqual(headings, ['第 1 条：验收要求 1 —— 通过', '第 2 条：验收要求 2 —— 未通过',
    `第 10 条：${'🙂'.repeat(300)}… —— 受阻`, '受阻：11']);
  const details = nodes(tree).filter((node) => node.type === 'details');
  assert.equal(details.length, 1);
  assert.ok(text(details[0]).includes('展开验收标准原文'));
  assert.ok(text(details[0]).includes(acceptance[9]));
  for (const item of report.criteria) assert.ok(text(tree).includes(`证据：${item.evidence}`));
  const legacy = ReadableReport({ report: sample(), acceptance: acceptance.slice(0, 3) });
  assert.ok(text(legacy).includes('第 1 条：验收要求 1 —— 通过'));
  const mismatched = ReadableReport({ report: sample(), acceptance: acceptance.slice(0, 2) });
  assert.ok(text(mismatched).includes('通过：保存设置'));
});

function reportReader(content, requests, total = true) {
  const chars = Array.from(content);
  return async (path) => {
    const query = new URL(path, 'http://test').searchParams;
    const offset = Number(query.get('offset')), limit = Number(query.get('limit'));
    requests.push(offset);
    const end = Math.min(chars.length, offset + limit);
    return { text: chars.slice(offset, end).join(''), next_offset: end < chars.length ? end : null, eof: end >= chars.length,
      ...(total ? { total_chars: chars.length } : {}) };
  };
}

test('report reader assembles all pages using runner character offsets and limits whole reports', async () => {
  const { loadReport, REPORT_LIMIT } = clientHost().exports;
  const report = { ...sample(), summary: '🙂'.repeat(9000) }, requests = [];
  const result = await loadReport('job_1', undefined, reportReader(JSON.stringify(report), requests));
  assert.deepEqual(plain(result.report), report);
  assert.deepEqual(requests, [0, 8000]);
  const base = { ...sample(), summary: '' }, overhead = Array.from(JSON.stringify(base)).length;
  for (const excess of [0, 1]) {
    const content = JSON.stringify({ ...base, summary: '🙂'.repeat(REPORT_LIMIT - overhead + excess) });
    const offsets = [], loaded = await loadReport('J', undefined, reportReader(content, offsets));
    assert.equal(loaded.tooLarge, excess === 1);
    assert.equal(loaded.report !== null, excess === 0);
    if (excess) assert.deepEqual(offsets, [0], 'known oversized report reads only the first raw page');
  }
  const oversized = await loadReport('J', undefined, reportReader('x'.repeat(REPORT_LIMIT + 1), [], false));
  assert.equal(oversized.tooLarge, true, 'cap also works without total_chars');
});

test('pending reports show a normal status and selftest note instead of an error or raw fallback', async (t) => {
  for (const pending of [{ status: 'pending' }, { error_kind: 'artifact_pending' }]) {
    let finished = 0, reads = 0;
    const host = clientHost(undefined, { navigator: { userAgent: 'test Electron/40' }, location: { origin: 'http://test' } });
    t.after(() => host.dispose());
    host.mount(host.exports.Report, { jobId: 'J',
      selftest: { finish: () => { finished++; }, read: async () => { reads++; return pending; } } });
    await host.flush();
    assert.equal(text(host.tree).includes('这个任务还在运行，报告会在任务结束后生成。'), true);
    assert.doesNotMatch(text(host.tree), /不支持易读视图|没有输出|第 1 页|上一页|下一页/);
    assert.equal(nodes(host.tree).some((node) => node.type === 'pre' || node.props?.role === 'alert'), false);
    assert.equal(finished, 1);
    assert.equal(reads, 1, 'pending output must not be treated as a malformed page');
    assert.equal(host.timers.size, 0);
    const result = host.exports.collectSelftest(renderedNode(host.tree), [], [], false);
    assert.deepEqual(plain(result.report), { opened: true, summary: false, criteria: false,
      firstCriterion: '', note: '报告尚未生成（任务运行中）' });
    assert.deepEqual(plain(result.errors), []);
  }
});

test('the next automatic jobs refresh reopens a pending report when its task finishes', async (t) => {
  const service = panelService();
  const job = { job_id: 'J', title: 'task', status: 'running', execution_status: 'running', started_at: 0 };
  const panel = clientHost((path) => path.startsWith('/jobs') ? { total: 1, jobs: [{ ...job }] } : service.handle(path));
  t.after(() => panel.dispose());
  panel.mount(panel.exports.Panel); await panel.flush();
  await click(panel, '查看报告');
  const selected = () => panel.tree.children.flatMap((node) => node?.children || []).find((node) => node?.type === panel.exports.Report);
  const offsets = [];
  const read = reportReader(JSON.stringify(sample()), offsets);
  const report = clientHost(async (...args) => job.execution_status === 'running'
    ? { status: 'pending', error_kind: 'artifact_pending' } : read(...args));
  t.after(() => report.dispose());
  report.mount(report.exports.Report, selected().props); await report.flush();
  assert.ok(text(report.tree).includes('这个任务还在运行，报告会在任务结束后生成。'));
  const firstRefresh = selected().props.refreshKey;
  panel.poll(); await panel.flush();
  assert.notEqual(selected().props.refreshKey, firstRefresh);
  report.mount(report.exports.Report, selected().props); await report.flush();
  assert.equal(report.requests.length, 2, 'a pending report follows the existing poll while running');
  job.status = job.execution_status = 'completed';
  panel.poll(); await panel.flush();
  assert.equal(selected().props.key, 'J');
  report.mount(report.exports.Report, selected().props); await report.flush();
  assert.match(text(report.tree), /概述.*逐条验收/s);
  assert.doesNotMatch(text(report.tree), /这个任务还在运行/);
  assert.equal(report.requests.length, 3);
  assert.deepEqual(offsets, [0]);
  panel.poll(); await panel.flush();
  report.mount(report.exports.Report, selected().props); await report.flush();
  assert.equal(report.requests.length, 3, 'a complete report is not read again on each poll');
});

test('report view preserves real read errors', async (t) => {
  const host = clientHost(() => ({ error: '读取报告失败，请重试。' })); t.after(() => host.dispose());
  host.mount(host.exports.Report, { jobId: 'J' }); await host.flush();
  assert.equal(nodes(host.tree).some((node) => node.props?.role === 'alert'), true);
  assert.match(text(host.tree), /读取报告失败/);
  assert.doesNotMatch(text(host.tree), /这个任务还在运行/);
});

test('report view defaults to readable; raw page navigation reuses cached full report', async (t) => {
  const requests = [], report = { ...sample(), summary: '概述'.repeat(4100) };
  report.criteria[0].criterion = '1';
  const read = reportReader(JSON.stringify(report), requests);
  const host = clientHost(async (...args) => ({ ...await read(...args), acceptance: ['保存设置后刷新仍可见', '查看报告', '验证接回'] }));
  t.after(() => host.dispose());
  host.mount(host.exports.Report, { jobId: 'J' }); await host.flush();
  assert.ok(text(host.tree).includes('逐条验收'));
  assert.ok(text(host.tree).includes('第 1 条：保存设置后刷新仍可见 —— 通过'));
  await click(host, '查看原文');
  assert.ok(text(host.tree).includes('第 1 页'));
  await click(host, '下一页'); await click(host, '上一页'); await click(host, '查看易读报告');
  assert.deepEqual(requests, [0, 8000]);
});

test('bad JSON falls back without an error; oversized raw pages load once each', async (t) => {
  for (const content of ['{bad JSON', 'x'.repeat(270000)]) {
    const requests = [], host = clientHost(reportReader(content, requests)); t.after(() => host.dispose());
    host.mount(host.exports.Report, { jobId: 'J' }); await host.flush();
    assert.ok(nodes(host.tree).some((node) => node.type === 'pre'));
    assert.ok(!nodes(host.tree).some((node) => node.props?.role === 'alert'));
    if (content.length > 262144) {
      await click(host, '下一页'); await click(host, '上一页'); await click(host, '下一页');
      assert.deepEqual(requests, [0, 8000]);
    }
  }
});

const settings = () => ({ model: 'old-model', effort: 'high', serviceTier: '', plannerAnswers: false,
  plannerReads: 'open', plannerReadAllowCount: 2, gemini: { model: 'gemini-old', effort: 'medium' } });
function panelService() {
  const service = { cfg: settings(), status: { settings: settings(), runtime: { state: 'synchronized', active_tasks: 2,
    active_sessions: 0, sessions_error: null, idle_wait: null, can_reload: true, pending_settings: null } }, saveError: null };
  service.handle = (path, body) => {
    if (body !== undefined) {
      if (service.saveError) return service.saveError;
      if (path === '/settings/cancel') { service.status.runtime.pending_settings = null; service.status.runtime.idle_wait = null; return { cancelled: true }; }
      if (path === '/settings/apply') {
        service.cfg = { ...service.cfg, ...body.changes };
        service.status = { settings: service.cfg, runtime: { ...service.status.runtime, state: 'synchronized', idle_wait: null, pending_settings: null } };
        return { saved: true, runtime: { status: 'reloaded', pending_settings: null } };
      }
      service.status.runtime.idle_wait = { status: 'waiting', deadline_at: '2026-11-11T00:10:00Z', remaining_seconds: 600 };
      if (path === '/reload') return { ...service.status.runtime, status: 'waiting_for_idle' };
      const pending = { changes: body, saved_at: '2026-11-11T00:00:00Z' };
      service.status.runtime.pending_settings = pending;
      return { saved: true, runtime: { ...service.status.runtime, status: 'waiting_for_idle' } };
    }
    if (path === '/status') return structuredClone(service.status);
    if (path === '/settings') return structuredClone(service.cfg);
    if (path === '/prompt') return { text: '原提示词', injected: true };
    if (path === '/prompt?kind=executor') return { text: '原固定要求' };
    if (path === '/gemini') return { entries: [] };
    if (path === '/attention') return { total: 3 };
    if (path.startsWith('/jobs')) return { total: 524, jobs: [] };
    throw new Error(path);
  };
  return service;
}

test('planner read switch saves pending products mode, preserves active mode, and applies open on confirmation', async (t) => {
  const service = panelService(), host = clientHost(service.handle); t.after(() => host.dispose());
  const label = '规划端只读 Codex 的产物，不直接读源码';
  const toggle = () => nodes(host.tree).find((node) => node.type === 'checkbox' && node.props.label === label);
  host.mount(host.exports.Panel); await host.flush();
  assert.equal(toggle().props.checked, false);
  assert.ok(text(host.tree).includes('规划端读取范围： 不限制读取'));
  assert.ok(text(host.tree).includes('额外允许读取的路径： 2 条'));
  assert.equal(nodes(host.tree).filter((node) => node.props?.label === label).length, 1);
  toggle().props.onChange(true); await host.flush();
  assert.equal(toggle().props.checked, true);
  await click(host, '等当前任务结束后自动生效');
  assert.deepEqual(host.requests.find((r) => r.body), { path: '/settings', body: { plannerReads: 'products' } });
  assert.equal(toggle().props.checked, true);
  assert.ok(text(host.tree).includes('规划端读取范围： 不限制读取'));
  host.poll(); await host.flush();
  assert.equal(toggle().props.checked, true);
  service.cfg.plannerReads = 'products';
  service.status.settings.plannerReads = 'products';
  service.status.runtime.pending_settings = null;
  host.poll(); await host.flush();
  assert.ok(text(host.tree).includes('规划端读取范围： 只读 Codex 的产物'));
  toggle().props.onChange(false); await host.flush();
  await click(host, '立即生效');
  assert.equal(host.requests.filter((r) => r.body).length, 1);
  await click(host, '确认立即生效');
  assert.deepEqual(host.requests.filter((r) => r.body).at(-1),
    { path: '/settings/apply', body: { changes: { plannerReads: 'open' }, confirm: true } });
  host.poll(); await host.flush();
  assert.equal(toggle().props.checked, false);
  assert.ok(text(host.tree).includes('规划端读取范围： 不限制读取'));
  assert.ok(!nodes(host.tree).some((node) => ['input', 'select', 'checkbox'].includes(node.type) && /白名单|额外允许/.test(node.props.label || '')));
});

test('pending editing merges previous changes, replaces them on save, and preserves running values', async (t) => {
  const service = panelService();
  service.status.runtime.pending_settings = { changes: { model: 'pending-model', gemini: { model: 'gemini-new' } }, saved_at: 'now' };
  const host = clientHost(service.handle); t.after(() => host.dispose());
  host.mount(host.exports.Panel); await host.flush();
  assert.equal(field(host, 'Codex 模型').props.value, 'pending-model');
  await change(host, '执行时的思考程度', 'max');
  await click(host, '等当前任务结束后自动生效');
  assert.deepEqual(host.requests.find((r) => r.body).body, { model: 'pending-model', gemini: { model: 'gemini-new' }, effort: 'max' });
  assert.ok(text(host.tree).includes('等 2 个 Codex 任务结束后自动生效'));
  assert.ok(text(host.tree).includes('当前模型： old-model'));
  await change(host, 'Codex 模型', 'unsaved-model');
  await click(host, '撤销这次修改');
  assert.equal(field(host, 'Codex 模型').props.value, 'unsaved-model', 'cancel keeps unsaved edits');
  assert.equal(service.status.runtime.pending_settings, null);
});

test('immediate settings require a second click and send the confirmed patch', async (t) => {
  const service = panelService(), host = clientHost(service.handle); t.after(() => host.dispose());
  host.mount(host.exports.Panel); await host.flush(); await change(host, 'Codex 模型', 'new-model');
  await click(host, '立即生效');
  assert.equal(host.requests.filter((r) => r.body).length, 0);
  assert.ok(text(host.tree).includes('Codex 后台任务会继续运行，重载后会自动接回'));
  assert.ok(text(host.tree).includes('正在进行的 DeepSeek 回合可能被中止，包括正在等待模型回复的回合'));
  assert.ok(text(host.tree).includes('要保留当前回合，请选择等空闲生效'));
  await click(host, '先不生效');
  assert.equal(host.requests.filter((r) => r.body).length, 0);
  await click(host, '立即生效');
  await click(host, '确认立即生效');
  assert.deepEqual(host.requests.find((r) => r.body), { path: '/settings/apply', body: { changes: { model: 'new-model' }, confirm: true } });
});

test('failed pending settings remain visible during editing, can be retried, and can be fully reverted', async (t) => {
  const service = panelService();
  service.status.runtime.pending_settings = { changes: { model: 'pending-model' }, error: '文件被占用，请稍后重试。', saved_at: 'now' };
  const host = clientHost(service.handle); t.after(() => host.dispose());
  host.mount(host.exports.Panel); await host.flush();
  assert.ok(text(host.tree).includes('保存设置的文件正被占用，请稍后重试'));
  await click(host, '等当前任务结束后自动生效');
  assert.deepEqual(host.requests.find((r) => r.body).body, { model: 'pending-model' });
  await change(host, 'Codex 模型', 'old-model');
  await click(host, '等当前任务结束后自动生效');
  assert.deepEqual(host.requests.filter((r) => r.body).at(-1), { path: '/settings/cancel', body: {} });
  assert.ok(!text(host.tree).includes('有修改等待生效'));
});

test('polls and saved errors keep drafts; all filters read the separate 24-hour count', async (t) => {
  const service = panelService(), host = clientHost(service.handle); t.after(() => host.dispose());
  host.mount(host.exports.Panel); await host.flush();
  await change(host, 'Codex 模型', 'draft-model');
  for (const filter of ['待关注', '正在跑', '全部']) {
    const before = host.requests.filter((r) => r.path === '/attention').length;
    await click(host, filter);
    assert.ok(host.requests.filter((r) => r.path === '/attention').length > before);
    assert.ok(text(host.tree).includes('最近 24 小时内需要关注的任务： 3'));
    assert.ok(text(host.tree).includes('包含历史任务'));
  }
  service.saveError = { error: 'ENOENT profile secret-stack', saved: true };
  await click(host, '等当前任务结束后自动生效');
  assert.equal(field(host, 'Codex 模型').props.value, 'draft-model');
  assert.ok(text(host.tree).includes('内容已保存，但后续处理没有完成'));
  assert.ok(!text(host.tree).includes('secret-stack'));
  assert.ok(text(host.tree).includes('当前模型： old-model'));
  host.poll(); await host.flush();
  assert.equal(field(host, 'Codex 模型').props.value, 'draft-model');
});

test('standalone status exposes pending errors, hides internal errors and disallows cancellation after write', () => {
  const { Status } = clientHost().exports, service = panelService();
  service.status.runtime = { ...service.status.runtime, profile_error: 'ENOENT secret-profile', loaded_error: 'invalid module record',
    active_error: 'runner crashed', pending_settings: { changes: { model: 'new' }, error: '保存失败，请检查文件权限后重试。' } };
  let tree = Status({ status: service.status, attention: 3 });
  assert.ok(text(tree).includes('无法写入设置，请联系维护者检查文件权限后重试'));
  assert.ok(text(tree).includes('撤销这次修改'));
  for (const internal of ['ENOENT', 'secret-profile', 'invalid module record', 'runner crashed']) assert.ok(!text(tree).includes(internal));
  for (const error of ['YAML parse failed at plannerAnswers', '设置失败：Unsupported serviceTier scalar', '保存失败：unexpected hiddenField value']) {
    service.status.runtime.pending_settings.error = error;
    tree = Status({ status: service.status, attention: 3 });
    for (const internal of ['YAML', 'plannerAnswers', 'serviceTier', 'scalar', 'hiddenField']) assert.ok(!text(tree).includes(internal));
    assert.ok(text(tree).includes('请'));
  }
  service.status.runtime.pending_settings.awaiting_load = true;
  tree = Status({ status: service.status, attention: 3 });
  assert.ok(text(tree).includes('设置已写入，等待加载生效'));
  assert.ok(!nodes(tree).some((node) => node.type === 'button' && text(node) === '撤销这次修改'));
});

test('status shows both busy counts, countdown and unknown session status without exposing internal errors', () => {
  const { Status } = clientHost().exports, service = panelService();
  Object.assign(service.status.runtime, { active_sessions: 2,
    idle_wait: { status: 'waiting', deadline_at: '2026-11-11T00:10:00Z', remaining_seconds: 539 } });
  let displayed = text(Status({ status: service.status }));
  for (const value of ['正在执行的任务： 2', '正在运行的 DeepSeek 会话回合： 2',
    '等 2 个 Codex 任务结束，并等 2 个会话的当前一轮结束后自动重新加载', '最长等 10 分钟，剩余 539 秒']) {
    assert.ok(displayed.includes(value), value);
  }
  Object.assign(service.status.runtime, { active_tasks: 0, active_sessions: null, sessions_error: 'agents secret-internal-error' });
  displayed = text(Status({ status: service.status }));
  assert.ok(displayed.includes('正在运行的 DeepSeek 会话回合： 未读到'));
  assert.ok(displayed.includes('确认所有 DeepSeek 会话的当前一轮已结束'));
  assert.ok(displayed.includes('不能执行等空闲重载'));
  assert.ok(!displayed.includes('secret-internal-error'));
});

test('saved waiting state follows session turns and timeout polls, retaining pending settings for retry or cancellation', async (t) => {
  const service = panelService();
  Object.assign(service.status.runtime, { active_tasks: 0, active_sessions: 2 });
  const host = clientHost(service.handle); t.after(() => host.dispose());
  host.mount(host.exports.Panel); await host.flush();
  await change(host, 'Codex 模型', 'new-model');
  await click(host, '等当前任务结束后自动生效');
  assert.ok(text(host.tree).includes('等 2 个会话的当前一轮结束后自动生效'));
  assert.ok(text(host.tree).includes('剩余 600 秒'));
  assert.ok(text(host.tree).includes('当前模型： old-model'));
  service.status.runtime.active_sessions = 1;
  service.status.runtime.idle_wait.remaining_seconds = 17;
  host.poll(); await host.flush();
  assert.ok(text(host.tree).includes('等 1 个会话的当前一轮结束后自动生效'));
  assert.ok(text(host.tree).includes('剩余 17 秒'));
  assert.ok(!text(host.tree).includes('等 2 个会话'));
  service.status.runtime.idle_wait = { ...service.status.runtime.idle_wait, status: 'timed_out', remaining_seconds: 0 };
  service.status.runtime.pending_settings.error = '等待空闲已超过 10 分钟，未请求重载；请重新保存设置、重新请求等空闲，或确认立即生效。';
  host.poll(); await host.flush();
  for (const value of ['已停止自动重载', '待生效修改尚未用于当前任务', '未请求重载；请重新保存设置', '撤销这次修改']) {
    assert.ok(text(host.tree).includes(value), value);
  }
  assert.ok(!text(host.tree).includes('后自动生效。最长等'));
  assert.equal(field(host, 'Codex 模型').props.value, 'new-model');
  assert.equal(host.requests.filter((request) => request.body).length, 1, 'status polling never requests reload');
  await click(host, '等当前任务结束后自动生效');
  assert.ok(text(host.tree).includes('剩余 600 秒'));
  assert.ok(!text(host.tree).includes('已停止自动重载'));
  await click(host, '撤销这次修改');
  assert.equal(service.status.runtime.pending_settings, null);
  assert.ok(!text(host.tree).includes('剩余 600 秒'));
});

test('reload without pending settings refreshes waiting and timed out states, then clears them after application', async (t) => {
  const service = panelService();
  Object.assign(service.status.runtime, { active_tasks: 0, active_sessions: 2 });
  const host = clientHost(service.handle); t.after(() => host.dispose());
  host.mount(host.exports.Panel); await host.flush();
  await click(host, '重新加载插件（等任务结束）');
  assert.ok(text(host.tree).includes('等 2 个会话的当前一轮结束后自动重新加载'));
  assert.ok(text(host.tree).includes('剩余 600 秒'));
  assert.equal(service.status.runtime.pending_settings, null);
  service.status.runtime.idle_wait = { ...service.status.runtime.idle_wait, status: 'timed_out', remaining_seconds: 0 };
  host.poll(); await host.flush();
  assert.ok(text(host.tree).includes('已停止自动重载'));
  assert.ok(text(host.tree).includes('重新请求等空闲'));
  assert.ok(!text(host.tree).includes('后自动重新加载。最长等'));
  assert.equal(host.requests.filter((request) => request.body).length, 1);
  await click(host, '重新加载插件（等任务结束）');
  assert.ok(!text(host.tree).includes('已停止自动重载'));
  Object.assign(service.status.runtime, { active_sessions: 0, idle_wait: null });
  host.poll(); await host.flush();
  assert.ok(text(host.tree).includes('正在运行的 DeepSeek 会话回合： 0'));
  assert.ok(!text(host.tree).includes('剩余 600 秒'));
  assert.ok(!text(host.tree).includes('等 2 个会话'));
});

test('polling reads status every round and the other routes on load, after a change and every fourth round', async (t) => {
  const service = panelService();
  let jobs = [];
  const host = clientHost((path, body) => path.startsWith('/jobs') ? { total: jobs.length, jobs } : service.handle(path, body));
  t.after(() => host.dispose());
  const counts = () => ['/status', '/settings', '/jobs', '/prompt', '/attention']
    .map((route) => host.requests.filter((request) => !request.body &&
      (route === '/jobs' ? request.path.startsWith(route) : request.path === route)).length);
  const poll = async () => { host.poll(); await host.flush(); };
  host.mount(host.exports.Panel); await host.flush();
  assert.deepEqual(counts(), [1, 1, 1, 1, 1]);
  assert.deepEqual([...host.timers.values()].map(({ ms }) => ms), [7000]);
  for (let n = 0; n < 3; n++) await poll();
  assert.deepEqual(counts(), [4, 1, 1, 1, 1], 'three rounds read only the status');
  await poll();
  assert.deepEqual(counts(), [5, 2, 2, 2, 2], 'the fourth round reads everything again');
  jobs = [{ job_id: 'J', title: 'task', status: 'running', execution_status: 'running', started_at: 0 }];
  await click(host, '待关注');
  assert.deepEqual(counts(), [6, 3, 3, 3, 3], 'a filter change reads everything at once');
  await poll();
  assert.deepEqual(counts(), [7, 3, 4, 3, 3], 'a running task keeps the task list on every round');
  jobs = [];
  await poll();
  assert.deepEqual(counts(), [8, 3, 5, 3, 3]);
  await poll();
  assert.deepEqual(counts(), [9, 3, 5, 3, 3], 'once nothing runs the task list returns to the slow cadence');
  await change(host, 'Codex 模型', 'new-model');
  await click(host, '等当前任务结束后自动生效');
  assert.deepEqual(counts(), [10, 4, 6, 4, 4], 'a save reads everything at once');
});

test('status polls carry applied settings into the form between full reads', async (t) => {
  const service = panelService(), host = clientHost(service.handle); t.after(() => host.dispose());
  host.mount(host.exports.Panel); await host.flush();
  service.status.settings.model = 'applied-model';
  host.poll(); await host.flush();
  assert.equal(host.requests.filter((request) => request.path === '/settings').length, 1);
  assert.equal(field(host, 'Codex 模型').props.value, 'applied-model');
});

test('backend messages naming Harness, MiB or KiB reach the user; internal text still falls back', async (t) => {
  const service = panelService();
  const messages = { '/status': '请先登录 DeepSeek Harness 后重试。', '/prompt': '提交的内容超过 1 MiB，请缩短内容后再保存。',
    '/jobs': '自检结果超过 64 KiB，请缩短后重试。', '/settings': '读取 profile_secret 失败，请重试。' };
  const host = clientHost((path, body) => {
    const error = messages[Object.keys(messages).find((route) => path.startsWith(route))];
    return error ? { error } : service.handle(path, body);
  });
  t.after(() => host.dispose());
  host.mount(host.exports.Panel); await host.flush();
  for (const route of ['/status', '/prompt', '/jobs']) assert.ok(text(host.tree).includes(messages[route]), route);
  assert.ok(!text(host.tree).includes('profile_secret'));
});

test('the Codex model and execution effort can be cleared to follow Codex; a Gemini model still needs a name', async (t) => {
  const service = panelService(), host = clientHost(service.handle); t.after(() => host.dispose());
  host.mount(host.exports.Panel); await host.flush();
  assert.ok(nodes(field(host, '执行时的思考程度')).some((node) => node.type === 'option' && node.props.value === '' && text(node) === '跟随 Codex 配置'));
  await change(host, 'Codex 模型', '');
  await change(host, '执行时的思考程度', '');
  assert.ok(!nodes(host.tree).some((node) => node.props?.role === 'alert' && text(node)));
  await click(host, '等当前任务结束后自动生效');
  assert.deepEqual(host.requests.find((request) => request.body), { path: '/settings', body: { model: '', effort: '' } });
  const { settingsPatch } = host.exports;
  assert.deepEqual(plain(settingsPatch({ model: '', effort: '' }, { model: '', effort: '' })), {});
  assert.throws(() => settingsPatch(settings(), { 'gemini.model': '' }), /模型名请填/);
  assert.throws(() => settingsPatch(settings(), { 'gemini.effort': '' }), /请从列表中选择思考程度/);
  assert.throws(() => settingsPatch(settings(), { model: 'a b' }), /模型名请填/);
});

test('prompt sections count effective characters live, show the injected state and save the executor prompt with its kind', async (t) => {
  const service = panelService(), host = clientHost(service.handle); t.after(() => host.dispose());
  host.mount(host.exports.Panel); await host.flush();
  const section = (title) => nodes(host.tree).find((node) => node.type === 'section' && node.props['aria-label'] === title);
  assert.ok(text(section('规划提示词')).includes('已注入系统提示词'));
  assert.ok(text(section('规划提示词')).includes('有效字数：4'));
  assert.ok(text(section('给 Codex 的固定要求')).includes('Codex 每单都会看到；不增加权限'));
  assert.ok(text(section('给 Codex 的固定要求')).includes('有效字数：5'));
  assert.ok(!text(section('给 Codex 的固定要求')).includes('系统提示词'));
  await change(host, '给 DeepSeek 的具体要求', '<!-- 注释\n不算 -->\n  全新的要求😀  \n<!-- 另一段 -->');
  assert.ok(text(section('规划提示词')).includes('有效字数：6（'), 'comments and surrounding whitespace do not count; an emoji is one character');
  assert.ok(!text(host.tree).includes('每个会话每一步都会带上'));
  await change(host, '给 DeepSeek 的具体要求', '字'.repeat(4001));
  assert.ok(text(section('规划提示词')).includes('有效字数：4001'));
  assert.ok(text(section('规划提示词')).includes('这段内容每个会话每一步都会带上'));
  assert.equal(host.requests.filter((request) => request.body).length, 0);
  await change(host, '附在每一单任务书后面的内容', '只改任务点名的文件');
  await click(host, '保存给 Codex 的固定要求');
  assert.deepEqual(host.requests.find((request) => request.body), { path: '/prompt', body: { text: '只改任务点名的文件', kind: 'executor' } });
  assert.ok(text(host.tree).includes('给 Codex 的固定要求已保存。'));
  assert.equal(field(host, '给 DeepSeek 的具体要求').props.value, '字'.repeat(4001), 'the other draft is kept');
  await click(host, '保存规划提示词');
  assert.deepEqual(host.requests.filter((request) => request.body).at(-1), { path: '/prompt', body: { text: '字'.repeat(4001) } });

  const missing = panelService();
  const unavailable = clientHost((path, body) => path === '/prompt?kind=executor'
    ? { error: '给 Codex 的固定要求在当前环境不可用，请在 DSH 中配置规划提示词的保存位置后重试。' }
    : path === '/prompt' ? { text: '原提示词', injected: false } : missing.handle(path, body));
  t.after(() => unavailable.dispose());
  unavailable.mount(unavailable.exports.Panel); await unavailable.flush();
  assert.ok(text(unavailable.tree).includes('给 Codex 的固定要求在当前环境不可用'));
  assert.equal(field(unavailable, '附在每一单任务书后面的内容').props.disabled, true);
  assert.ok(text(unavailable.tree).includes('未注入系统提示词'));
});

test('prompt backups expand on demand and load into the draft without saving', async (t) => {
  const service = panelService();
  const backups = [{ name: 'planner.md.2026-11-14T01-02-03-004Z.11111111-1111-4111-8111-111111111111.bak', savedAt: '2026-11-14T01:02:03.004Z', size: 12 }];
  const host = clientHost((path, body) => path === '/prompt/backups?kind=planner' ? { backups }
    : path.startsWith('/prompt/backup?') ? { text: '备份里的旧要求' } : path === '/prompt/backups?kind=executor' ? { backups: [] } : service.handle(path, body));
  t.after(() => host.dispose());
  host.mount(host.exports.Panel); await host.flush();
  const section = (title) => nodes(host.tree).find((node) => node.type === 'section' && node.props['aria-label'] === title);
  const press = async (title, label) => {
    await nodes(section(title)).find((node) => node.type === 'button' && text(node) === label).props.onClick();
    await host.flush();
  };
  assert.equal(host.requests.some((request) => request.path.startsWith('/prompt/backup')), false, 'backups are not polled');
  await press('规划提示词', '查看历史备份');
  assert.ok(text(section('规划提示词')).includes('12 字节'));
  await press('规划提示词', '载入到编辑框');
  assert.equal(host.requests.at(-1).path, `/prompt/backup?kind=planner&name=${encodeURIComponent(backups[0].name)}`);
  assert.equal(field(host, '给 DeepSeek 的具体要求').props.value, '备份里的旧要求');
  assert.ok(text(host.tree).includes('核对后点保存才会生效'));
  assert.ok(text(host.tree).includes('有未保存的提示词。'));
  assert.equal(host.requests.filter((request) => request.body).length, 0, 'loading a backup never writes');
  await press('规划提示词', '收起历史备份');
  assert.ok(!text(section('规划提示词')).includes('12 字节'));
  await press('给 Codex 的固定要求', '查看历史备份');
  assert.ok(text(section('给 Codex 的固定要求')).includes('还没有历史备份。'));
});

test('the auto-answer section shows waiting time, human-only questions and both actions', async (t) => {
  const service = panelService();
  const pendingQuestion = (id, reason = null) => ({ id, sessionId: 'session-' + id, questions: ['请选择'], waitedMinutes: 4, remainingMinutes: 6, reason });
  const autoAnswer = { enabled: true, available: true, afterMinutes: 10,
    pending: [pendingQuestion('a'), pendingQuestion('b'), pendingQuestion('c', 'risky')],
    recent: [{ at: '2026-01-01T00:00:00Z', sessionId: 'session-old', question: '之前的提问', selected: ['推荐项'], reason: 'marked_recommended', waitedMinutes: 10 }] };
  const host = clientHost((route, body) => {
    if (route === '/auto-answer/action') {
      autoAnswer.pending = body.action === 'answer' ? autoAnswer.pending.filter(({ id }) => id !== body.id)
        : autoAnswer.pending.map((item) => item.id === body.id ? { ...item, reason: 'manual' } : item);
      return { autoAnswer };
    }
    if (route === '/status') return { ...service.status, autoAnswer };
    return service.handle(route, body);
  });
  t.after(() => host.dispose());
  host.mount(host.exports.Panel);
  await host.flush();
  for (const label of ['已开启 · 10 分钟', '已等 4 分钟 · 还有 6 分钟自动代答', '需要你亲自回答（高风险）', '之前的提问', '有推荐标记']) {
    assert.ok(text(host.tree).includes(label), label);
  }
  await click(host, '现在就按推荐回答');
  assert.ok(text(host.tree).includes('已按推荐提交回答。'));
  await click(host, '这条我自己答');
  assert.ok(text(host.tree).includes('需要你亲自回答（已选择自己回答）'));
  assert.deepEqual(host.requests.filter(({ body }) => body), [
    { path: '/auto-answer/action', body: { id: 'a', action: 'answer' } },
    { path: '/auto-answer/action', body: { id: 'b', action: 'manual' } },
  ]);
});

test('status shows guard scope, host access and unknown keys, and folds secondary rows without hiding their errors', () => {
  const { Status } = clientHost().exports, service = panelService();
  const view = (settings = {}, runtime = {}) => Status({ status: { settings: { ...service.status.settings, ...settings },
    runtime: { ...service.status.runtime, ...runtime } } });
  const folded = (tree) => nodes(tree).find((node) => node.type === 'details');
  let tree = view({ roots: [], allowHostAccess: false, unknownConfig: [] });
  for (const value of ['护栏工作区： 未启用护栏', '主机访问： 未开启']) assert.ok(text(tree).includes(value), value);
  assert.ok(!text(tree).includes('不在沙箱内运行'));
  assert.ok(!text(tree).includes('未识别的配置项'));
  assert.equal(text(nodes(folded(tree))[1]), '更多运行信息');
  for (const label of ['加载时间', '已保存的版本', '重新加载', '设置读取', '运行版本读取']) assert.ok(text(folded(tree)).includes(`${label}：`), label);
  for (const label of ['正在运行的版本', '当前模型', '思考程度', '速度档']) {
    assert.ok(text(tree).includes(`${label}：`) && !text(folded(tree)).includes(`${label}：`), `${label} stays outside the fold`);
  }
  tree = view({ roots: ['d:/work', '*'], allowHostAccess: true, defaultHostAccess: false, unknownConfig: ['timoutSeconds', 'modle'] });
  for (const value of ['护栏工作区： 所有会话', '主机访问： 已开启，需逐单指定', 'Codex 不在沙箱内运行',
    '未识别的配置项：timoutSeconds、modle。这些配置没有生效，请核对拼写。']) assert.ok(text(tree).includes(value), value);
  assert.ok(nodes(tree).some((node) => node.props?.className === 'dcc-error' && text(node).includes('未识别的配置项')));
  assert.ok(nodes(tree).some((node) => node.props?.className === 'dcc-warn' && text(node).includes('不在沙箱内运行')));
  tree = view({ roots: ['d:/work', 'e:/docs'], allowHostAccess: true, defaultHostAccess: true });
  for (const value of ['护栏工作区： d:/work、e:/docs', '主机访问： 已开启且默认使用', '当前每一单默认使用']) assert.ok(text(tree).includes(value), value);
  tree = view({}, { profile_error: 'ENOENT secret-profile', loaded_error: 'invalid module record' });
  const alerts = nodes(tree).filter((node) => node.props?.role === 'alert').map(text);
  assert.ok(alerts.some((value) => value.includes('无法读取已保存的设置')) && alerts.some((value) => value.includes('无法读取当前运行版本')));
  assert.equal(nodes(folded(tree)).some((node) => node.props?.role === 'alert'), false, 'the errors are shown outside the fold');
  assert.ok(!text(tree).includes('secret-profile'));
});

test('the environment check runs only on click and shows a missing codex_auth as a hint', async (t) => {
  const service = panelService();
  const host = clientHost((path, body) => path === '/doctor' ? { ok: false, checks: [{ name: 'python', ok: true, detail: '3.12' },
    { name: 'codex_auth', ok: false, detail: 'auth.json 不存在' }, { name: 'bash', ok: false, detail: '找不到 bash' }] } : service.handle(path, body));
  t.after(() => host.dispose());
  host.mount(host.exports.Panel); await host.flush();
  for (let n = 0; n < 5; n++) { host.poll(); await host.flush(); }
  assert.equal(host.requests.some((request) => request.path === '/doctor'), false, 'never polled');
  await click(host, '环境自检');
  assert.equal(host.requests.filter((request) => request.path === '/doctor').length, 1);
  const rows = nodes(host.tree).filter((node) => node.type === 'li' && /^(python|codex_auth|bash)：/.test(text(node)));
  assert.deepEqual(rows.map((node) => [text(node).split(' ')[0], node.props.className]),
    [['python：通过', 'dcc-muted'], ['codex_auth：提示', 'dcc-muted'], ['bash：未通过', 'dcc-error']]);
  assert.ok(text(rows[1]).includes('用 API Key 或自定义提供方时属于正常'));
  assert.ok(text(rows[2]).includes('找不到 bash'));

  const selftest = clientHost(); t.after(() => selftest.dispose());
  selftest.mount(selftest.exports.Panel, { selftest: { finish() {}, read: async (path) => service.handle(path) } }); await selftest.flush();
  assert.equal(nodes(selftest.tree).some((node) => node.type === 'button' && text(node) === '环境自检'), false);
});

test('limits clear to null, retries accept zero, and automatic resume saves as a nested patch', async (t) => {
  const service = panelService();
  Object.assign(service.cfg, { timeoutSeconds: 900, idleTimeoutSeconds: null, retries: 2, maxRunningJobs: null, lockTimeoutSeconds: 30,
    maxStorageMb: null, autoResume: { enabled: true } });
  service.status.settings = structuredClone(service.cfg);
  const host = clientHost(service.handle); t.after(() => host.dispose());
  host.mount(host.exports.Panel); await host.flush();
  for (const label of ['每次尝试的总超时秒数', '空闲超时秒数', '自动重试次数', '同时运行的任务数上限', '等待其他任务的秒数', '任务记录占用空间上限']) {
    assert.equal(field(host, label).props.type, 'number', label);
    assert.match(text(nodes(host.tree).find((node) => node.type === 'label' && text(node).startsWith(label))), /留空表示(不限制|沿用默认)/);
  }
  assert.equal(field(host, '每次尝试的总超时秒数').props.value, '900');
  assert.equal(field(host, '空闲超时秒数').props.value, '');
  await change(host, '每次尝试的总超时秒数', '');
  await change(host, '空闲超时秒数', '120');
  await change(host, '自动重试次数', '0');
  await change(host, '同时运行的任务数上限', '3');
  await change(host, '等待其他任务的秒数', ' ');
  const resume = () => nodes(host.tree).find((node) => node.type === 'checkbox' && node.props.label === '重启后自动续接');
  assert.equal(resume().props.checked, true);
  resume().props.onChange(false); await host.flush();
  assert.equal(resume().props.checked, false);
  await click(host, '等当前任务结束后自动生效');
  assert.deepEqual(host.requests.find((request) => request.body), { path: '/settings', body: { timeoutSeconds: null, idleTimeoutSeconds: 120,
    retries: 0, maxRunningJobs: 3, lockTimeoutSeconds: null, autoResume: { enabled: false } } });
  assert.equal(field(host, '每次尝试的总超时秒数').props.value, '', 'a pending cleared limit shows as empty');
  assert.equal(resume().props.checked, false);

  const { settingsPatch, pendingPatch } = host.exports, current = structuredClone(service.cfg);
  assert.deepEqual(plain(settingsPatch(current, { idleTimeoutSeconds: '', maxRunningJobs: '', retries: '2', 'autoResume.enabled': true })), {});
  assert.deepEqual(plain(pendingPatch(current, { changes: { timeoutSeconds: null, autoResume: { enabled: false } } }, { retries: '' })),
    { timeoutSeconds: null, autoResume: { enabled: false }, retries: null });
  for (const [edit, message] of [[{ timeoutSeconds: '0' }, /超时秒数/], [{ idleTimeoutSeconds: '-1' }, /超时秒数/], [{ retries: '-1' }, /重试次数/],
    [{ retries: '1.5' }, /重试次数/], [{ maxRunningJobs: '0' }, /任务数上限/], [{ maxRunningJobs: '2.5' }, /任务数上限/],
    [{ lockTimeoutSeconds: 'abc' }, /等待秒数/], [{ maxStorageMb: '0' }, /存储上限/]]) assert.throws(() => settingsPatch(current, edit), message);
});

test('recent tasks show what the runner recorded and search by task or session number', async (t) => {
  const service = panelService();
  const jobs = [
    { job_id: '20261114-010203-abcdef', title: '完成的任务', status: 'completed', execution_status: 'completed', started_at: 0, owner: 'session-a',
      cwd: '/mnt/d/work', duration_s: 148.4, criteria_counts: { met: 2, not_met: 1, blocked: 0 }, verification_status: 'needs_changes', updated_at: 5 },
    { job_id: 'J2', title: '在跑的任务', status: 'running', execution_status: 'running', started_at: 0, phase: 'lock_wait', attempt: 2,
      updated_at: 60, criteria_counts: { met: 0, not_met: 0, blocked: 0 } },
    { job_id: 'J3', title: '失败的任务', status: 'failed', execution_status: 'failed', started_at: 0, error_kind: 'timeout' },
    { job_id: 'J4', title: '旧记录', status: 'completed', execution_status: 'completed', started_at: 0 },
  ];
  const host = clientHost((path, body) => path.startsWith('/jobs') ? { total: jobs.length, jobs } : service.handle(path, body));
  t.after(() => host.dispose());
  host.mount(host.exports.Panel); await host.flush();
  const row = (title) => text(nodes(host.tree).find((node) => node.type === 'li' && text(node).includes(title)));
  for (const value of ['会话 session-a', '目录 /mnt/d/work', '耗时 148 秒', '验收 2 通过 / 1 未通过 / 0 受阻', '独立核验 待修正']) {
    assert.ok(row('完成的任务').includes(value), value);
  }
  assert.ok(!row('完成的任务').includes('当前阶段') && !row('完成的任务').includes('最近活动'));
  for (const value of ['当前阶段 排队等待目录写锁（第 2 轮）', '最近活动 ']) assert.ok(row('在跑的任务').includes(value), value);
  assert.ok(!row('在跑的任务').includes('验收 '), 'a running task has no acceptance result yet');
  assert.ok(row('失败的任务').includes('失败原因 timeout'));
  for (const absent of ['会话 ', '目录 ', '耗时 ', '验收 ', '失败原因', '独立核验', '当前阶段', '最近活动']) assert.ok(!row('旧记录').includes(absent), absent);

  const searchBox = () => nodes(host.tree).find((node) => node.type === 'input' && node.props['aria-label'] === '搜索任务');
  searchBox().props.onChange({ target: { value: ' session-a ' } }); await host.flush();
  await click(host, '搜索');
  assert.equal(host.requests.at(-1 - host.requests.slice().reverse().findIndex((request) => request.path.startsWith('/jobs'))).path,
    '/jobs?filter=all&offset=0&q=session-a');
  await click(host, '待关注');
  assert.ok(host.requests.some((request) => request.path === '/jobs?filter=attention&offset=0&q=session-a'), 'the search survives a filter change');
  await click(host, '清除搜索');
  assert.equal(searchBox().props.value, '');
  assert.equal(host.requests.filter((request) => request.path.startsWith('/jobs')).at(-1).path, '/jobs?filter=attention&offset=0');
});

test('the report view switches to the task context, review history and error log as raw pages', async (t) => {
  const requests = [];
  const host = clientHost((path) => {
    requests.push(path);
    const artifact = /&artifact=(\w+)/.exec(path)?.[1] ?? 'report';
    const offset = Number(/&offset=(\d+)/.exec(path)[1]);
    return artifact === 'report' ? { text: JSON.stringify(sample()), next_offset: null, eof: true }
      : { text: `${artifact} 第 ${offset} 段`, next_offset: offset === 0 ? 8000 : null, eof: offset !== 0 };
  });
  t.after(() => host.dispose());
  host.mount(host.exports.Report, { jobId: 'J 1' }); await host.flush();
  assert.match(text(host.tree), /概述.*逐条验收/s);
  await click(host, '错误日志');
  assert.deepEqual(requests.slice(1), ['/output?job_id=J%201&offset=0&limit=8000&artifact=stderr']);
  assert.ok(nodes(host.tree).some((node) => node.type === 'pre' && text(node) === 'stderr 第 0 段'));
  assert.ok(!text(host.tree).includes('不支持易读视图'));
  await click(host, '下一页');
  assert.equal(requests.at(-1), '/output?job_id=J%201&offset=8000&limit=8000&artifact=stderr');
  assert.ok(nodes(host.tree).some((node) => node.type === 'pre' && text(node) === 'stderr 第 8000 段'));
  for (const [label, artifact] of [['任务书与验收', 'context'], ['核验记录', 'review']]) {
    await click(host, label);
    assert.equal(requests.at(-1), `/output?job_id=J%201&offset=0&limit=8000&artifact=${artifact}`);
    assert.ok(nodes(host.tree).some((node) => node.type === 'pre' && text(node) === `${artifact} 第 0 段`));
  }
  await click(host, '报告');
  assert.equal(requests.at(-1), '/output?job_id=J%201&offset=0&limit=8000');
  assert.match(text(host.tree), /概述.*逐条验收/s);
});

test('Gemini writing records appear only when Gemini is configured', async (t) => {
  const service = panelService();
  const entries = [{ at: '2026-11-14T01:02:03Z', output: 'D:\\docs\\第二章.md', status: 'failed', chars: 5200, error: 'output 超过 max_chars=4000',
    draft_path: 'C:\\drafts\\a.md' }, { at: '2026-11-14T00:00:00Z', output: 'D:\\docs\\第一章.md', status: 'completed', chars: 2400, error: null, draft_path: null }];
  const handler = (path, body) => path === '/gemini' ? { entries } : service.handle(path, body);
  const host = clientHost(handler); t.after(() => host.dispose());
  host.mount(host.exports.Panel); await host.flush();
  const section = (h) => nodes(h.tree).find((node) => node.type === 'section' && node.props['aria-label'] === 'Gemini 写作记录');
  for (const value of ['D:\\docs\\第二章.md', '失败', '5200 字', '失败原因：output 超过 max_chars=4000', '草稿：C:\\drafts\\a.md',
    'D:\\docs\\第一章.md', '成功', '2400 字']) assert.ok(text(section(host)).includes(value), value);
  assert.ok(text(section(host)).indexOf('第二章') < text(section(host)).indexOf('第一章'), 'newest first as returned');
  service.cfg.gemini = null; service.status.settings.gemini = null;
  const plainHost = clientHost(handler); t.after(() => plainHost.dispose());
  plainHost.mount(plainHost.exports.Panel); await plainHost.flush();
  assert.equal(section(plainHost), undefined);
});

test('session operations confirm before acting as the user, post the request bodies and show recent results', async (t) => {
  const service = panelService();
  const results = { send: { completedAt: '2026-11-14T01:02:03.000Z', sessionId: 'session-a', status: 'sent', reason: 'message_submitted' },
    resume: { completedAt: '2026-11-14T01:02:03.000Z', status: 'processed', sessions: [{ sessionId: 'session-b', status: 'skipped', reason: 'running' }] },
    goal: null, autoresume: null };
  const host = clientHost((path, body) => path === '/session/results' ? results : path.startsWith('/session/') ? { submitted: true } : service.handle(path, body));
  t.after(() => host.dispose());
  host.mount(host.exports.Panel); await host.flush();
  const section = nodes(host.tree).find((node) => node.type === 'section' && node.props['aria-label'] === '会话操作');
  assert.equal(section.children[0].type, 'details', 'folded by default');
  assert.equal(nodes(host.tree).filter((node) => node.type === 'section').at(-1), section, 'the last section');
  const posts = () => host.requests.filter((request) => request.body);
  await change(host, '发送到的会话编号', 'session-a');
  await change(host, '要发送的消息', ' 接着做\n');
  nodes(host.tree).find((node) => node.type === 'checkbox' && node.props.label === '会话正在运行时排到它的下一轮').props.onChange(true); await host.flush();
  await click(host, '向会话发送消息');
  assert.equal(posts().length, 0, 'nothing is sent before the confirmation');
  assert.ok(text(host.tree).includes('这会以用户身份向该会话提交这条消息'));
  await click(host, '先不发送');
  assert.equal(posts().length, 0);
  await click(host, '向会话发送消息');
  await click(host, '确认发送');
  assert.deepEqual(posts().at(-1), { path: '/session/send', body: { sessionId: 'session-a', message: ' 接着做\n', queue: true } });
  assert.ok(text(host.tree).includes('请求已提交，稍后点“查看最近结果”确认处理情况。'));
  await change(host, '要续接的会话编号', 'session-a, session-b，session-c  session-d');
  await click(host, '续接被中断的会话');
  assert.equal(posts().length, 1, 'resuming also waits for the confirmation');
  assert.ok(text(host.tree).includes('这会以用户身份让这些会话接着做'));
  await click(host, '先不续接');
  assert.equal(posts().length, 1);
  await click(host, '续接被中断的会话'); await click(host, '确认续接');
  assert.deepEqual(posts().at(-1), { path: '/session/resume', body: { sessions: ['session-a', 'session-b', 'session-c', 'session-d'] } });
  await change(host, '续接时发送的话', '接着上次的做');
  await click(host, '续接被中断的会话'); await click(host, '确认续接');
  assert.deepEqual(posts().at(-1).body, { sessions: ['session-a', 'session-b', 'session-c', 'session-d'], message: '接着上次的做' });
  await change(host, '要改 Goal 的会话编号', 'session-a');
  assert.equal(button(host, '修改会话 Goal').props.disabled, true, 'a Goal change needs an objective or a round budget');
  await change(host, '新的轮数上限', '20');
  await click(host, '修改会话 Goal');
  assert.equal(posts().length, 3);
  assert.ok(text(host.tree).includes('这会以用户身份改写该会话当前 Goal'));
  await click(host, '确认修改');
  assert.deepEqual(posts().at(-1), { path: '/session/goal', body: { sessionId: 'session-a', maxGoalRounds: 20 } });
  await change(host, '新的目标', '写完第三章');
  await click(host, '修改会话 Goal'); await click(host, '确认修改');
  assert.deepEqual(posts().at(-1).body, { sessionId: 'session-a', objective: '写完第三章', maxGoalRounds: 20 });
  assert.equal(host.requests.some((request) => request.path === '/session/results'), false, 'results are read on request only');
  await click(host, '查看最近结果');
  const shown = text(nodes(host.tree).find((node) => node.type === 'pre' && node.props['aria-label'] === '最近的会话操作结果'));
  for (const value of ['：sent / message_submitted', '会话 session-a', 'session-b：skipped / running', '修改 Goal：暂无结果', '重启后自动续接：暂无结果']) {
    assert.ok(shown.includes(value), value);
  }

  const selftest = clientHost(); t.after(() => selftest.dispose());
  selftest.mount(selftest.exports.Panel, { selftest: { finish() {}, read: async (path) => service.handle(path) } }); await selftest.flush();
  for (const title of ['会话操作', '给 Codex 的固定要求']) {
    assert.equal(nodes(selftest.tree).some((node) => node.type === 'section' && node.props['aria-label'] === title), false, title);
  }
  assert.equal(selftest.requests.length, 0);
});

test('a hidden page skips its reads but keeps the timer; the next visible round reads normally', async (t) => {
  const service = panelService(), page = { hidden: true };
  const host = clientHost(service.handle, { document: page }); t.after(() => host.dispose());
  host.mount(host.exports.Panel); await host.flush();
  assert.equal(host.requests.length, 0);
  assert.deepEqual([...host.timers.values()].map(({ ms }) => ms), [7000]);
  host.poll(); await host.flush();
  assert.equal(host.requests.length, 0);
  assert.equal(host.timers.size, 1);
  page.hidden = false;
  host.poll(); await host.flush();
  assert.deepEqual(host.requests.map((request) => request.path).sort(),
    ['/attention', '/gemini', '/jobs?filter=all&offset=0', '/prompt', '/prompt?kind=executor', '/settings', '/status'],
    'the first visible round is a full read');
  page.hidden = true;
  host.poll(); await host.flush();
  assert.equal(host.requests.length, 7);
  page.hidden = false;
  host.poll(); await host.flush();
  assert.deepEqual(host.requests.slice(7).map((request) => request.path), ['/status']);

  const reads = [];
  const selftest = clientHost(undefined, { document: { hidden: true } }); t.after(() => selftest.dispose());
  selftest.mount(selftest.exports.Panel, { selftest: { finish() {}, read: async (path) => { reads.push(path); return service.handle(path); } } });
  await selftest.flush();
  assert.equal(reads.length, 5, 'the offscreen selftest reads once even when the window is hidden');
});

test('task rows describe the recorded diff, a rollback and the runner activity text; the report can show the diff', async (t) => {
  const service = panelService();
  const done = { status: 'completed', execution_status: 'completed', started_at: 0 };
  const jobs = [{ ...done, job_id: 'J1', title: '有改动', diff_status: 'captured', diff_files: 4 },
    { ...done, job_id: 'J2', title: '已回滚', diff_status: 'captured', diff_files: 2, rolled_back_at: 1800000000 },
    { ...done, job_id: 'J3', title: '没改动', diff_status: 'empty' }, { ...done, job_id: 'J4', title: '没记录', diff_status: 'skipped' },
    { ...done, job_id: 'J5', title: '不是仓库', diff_status: 'not_git' }, { ...done, job_id: 'J6', title: '太大', diff_status: 'too_large' },
    { ...done, job_id: 'J7', title: '旧任务' },
    { job_id: 'J8', title: '在跑有文字', status: 'running', execution_status: 'running', started_at: 0, updated_at: 60, last_activity: '正在运行 npm test' },
    { job_id: 'J9', title: '在跑没文字', status: 'running', execution_status: 'running', started_at: 0, updated_at: 60, diff_status: 'captured' }];
  const host = clientHost((path, body) => path.startsWith('/jobs') ? { total: jobs.length, jobs } : service.handle(path, body));
  t.after(() => host.dispose());
  host.mount(host.exports.Panel); await host.flush();
  const item = (title) => nodes(host.tree).find((node) => node.type === 'li' && text(node).includes(title));
  const hasRollback = (title) => nodes(item(title)).some((node) => node.type === 'button' && text(node) === '回滚这单的改动');
  for (const [title, value] of [['有改动', '改动 diff 4 个文件'], ['已回滚', '已回滚 '], ['没改动', '没有文件改动'], ['没记录', '这一单没有记录改动 diff'],
    ['不是仓库', '任务目录不是 git 仓库，没有记录改动 diff'], ['太大', '改动太大，没有记录 diff'], ['在跑有文字', '最近活动 正在运行 npm test']]) {
    assert.ok(text(item(title)).includes(value), `${title}: ${value}`);
  }
  assert.ok(text(item('已回滚')).includes(new Date(1800000000000).toLocaleString('zh-CN')));
  assert.ok(!/diff|回滚/.test(text(item('旧任务'))));
  assert.match(text(item('在跑没文字')), /最近活动 \d/, 'falls back to the last update time');
  assert.deepEqual(['有改动', '已回滚', '没改动', '没记录', '不是仓库', '太大', '旧任务', '在跑有文字', '在跑没文字'].filter(hasRollback), ['有改动'],
    'only a finished task with a recorded diff that was not rolled back can be rolled back');

  const requests = [];
  const report = clientHost((path) => { requests.push(path); return { text: 'diff --git a/x b/x', next_offset: null, eof: true }; });
  t.after(() => report.dispose());
  report.mount(report.exports.Report, { jobId: 'J1' }); await report.flush();
  await click(report, '改动 diff');
  assert.equal(requests.at(-1), '/output?job_id=J1&offset=0&limit=8000&artifact=diff');
  assert.ok(nodes(report.tree).some((node) => node.type === 'pre' && text(node) === 'diff --git a/x b/x'));
});

test('rollback checks first, then asks again before undoing the task, and shows a refusal as returned', async (t) => {
  const service = panelService();
  const job = { job_id: 'J1', title: '有改动', status: 'completed', execution_status: 'completed', started_at: 0, diff_status: 'captured', diff_files: 4 };
  let refuse = null;
  const host = clientHost((path, body) => path.startsWith('/jobs') ? { total: 1, jobs: [{ ...job }] }
    : path === '/rollback' ? refuse ? { error: refuse } : { job_id: 'J1', rolled_back: !body.check, checked: true, files: 4 } : service.handle(path, body));
  t.after(() => host.dispose());
  host.mount(host.exports.Panel); await host.flush();
  const posts = () => host.requests.filter((request) => request.body);
  const has = (label) => nodes(host.tree).some((node) => node.type === 'button' && text(node) === label);
  await click(host, '回滚这单的改动');
  assert.equal(posts().length, 0);
  assert.ok(text(host.tree).includes('只撤销这一单在任务目录里的文件改动，不动提交记录'));
  assert.equal(has('确认回滚'), false, 'the real rollback is offered only after a passed check');
  await click(host, '先不回滚');
  assert.equal(has('检查能否回滚'), false);
  await click(host, '回滚这单的改动');
  refuse = '这些文件在任务之后又被改过，不能自动回滚，没有改动任何文件。请查看改动记录后手动处理。';
  await click(host, '检查能否回滚');
  assert.deepEqual(posts(), [{ path: '/rollback', body: { job_id: 'J1', confirm: true, check: true } }]);
  assert.ok(text(host.tree).includes(refuse));
  assert.equal(has('确认回滚'), false);
  refuse = null;
  await click(host, '检查能否回滚');
  assert.ok(text(host.tree).includes('检查通过，可以回滚 4 个文件。确定现在回滚吗？'));
  assert.equal(posts().length, 2);
  await click(host, '确认回滚');
  assert.deepEqual(posts().at(-1), { path: '/rollback', body: { job_id: 'J1', confirm: true } });
  assert.ok(text(host.tree).includes('已回滚这一单的改动，正在刷新列表。'));
  assert.equal(has('确认回滚'), false);

  const selftest = clientHost(); t.after(() => selftest.dispose());
  selftest.mount(selftest.exports.Panel, { selftest: { finish() {},
    read: async (path) => path.startsWith('/jobs') ? { total: 1, jobs: [{ ...job }] } : service.handle(path) } });
  await selftest.flush();
  const rollback = nodes(selftest.tree).find((node) => node.type === 'button' && text(node) === '回滚这单的改动');
  await rollback.props.onClick(); await selftest.flush();
  await nodes(selftest.tree).find((node) => node.type === 'button' && text(node) === '检查能否回滚').props.onClick(); await selftest.flush();
  assert.equal(selftest.requests.length, 0, 'the selftest never posts a rollback');
});

test('tool policy, allowlist, readable paths, session limits and diff recording save through the settings patch', async (t) => {
  const service = panelService();
  Object.assign(service.cfg, { toolPolicy: 'denylist', allowTools: ['codex_run'], plannerReadAllow: ['E:\\project\\RULES.md'], plannerReadAllowCount: 1,
    maxSessionJobs: null, maxSessionTokens: 2000000, jobDiff: false, seenTools: ['mcp__notes__search', 'web_fetch'] });
  service.status.settings = structuredClone(service.cfg);
  const host = clientHost(service.handle); t.after(() => host.dispose());
  host.mount(host.exports.Panel); await host.flush();
  assert.ok(text(host.tree).includes('额外允许读取的路径： 1 条'), 'the status row with the count stays');
  assert.equal(field(host, '白名单工具').props.value, 'codex_run');
  assert.equal(field(host, '额外允许读取的路径').type, 'textarea');
  assert.equal(field(host, '额外允许读取的路径').props.value, 'E:\\project\\RULES.md');
  assert.deepEqual(nodes(field(host, '工具放行方式')).filter((node) => node.type === 'option').map((node) => [node.props.value, text(node)]),
    [['denylist', '按拒绝名单（默认）'], ['allowlist', '只放行白名单内的工具']]);
  const warning = () => nodes(host.tree).some((node) => node.props?.className === 'dcc-warn' && text(node).includes('未列入白名单的工具在受护栏会话里会被拒绝'));
  assert.equal(warning(), false);
  await change(host, '工具放行方式', 'allowlist');
  assert.equal(warning(), true);
  const seen = (tool) => nodes(host.tree).find((node) => node.type === 'li' && nodes(node).some((child) => child.type === 'span' && text(child) === tool));
  assert.ok(text(host.tree).includes('这些工具在受护栏会话里出现过，白名单模式下会被拒绝'));
  await nodes(seen('web_fetch')).find((node) => node.type === 'button').props.onClick(); await host.flush();
  assert.equal(field(host, '白名单工具').props.value, 'codex_run\nweb_fetch', 'adding only changes the draft');
  assert.equal(host.requests.filter((request) => request.body).length, 0);
  assert.equal(nodes(seen('web_fetch')).find((node) => node.type === 'button').props.disabled, true);
  await change(host, '白名单工具', ' codex_run \n\nweb_fetch\r\n mcp__docs__* \n');
  await change(host, '额外允许读取的路径', 'E:\\project\\RULES.md\n\n /mnt/e/project/review-inputs \n\\\\server\\share\\notes');
  await change(host, '每个会话最多派几单', '20');
  await change(host, '每个会话的用量上限（token）', '');
  const diff = () => nodes(host.tree).find((node) => node.type === 'checkbox' && node.props.label === '记录每单的改动 diff');
  assert.equal(diff().props.checked, false);
  diff().props.onChange(true); await host.flush();
  await click(host, '等当前任务结束后自动生效');
  assert.deepEqual(host.requests.find((request) => request.body), { path: '/settings', body: { toolPolicy: 'allowlist',
    allowTools: ['codex_run', 'web_fetch', 'mcp__docs__*'],
    plannerReadAllow: ['E:\\project\\RULES.md', '/mnt/e/project/review-inputs', '\\\\server\\share\\notes'],
    maxSessionJobs: 20, maxSessionTokens: null, jobDiff: true } });
  assert.equal(field(host, '白名单工具').props.value, 'codex_run\nweb_fetch\nmcp__docs__*', 'pending lists show one entry per line');

  const { settingsPatch, pendingPatch } = host.exports, current = structuredClone(service.cfg);
  assert.deepEqual(plain(settingsPatch(current, { allowTools: 'codex_run\n', plannerReadAllow: ' E:\\project\\RULES.md ', maxSessionJobs: '' })), {});
  assert.deepEqual(plain(settingsPatch(current, { allowTools: '', plannerReadAllow: '' })), { allowTools: [], plannerReadAllow: [] });
  assert.deepEqual(plain(settingsPatch(current, { plannerReadAllow: 'C:\\a,b\nD:\\c' })), { plannerReadAllow: ['C:\\a,b', 'D:\\c'] });
  assert.deepEqual(plain(pendingPatch(current, { changes: { allowTools: ['a', 'b'], toolPolicy: 'allowlist' } }, { allowTools: 'a\nb\nc' })),
    { allowTools: ['a', 'b', 'c'], toolPolicy: 'allowlist' });
  for (const [edit, message] of [[{ allowTools: 'has space' }, /白名单工具/], [{ allowTools: 'a'.repeat(121) }, /白名单工具/],
    [{ allowTools: Array.from({ length: 201 }, (_, n) => `t${n}`).join('\n') }, /白名单工具/], [{ plannerReadAllow: 'relative\\path' }, /路径/],
    [{ plannerReadAllow: `C:\\${'a'.repeat(500)}` }, /路径/], [{ plannerReadAllow: Array.from({ length: 51 }, (_, n) => `C:\\p${n}`).join('\n') }, /路径/],
    [{ toolPolicy: 'open' }, /工具放行方式/], [{ maxSessionJobs: '0' }, /最多派几单/], [{ maxSessionJobs: '1.5' }, /最多派几单/],
    [{ maxSessionTokens: '-1' }, /用量上限/]]) assert.throws(() => settingsPatch(current, edit), message);

  const selftest = clientHost(); t.after(() => selftest.dispose());
  const reads = [];
  selftest.mount(selftest.exports.Panel, { selftest: { finish() {}, read: async (path) => { reads.push(path); return service.handle(path); } } });
  await selftest.flush();
  assert.ok(text(selftest.tree).includes('白名单工具'), 'the new settings render in the selftest');
  assert.deepEqual(reads.sort(), ['/attention', '/jobs?filter=all&offset=0', '/prompt', '/settings', '/status'], 'without any new read');
  assert.equal(selftest.requests.length, 0);
});

test('a background Gemini record is labelled', async (t) => {
  const service = panelService();
  const entries = [{ id: 'G2', at: '2026-11-14T01:02:03Z', output: 'D:\\docs\\后台.md', status: 'completed', chars: 10, background: true },
    { id: 'G1', at: '2026-11-14T00:00:00Z', output: 'D:\\docs\\前台.md', status: 'completed', chars: 10, background: false }];
  const host = clientHost((path, body) => path === '/gemini' ? { entries } : service.handle(path, body)); t.after(() => host.dispose());
  host.mount(host.exports.Panel); await host.flush();
  const row = (name) => text(nodes(host.tree).find((node) => node.type === 'li' && text(node).includes(name)));
  assert.ok(row('后台.md').includes(' · 后台'));
  assert.ok(!row('前台.md').includes(' · 后台'));
});

test('the hand-over section submits from suggestions, prompts and links, and explains refusals in plain words', async (t) => {
  const service = panelService();
  service.status.handover = { mode: 'confirm',
    suggestions: [{ sessionId: 'session-big', cwd: 'D:\\work', messages: 6200, suggest: true }],
    prompts: [{ sessionId: 'session-big', kind: 'ask', at: '2026-11-17T01:00:00.000Z', messages: 6200 }],
    links: [{ from: 'session-old', to: 'session-new', at: '2026-11-17T02:00:00.000Z', origin: 'auto', autoContinue: 'manual_required' }],
    result: { status: 'refused', reason: 'jobs_running', from: 'session-big', running: ['J1', 'J2'], origin: 'panel' },
    recent: [{ at: '2026-11-17T02:00:00.000Z', action: 'handover', from: 'session-old', to: 'session-new', origin: 'auto', status: 'handed_over' }] };
  const host = clientHost((path, body) => path.startsWith('/handover/') ? (body.accept === false ? { declined: true } : { submitted: true }) : service.handle(path, body));
  t.after(() => host.dispose());
  host.mount(host.exports.Panel); await host.flush();
  const section = () => nodes(host.tree).find((node) => node.type === 'section' && node.props['aria-label'] === '会话交接');
  const shown = () => text(section());
  for (const value of ['空闲时询问，同意后交接', 'session-big', 'D:\\work · 6200 条消息', 'session-old → session-new', '自动交接',
    '当前有 2 个 Codex 任务在运行，结束后再交接。', '最近的交接记录']) assert.ok(shown().includes(value), value);
  const posts = () => host.requests.filter((request) => request.body);
  // 建议列表：点开填一句下一步，确认后才提交。
  await click(host, '交接到新会话');
  assert.equal(posts().length, 0, 'nothing is sent before the confirmation');
  await change(host, '给新会话的下一步（可空）', '先收尾 J1');
  await click(host, '确认交接');
  assert.deepEqual(posts().at(-1), { path: '/handover/request', body: { sessionId: 'session-big', note: '先收尾 J1' } });
  assert.ok(shown().includes('交接请求已提交'));
  // 询问：同意 / 暂不交接。
  await click(host, '同意交接');
  assert.deepEqual(posts().at(-1), { path: '/handover/answer', body: { sessionId: 'session-big', accept: true } });
  await click(host, '暂不交接');
  assert.deepEqual(posts().at(-1), { path: '/handover/answer', body: { sessionId: 'session-big', accept: false } });
  assert.ok(shown().includes('冷却期内不再询问'));
  // 撤回先确认；被继任会话已开工拦下后，显示原因并给出带 force 的二次确认。
  await click(host, '撤回');
  await click(host, '确认撤回');
  assert.deepEqual(posts().at(-1), { path: '/handover/request', body: { revert: { from: 'session-old', to: 'session-new' } } });
  assert.equal(nodes(section()).some((node) => node.type === 'button' && text(node) === '仍然撤回（两个会话会并行）'), false);
  service.status.handover = { ...service.status.handover, result: { status: 'rejected', reason: 'successor_active', from: 'session-old', to: 'session-new', newTurns: 3 } };
  host.poll(); await host.flush();
  assert.ok(shown().includes('继任会话已有 3 个新回合，撤回会造成两个会话并行。'));
  await click(host, '仍然撤回（两个会话会并行）');
  assert.deepEqual(posts().at(-1), { path: '/handover/request', body: { revert: { from: 'session-old', to: 'session-new' }, force: true } });
  service.status.handover = { ...service.status.handover, result: { status: 'handed_over', from: 'session-big', to: 'session-n2', origin: 'confirm', steps: { autoContinue: 'manual_required' } } };
  host.poll(); await host.flush();
  assert.ok(shown().includes('已交接：session-big → session-n2，来自询问后同意。请在界面把旧会话 session-big 的“自动继续”开关关掉。'));
});

test('the hand-over section warns about queued input and shows self-check problems and automatic rollbacks prominently', async (t) => {
  const service = panelService();
  service.status.handover = { mode: 'confirm', suggestions: [{ sessionId: 'session-big', messages: 6200, suggest: true }],
    prompts: [{ sessionId: 'session-big', kind: 'ask', at: '2026-11-17T01:00:00.000Z', messages: 6200 }], links: [], recent: [],
    result: { status: 'handed_over_with_issues', from: 'session-big', to: 'session-n', origin: 'panel', steps: {},
      checks: { goal: 'ok', settings: 'failed:differs:model', jobs: 'skipped:no_open_jobs', delivered: 'ok', predecessorFrozen: 'ok' } } };
  const host = clientHost((path, body) => service.handle(path, body));
  t.after(() => host.dispose());
  host.mount(host.exports.Panel); await host.flush();
  const section = () => nodes(host.tree).find((node) => node.type === 'section' && node.props['aria-label'] === '会话交接');
  const hint = '旧会话输入框里还有排队未发的消息的话，请先发出或清空——它们不会跟到新会话。';
  assert.equal(text(section()).split(hint).length - 1, 1, 'the question carries the hint');
  await click(host, '交接到新会话');
  assert.equal(text(section()).split(hint).length - 1, 2, 'the confirmation carries it too');
  const checks = nodes(section()).find((node) => node.type === 'ul' && node.props['aria-label'] === '交接自检');
  assert.ok(text(checks).includes('预设、模型、权限和工作目录一致：有问题（differs:model）'));
  assert.ok(text(checks).includes('新会话能查到待处理的任务：跳过（no_open_jobs）'));
  assert.ok(nodes(section()).some((node) => node.props?.className === 'dcc-warn' && text(node).includes('交接后自检有问题')));
  service.status.handover = { ...service.status.handover, result: { status: 'rolled_back', from: 'session-big', to: 'session-n', origin: 'auto',
    rollback: { reason: 'delivery_failed', status: 'reverted' } } };
  host.poll(); await host.flush();
  assert.ok(text(section()).includes('交接已自动撤回：交接单没能送到新会话，session-big 恢复原状，session-n 不再作为继任会话，来自自动交接。'));
});

test('the hand-over section names the workspace of each successor and explains an approved hand-over waits for the next turn boundary', async (t) => {
  const service = panelService();
  service.status.handover = { mode: 'confirm', suggestions: [], scheduled: [],
    prompts: [{ sessionId: 'session-big', kind: 'ask', at: '2026-11-17T01:00:00.000Z', messages: 6200 }],
    links: [{ from: 'session-old', to: 'session-new', at: '2026-11-17T02:00:00.000Z', origin: 'auto', workspace: 'Seep-Reverse-Lab' },
      { from: 'session-x', to: 'session-y', at: '2026-11-17T02:00:00.000Z', origin: 'panel' }],
    recent: [{ at: '2026-11-17T03:00:00.000Z', action: 'repair', from: 'session-old', to: 'session-new', origin: 'startup', status: 'repaired', workspace: 'Seep-Reverse-Lab' }],
    result: { status: 'handed_over', from: 'session-old', to: 'session-new', steps: {}, checks: { workspace: 'ok' } } };
  const host = clientHost((path, body) => path === '/handover/answer' ? { scheduled: true } : service.handle(path, body));
  t.after(() => host.dispose());
  host.mount(host.exports.Panel); await host.flush();
  const section = () => text(nodes(host.tree).find((node) => node.type === 'section' && node.props['aria-label'] === '会话交接'));
  assert.ok(section().includes('自动交接 · 分组 Seep-Reverse-Lab'));
  assert.ok(!section().includes('面板 · 分组'), 'no workspace name when it is unknown');
  assert.ok(section().includes('启动修复 · repaired · 分组 Seep-Reverse-Lab'));
  assert.ok(section().includes('新会话在原会话的分组里：通过'));
  await click(host, '同意交接');
  assert.ok(section().includes('已同意：会话停在两个回合之间时自动交接'));
});
