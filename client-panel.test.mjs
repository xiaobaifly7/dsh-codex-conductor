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
function clientHost(handler = () => ({})) {
  const slots = [], effects = [], requests = [], timers = new Map();
  let index = 0, dirty = false, root, tree, definition, timerId = 0;
  const react = {
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
    window: { __ModuleLoader__: { load: (value) => { definition = value; } } }, AbortController,
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; }, clearTimeout: (id) => timers.delete(id),
    fetch: async (url, options) => {
      const path = url.replace('/dsh-codex-conductor', '');
      const body = options.body ? JSON.parse(options.body) : undefined;
      requests.push({ path, body });
      const result = await handler(path, body, options.signal);
      return { ok: !result?.error, status: result?.error ? 500 : 200, json: async () => result };
    },
  });
  const exports = definition.factory((name) => name === 'react' ? react : { Button: 'button', Input: 'input', Checkbox: 'checkbox' });
  function render() { index = 0; dirty = false; tree = root(); while (effects.length) effects.shift()(); }
  return {
    exports, requests,
    mount(component, props = {}) { root = () => component(props); render(); },
    async flush() { for (let n = 0; n < 12; n++) { await new Promise(setImmediate); if (dirty) render(); } },
    get tree() { return tree; },
    poll() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } },
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
  return nodes(container).find((node) => ['input', 'select', 'checkbox'].includes(node.type));
};
const change = async (host, label, value) => { field(host, label).props.onChange({ target: { value } }); await host.flush(); };

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

const settings = () => ({ model: 'old-model', effort: 'high', serviceTier: '', plannerAnswers: false, gemini: { model: 'gemini-old', effort: 'medium' } });
function panelService() {
  const service = { cfg: settings(), status: { settings: settings(), runtime: { state: 'synchronized', active_tasks: 2, pending_settings: null } }, saveError: null };
  service.handle = (path, body) => {
    if (body !== undefined) {
      if (service.saveError) return service.saveError;
      if (path === '/settings/cancel') { service.status.runtime.pending_settings = null; return { cancelled: true }; }
      if (path === '/settings/apply') {
        service.cfg = { ...service.cfg, ...body.changes };
        service.status = { settings: service.cfg, runtime: { state: 'synchronized', active_tasks: 2, pending_settings: null } };
        return { saved: true, runtime: { status: 'reloaded', pending_settings: null } };
      }
      const pending = { changes: body, saved_at: '2026-11-11T00:00:00Z' };
      service.status.runtime.pending_settings = pending;
      return { saved: true, runtime: { status: 'waiting_for_idle', active_tasks: 2, pending_settings: pending } };
    }
    if (path === '/status') return structuredClone(service.status);
    if (path === '/settings') return structuredClone(service.cfg);
    if (path === '/prompt') return { text: '原提示词' };
    if (path === '/attention') return { total: 3 };
    if (path.startsWith('/jobs')) return { total: 524, jobs: [] };
    throw new Error(path);
  };
  return service;
}

test('pending editing merges previous changes, replaces them on save, and preserves running values', async (t) => {
  const service = panelService();
  service.status.runtime.pending_settings = { changes: { model: 'pending-model', gemini: { model: 'gemini-new' } }, saved_at: 'now' };
  const host = clientHost(service.handle); t.after(() => host.dispose());
  host.mount(host.exports.Panel); await host.flush();
  assert.equal(field(host, 'Codex 模型').props.value, 'pending-model');
  await change(host, '执行时的思考程度', 'max');
  await click(host, '等当前任务结束后自动生效');
  assert.deepEqual(host.requests.find((r) => r.body).body, { model: 'pending-model', gemini: { model: 'gemini-new' }, effort: 'max' });
  assert.ok(text(host.tree).includes('已保存，等 2 个 Codex 任务结束后自动生效'));
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
  assert.ok(text(host.tree).includes('正在跑的 Codex 任务不会被打断，重载后会自动接回'));
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
