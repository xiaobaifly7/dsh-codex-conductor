import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, lstatSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay, setImmediate as yieldTurn } from 'node:timers/promises';

export const QUERY_TIMEOUT_MS = 10_000;

export async function queryWithTimeout(query, signal, timeoutMs = QUERY_TIMEOUT_MS) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(Object.assign(
    new Error(`查询超过 ${timeoutMs / 1000} 秒未返回，请检查任务服务后重试。`),
    { code: 'query_timeout', status: 504 })), timeoutMs);
  try {
    return await Promise.race([
      new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })),
      query(controller.signal),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function modulePath(moduleUrl) {
  const url = new URL(moduleUrl);
  if (url.protocol !== 'file:') throw new Error('Runtime module must be a file URL');
  const pathname = path.posix.normalize(decodeURIComponent(url.pathname));
  const key = `${url.hostname}${pathname}`;
  return url.hostname || /^\/[a-z]:\//i.test(pathname) ? key.toLowerCase() : key;
}

function git(directory, args) {
  const result = spawnSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', directory, ...args], {
    encoding: 'utf8', timeout: 1500, maxBuffer: 64 * 1024, windowsHide: true,
  });
  return !result.error && result.status === 0 ? result.stdout.trim() : null;
}

// Call at the importing module's top level and keep that snapshot as loadedIdentity.
export function runtimeIdentity(moduleUrl) {
  const module = new URL(moduleUrl).href;
  modulePath(module);
  const directory = path.dirname(fileURLToPath(module));
  let version = null;
  try {
    const pkg = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
    if (typeof pkg.version === 'string' && pkg.version) version = pkg.version;
  } catch {}
  const head = git(directory, ['rev-parse', '--verify', 'HEAD']);
  const status = git(directory, ['status', '--porcelain=v1', '--untracked-files=normal']);
  return { module, version, revision: head && /^[a-f0-9]{40,64}$/i.test(head) ? head : null,
    dirty: status === null ? null : status !== '' };
}

export function loadedRecord(loadedFile) {
  try {
    if (!loadedFile) throw new Error('loadedFile is not configured');
    const record = JSON.parse(readFileSync(loadedFile, 'utf8').replace(/^\uFEFF/, ''));
    if (!record || typeof record.module !== 'string' || typeof record.loadedAt !== 'string' ||
        !Number.isFinite(Date.parse(record.loadedAt)) || !Number.isInteger(record.pid) || record.pid <= 0) {
      throw new Error('Invalid runtime loaded record (module, loadedAt and pid are required)');
    }
    modulePath(record.module);
    if (record.pid !== process.pid) try {
      process.kill(record.pid, 0); // Check existence without sending a signal.
    } catch (error) {
      if (error.code === 'ESRCH') throw new Error('DeepSeek Harness 进程已退出，无法确认当前加载状态。');
      if (error.code !== 'EPERM') throw error;
    }
    return { record, error: null };
  } catch (error) {
    return { record: null, error: error.message };
  }
}

function decodeProfile(bytes) {
  let encoding = 'utf8';
  let bom = Buffer.alloc(0);
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) bom = bytes.subarray(0, 3);
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf16le'; bom = bytes.subarray(0, 2); }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf16be'; bom = bytes.subarray(0, 2); }
  const body = bytes.subarray(bom.length);
  const text = new TextDecoder(encoding === 'utf8' ? 'utf-8' : encoding === 'utf16le' ? 'utf-16le' : 'utf-16be',
    { fatal: true, ignoreBOM: true }).decode(body);
  if (text.includes('\0')) throw new Error('Unsupported profile encoding');
  const encode = (value) => {
    const buffer = Buffer.from(value, encoding === 'utf8' ? 'utf8' : 'utf16le');
    if (encoding === 'utf16be') buffer.swap16();
    return Buffer.concat([bom, buffer]);
  };
  if (!encode(text).equals(bytes)) throw new Error('Profile encoding cannot be preserved');
  return { text, encode };
}

function scalar(line, key, prefix) {
  const match = new RegExp(`^${prefix}${key}:([ \\t]*)(.*)$`).exec(line.text);
  if (!match) return null;
  const raw = match[2];
  const token = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^'"\s][\s\S]*?)([ \t]+#.*|[ \t]*)$/.exec(raw);
  if (!token) throw new Error(`Unsupported ${key} scalar in plugins list`);
  const value = token[1];
  let decoded = value;
  if (value[0] === '"') decoded = JSON.parse(value);
  else if (value[0] === "'") decoded = value.slice(1, -1).replace(/''/g, "'");
  const quote = /^["']/.test(value) ? value[0] : '';
  return { value: decoded, start: line.start + match[0].length - raw.length, length: value.length,
    render: (next) => quote === '"' ? JSON.stringify(next) : quote === "'" ? `'${next.replace(/'/g, "''")}'` : next };
}

const GENERATED_RUNTIME_ID = /codex-conductor-runtime-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/;
const withoutComment = (value) => value.replace(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[ \t]+#.*$/g,
  (token) => token.trimStart().startsWith('#') ? '' : token);

// shortcut: block plugin lists and Cordis patch insert lists only; reject unsupported forms of our own entry.
function ownEntry(text, moduleUrl, byManagedId = false) {
  const lines = [...text.matchAll(/[^\r\n]+/g)]
    .map((match) => ({ text: match[0], start: match.index }));
  const sections = lines.map((line, i) => /^plugins:[ \t]*(?:#.*)?$/.test(line.text) ? i : -1).filter((i) => i >= 0);
  const first = lines.find((line) => !/^\s*(?:#.*)?$/.test(line.text));
  if (sections.length > 1 || (sections.length === 0 && !/^-(?:[ \t]|$)/.test(first?.text ?? ''))) {
    throw new Error('Expected a block plugins list or Cordis patch list');
  }
  const wanted = modulePath(moduleUrl);
  const containsOwnUrl = (value) => (value.match(/file:[^\s'"<>},]+/g) ?? []).some((url) => {
    try { return modulePath(url) === wanted; } catch { return false; }
  });
  const matches = [];
  function visit(list) {
    const entries = [];
    let indent = null;
    let entry = null;
    for (const line of list) {
      if (/^\s*(?:#.*)?$/.test(line.text)) continue;
      const item = /^( *)-(?:[ \t]|$)/.exec(line.text);
      if (indent !== null && line.text.search(/\S/) < indent) break;
      if (item && (indent === null || item[1].length === indent)) {
        indent = item[1].length;
        entry = { lines: [line], indent };
        entries.push(entry);
      } else if (entry && line.text.search(/\S/) > indent) entry.lines.push(line);
      else if (entry) break;
      else throw new Error('Unsupported plugins list format');
    }
    for (const candidate of entries) {
      const firstPrefix = ' '.repeat(candidate.indent) + '- ';
      const prefix = ' '.repeat(candidate.indent + 2);
      if (new RegExp('^' + firstPrefix + 'insert:[ \\t]*(?:#.*)?$').test(candidate.lines[0].text)) {
        visit(candidate.lines.slice(1));
        continue;
      }
      // Notice generated IDs in unsupported entry shapes, but ignore comments and nested config.
      if (byManagedId && !candidate.lines.some((line, i) => {
        const pad = i === 0 ? firstPrefix : prefix;
        return line.text.startsWith(pad) && (i === 0 || /^(?:id|"id"|'id'):/.test(line.text.slice(pad.length))) &&
          GENERATED_RUNTIME_ID.test(withoutComment(line.text));
      })) continue;
      const nameLines = candidate.lines.map((line, i) => ({ line, i, prefix: i === 0 ? firstPrefix : prefix }))
        .filter((item) => item.line.text.startsWith(item.prefix + 'name:'));
      let name = null;
      for (const item of nameLines) {
        const block = [item.line.text];
        for (const next of candidate.lines.slice(item.i + 1)) {
          if (next.text.search(/\S/) <= candidate.indent + 2) break;
          block.push(next.text);
        }
        let field = null;
        try { field = scalar(item.line, 'name', item.prefix); } catch (error) {
          if (containsOwnUrl(block.join('\n'))) throw error;
          continue;
        }
        let same = false;
        try {
          const key = modulePath(field.value);
          same = !/\s|\\/.test(field.value) && (key === wanted ||
            (byManagedId && path.posix.basename(key) === path.posix.basename(wanted)));
        } catch {}
        if (same) name = field;
        else if (containsOwnUrl(block.join('\n'))) throw new Error('Unsupported runtime name scalar');
      }
      if (!name) {
        if (byManagedId || containsOwnUrl(candidate.lines[0].text)) throw new Error('Unsupported runtime entry format');
        continue;
      }
      const firstId = scalar(candidate.lines[0], 'id', firstPrefix);
      const ids = [firstId, ...candidate.lines.slice(1).map((line) => scalar(line, 'id', prefix))].filter(Boolean);
      const id = byManagedId ? ids.find((field) => field.value.match(GENERATED_RUNTIME_ID)?.[0] === field.value) : firstId;
      if (!id || nameLines.length !== 1 || ids.length !== 1 || !/^[a-zA-Z0-9_-]+$/.test(id.value)) {
        throw new Error('Ambiguous or unsupported runtime entry');
      }
      matches.push({ id, name, lines: candidate.lines, indent: candidate.indent });
    }
  }
  visit(sections.length ? lines.slice(sections[0] + 1) : lines);
  if (matches.length > 1) throw new Error('Expected one runtime entry; found ' + matches.length);
  return matches[0] ?? null;
}

function profileRecord(profileFile, moduleUrl, readRelocated = false) {
  if (!profileFile) throw new Error('profileFile is not configured');
  const bytes = readFileSync(profileFile);
  const decoded = decodeProfile(bytes);
  const exact = ownEntry(decoded.text, moduleUrl);
  const entry = exact ?? (readRelocated ? ownEntry(decoded.text, moduleUrl, true) : null);
  if (!entry) throw Object.assign(new Error('Expected one runtime entry; found 0'), { status: 409 });
  return { bytes, ...decoded, entry, exact: exact !== null };
}

// The caller supplies the deduplicated in-flight runner count and owns idle/now scheduling.
export function runtimeStatus({ moduleUrl, loadedIdentity = null, loadedFile, profileFile, activeTasks = null }) {
  const source = runtimeIdentity(moduleUrl);
  const { record: loaded, error: loaded_error } = loadedRecord(loadedFile);
  let profile_module = null;
  let profile_error = null;
  let profile_error_status = null;
  let can_reload = false;
  try {
    const profile = profileRecord(profileFile, moduleUrl, true);
    profile_module = profile.entry.name.value;
    can_reload = profile.exact;
    if (!can_reload) {
      profile_error = '配置指向另一位置，旧实例不能改写；请在 DeepSeek Harness 中刷新插件。';
      profile_error_status = 409;
    }
  }
  catch (error) { profile_error = error.message; profile_error_status = error.status ?? 500; }
  let state = 'unknown';
  if (loaded) {
    const different = modulePath(loaded.module) !== modulePath(source.module) ||
      (profile_module !== null && profile_module !== loaded.module) ||
      (typeof loaded.version === 'string' && source.version !== null && loaded.version !== source.version) ||
      (typeof loaded.revision === 'string' && source.revision !== null && loaded.revision !== source.revision);
    if (different || loaded.dirty === true || source.dirty === true) state = 'pending';
    else if (profile_module !== null && source.version !== null && source.revision !== null &&
        loaded.version === source.version && loaded.revision === source.revision &&
        loaded.dirty === false && source.dirty === false) state = 'synchronized';
  }
  return { source, instance: loadedIdentity, loaded, loaded_error, profile_module, profile_error,
    ...(profile_error ? { profile_error_status } : {}), active_tasks: activeTasks, state, can_reload };
}

const settingLabels = { model: 'Codex 模型', effort: '执行时的思考程度', readOnlyEffort: '只读任务的思考程度',
  serviceTier: '速度档', plannerAnswers: '自动回答 Codex 的问题', lockTimeoutSeconds: '等待其他任务写完的秒数',
  maxStorageMb: '任务记录上限', plannerReads: '规划端读取范围', gemini: 'Gemini 设置' };

export function validatePanelSettings(value, geminiConfigured = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) {
    throw new Error('请提交要修改的设置');
  }
  const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
  const model = (v) => typeof v === 'string' && /^[A-Za-z0-9._/:-]{1,80}$/.test(v);
  for (const [key, v] of Object.entries(value)) {
    let valid = false;
    if (key === 'model') valid = model(v);
    else if (key === 'effort') valid = efforts.includes(v);
    else if (key === 'readOnlyEffort') valid = v === '' || efforts.includes(v);
    else if (key === 'serviceTier') valid = ['', 'fast', 'ultrafast'].includes(v);
    else if (key === 'plannerAnswers') valid = typeof v === 'boolean';
    else if (key === 'plannerReads') valid = ['open', 'products'].includes(v);
    else if (['lockTimeoutSeconds', 'maxStorageMb'].includes(key)) valid = typeof v === 'number' && Number.isFinite(v) && v > 0;
    else if (key === 'gemini') {
      valid = geminiConfigured && v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0 &&
        Object.entries(v).every(([k, item]) => k === 'model' ? model(item) : k === 'effort' && ['low', 'medium', 'high'].includes(item));
    }
    if (!valid) throw new Error(`${settingLabels[key] ?? '提交的设置'}无效，请检查填写内容后重新保存。`);
  }
  return value;
}

function yamlSetting(value, field) {
  if (typeof value !== 'string') return String(value);
  if (value === '') return "''";
  const rendered = field?.render(value) ?? value;
  if (rendered !== value) return rendered;
  return /^[A-Za-z_/][A-Za-z0-9._/-]*$/.test(value) && !/^(null|true|false|yes|no|on|off)$/i.test(value)
    ? value : JSON.stringify(value);
}

function settingsEdits(profile, changes) {
  const { lines, indent } = profile.entry;
  const pad = ' '.repeat(indent + 2);
  const configs = lines.filter((line) => line.text.startsWith(pad + 'config:'));
  if (configs.length > 1) throw new Error('conductor 配置重复，未保存');
  const newline = /\r\n|\r|\n/.exec(profile.text)?.[0] ?? '\n';
  const edits = [];
  const endOfLine = (line) => line.start + line.text.length;
  const replace = (line, key, prefix, value) => {
    const field = scalar(line, key, prefix);
    if (!field || /^[!&*|>\[{]/.test(field.value)) throw new Error(`不支持 ${key} 的 YAML 写法，未保存`);
    const rendered = yamlSetting(value, field);
    edits.push([{ ...field, render: () => rendered }, value]);
  };
  const insert = (at, text) => edits.push([{ start: at, length: 0, render: () => text }, null]);
  if (!configs.length) {
    validatePanelSettings(changes, false);
    const last = lines.at(-1);
    insert(endOfLine(last), newline + pad + 'config:' + Object.entries(changes)
      .map(([key, value]) => newline + pad + '  ' + key + ': ' + yamlSetting(value)).join(''));
    return edits;
  }
  const config = configs[0];
  if (!new RegExp('^' + pad + 'config:[ \\t]*(?:#.*)?$').test(config.text)) throw new Error('conductor config 必须使用分行 YAML，未保存');
  const start = lines.indexOf(config) + 1;
  const children = [];
  for (const line of lines.slice(start)) {
    if (line.text.search(/\S/) <= indent + 2) break;
    children.push(line);
  }
  const fieldPad = /^ */.exec(children[0]?.text ?? '')[0] || pad + '  ';
  const gemini = children.filter((line) => line.text.startsWith(fieldPad + 'gemini:'));
  validatePanelSettings(changes, gemini.length === 1 && new RegExp('^' + fieldPad + 'gemini:[ \\t]*(?:#.*)?$').test(gemini[0].text));
  let additions = '';
  for (const [key, value] of Object.entries(changes)) {
    if (key === 'gemini') {
      const parent = gemini[0];
      const nested = [];
      for (const line of children.slice(children.indexOf(parent) + 1)) {
        if (line.text.search(/\S/) <= fieldPad.length) break;
        nested.push(line);
      }
      const nestedPad = /^ */.exec(nested[0]?.text ?? '')[0] || fieldPad + '  ';
      let added = '';
      for (const [k, item] of Object.entries(value)) {
        const hits = nested.filter((line) => line.text.startsWith(nestedPad + k + ':'));
        if (hits.length > 1) throw new Error(`gemini.${k} 配置重复，未保存`);
        if (hits.length) replace(hits[0], k, nestedPad, item);
        else added += newline + nestedPad + k + ': ' + yamlSetting(item);
      }
      if (added) insert(endOfLine(parent), added);
      continue;
    }
    const hits = children.filter((line) => line.text.startsWith(fieldPad + key + ':'));
    if (hits.length > 1) throw new Error(`${key} 配置重复，未保存`);
    if (hits.length) replace(hits[0], key, fieldPad, value);
    else additions += newline + fieldPad + key + ': ' + yamlSetting(value);
  }
  if (additions) insert(endOfLine(config), additions);
  return edits;
}

function editedProfile(profile, edits) {
  let text = profile.text;
  for (const [field, value] of edits.sort((a, b) => b[0].start - a[0].start)) {
    text = text.slice(0, field.start) + field.render(value) + text.slice(field.start + field.length);
  }
  return text;
}

export function writeBackedUpFile(file, bytes, expected = readFileSync(file), backup = true) {
  const attributes = lstatSync(file);
  if (!attributes.isFile()) throw new Error('Runtime profile must be a regular file');
  const mode = attributes.mode;
  const token = randomUUID();
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${token}.tmp`);
  const backupFile = backup ? `${file}.${new Date().toISOString().replace(/[:.]/g, '-')}.${token}.bak` : null;
  let created = false;
  try {
    const fd = openSync(temporary, 'wx', mode);
    created = true;
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    if (!readFileSync(file).equals(expected)) throw Object.assign(new Error('文件在保存前已被其他程序修改，请刷新后再试'), { status: 409 });
    if (backupFile) writeFileSync(backupFile, expected, { flag: 'wx', mode });
    renameSync(temporary, file);
    created = false;
  } finally {
    if (created) unlinkSync(temporary);
  }
  return backupFile;
}

export function saveRuntimeSettings({ moduleUrl, profileFile, changes }) {
  const profile = profileRecord(profileFile, moduleUrl);
  const text = editedProfile(profile, settingsEdits(profile, changes));
  const backup = writeBackedUpFile(profileFile, profile.encode(text), profile.bytes);
  return { saved: true, backup };
}

export function requestRuntimeReload({ moduleUrl, profileFile, changes }) {
  modulePath(moduleUrl);
  const profile = profileRecord(profileFile, moduleUrl);
  const token = randomUUID();
  const url = new URL(profile.entry.name.value);
  url.searchParams.set('v', token);
  const expected_module = url.href;
  const requested_revision = runtimeIdentity(moduleUrl).revision;
  const requested_at = new Date().toISOString();
  const edits = [[profile.entry.id, `codex-conductor-runtime-${token}`], [profile.entry.name, expected_module],
    ...(changes ? settingsEdits(profile, changes) : [])];
  const backup = writeBackedUpFile(profileFile, profile.encode(editedProfile(profile, edits)), profile.bytes, Boolean(changes));
  return { expected_module, requested_revision, requested_at, ...(backup ? { backup, saved: true } : {}) };
}

export async function waitForRuntimeLoad({ loadedFile, expectedModule, timeoutMs = 30_000, signal }) {
  modulePath(expectedModule);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError('timeoutMs must be a nonnegative finite number');
  const deadline = performance.now() + timeoutMs;
  while (true) {
    signal?.throwIfAborted();
    const { record: loaded, error } = loadedRecord(loadedFile);
    const confirmed = loaded !== null && loaded.module === expectedModule;
    const remaining = deadline - performance.now();
    if (confirmed || remaining <= 0) {
      return { confirmed, timed_out: !confirmed, expected_module: expectedModule, loaded, error };
    }
    await delay(Math.min(50, remaining), undefined, { signal });
  }
}


const IDLE_WAIT_MS = 10 * 60 * 1000;
const IDLE_TIMEOUT = '等待空闲已超过 10 分钟，未请求重载；请重新保存设置、重新请求等空闲，或确认立即生效。';

export function registerRuntimeTool({ ctx, conductor, moduleUrl, loadedIdentity, profileFile, loadedFile, activeDispatches, dispatchGeneration }) {
  const pendingFile = loadedFile ? path.join(path.dirname(loadedFile), 'pending-settings.json') : '';
  let pendingController;
  let disposed = false;
  let idleWait = null;
  function readPending() {
    if (!pendingFile) return null;
    try {
      const value = JSON.parse(readFileSync(pendingFile, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('记录格式不正确');
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      return { error: `无法读取待生效的设置：${error.message}。请重新保存设置，或撤销这次修改。` };
    }
  }
  function writePending(value) {
    if (!pendingFile) throw new Error('没有可用的本地保存目录，请配置本地数据目录后重试。');
    mkdirSync(path.dirname(pendingFile), { recursive: true });
    const temporary = `${pendingFile}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, pendingFile);
    } catch (error) {
      unlinkSync(temporary);
      throw error;
    }
  }
  function clearPending(id) {
    if (id !== undefined && readPending()?.id !== id) return;
    try { unlinkSync(pendingFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  function pendingView() {
    const value = readPending();
    if (value?.expected_module === moduleUrl || (value?.expected_module && loadedRecord(loadedFile).record?.module === value.expected_module)) {
      clearPending(value.id);
      return null;
    }
    return value && { changes: value.changes, saved_at: value.saved_at, error: value.error,
      ...(value.expected_module ? { awaiting_load: true } : {}) };
  }
  const label = 'Codex runtime · 等待空闲后重载';
  function snapshot(activeTasks, active_error = null) {
    let active_sessions = null;
    let sessions_error = null;
    try {
      const agents = ctx.get?.('agents');
      const sessions = agents.list();
      if (!Array.isArray(sessions)) {
        // Idle reload needs a synchronous final check, with no await gap before writing.
        Promise.resolve(sessions).catch(() => {});
        throw new Error('会话服务未提供同步状态列表');
      }
      active_sessions = sessions.filter((agent) => agent.status === 'running').length;
    } catch (error) { sessions_error = `无法确认 DeepSeek 会话回合状态：${error.message}，请刷新后重试。`; }
    return { ...runtimeStatus({ moduleUrl, loadedIdentity, profileFile, loadedFile, activeTasks }), active_error,
      active_sessions, sessions_error, pending_settings: pendingView(),
      idle_wait: idleWait && { status: idleWait.status, deadline_at: new Date(idleWait.deadline).toISOString(),
        remaining_seconds: Math.max(0, Math.ceil((idleWait.deadline - Date.now()) / 1000)) } };
  }
  const busy = (current, generation) => current.active_tasks !== 0 || current.active_sessions !== 0 || generation !== dispatchGeneration();
  const activeCount = (signal) => queryWithTimeout(async (signal) => {
    const generation = dispatchGeneration();
    const starting = activeDispatches();
    const ids = new Set();
    let offset = 0;
    let total = null;
    do {
      signal?.throwIfAborted();
      const page = await conductor.list({ status: 'running', limit: 100, offset }, signal);
      signal?.throwIfAborted();
      if (page?.error || page?.error_kind || (page?.status !== undefined && page.status !== 'completed') ||
          !Array.isArray(page?.jobs) || (page.offset !== undefined && page.offset !== offset) ||
          !Number.isSafeInteger(page.total) || page.total < 0 || page.jobs.length > 100 ||
          page.jobs.some((job) => typeof job?.job_id !== 'string' || !job.job_id) ||
          (total !== null && page.total !== total) || offset + page.jobs.length > page.total ||
          (page.jobs.length === 0 && offset < page.total)) {
        throw new Error('Cannot confirm active runner tasks: ' + (page?.error ?? page?.error_kind ?? 'invalid or changing pagination'));
      }
      total = page.total;
      for (const job of page.jobs) ids.add(job.job_id);
      offset += page.jobs.length;
      if (offset < total) await yieldTurn(undefined, { signal });
    } while (offset < total);
    // 查询期间取得 job_id 的派发仍计入在途任务，避免误判空闲。
    return { count: Math.max(starting, ids.size + activeDispatches()), generation };
  }, signal);
  const pendingReload = (current) => current.can_reload && current.profile_module !== moduleUrl;
  async function reload(current, signal, changes, pending) {
    signal?.throwIfAborted();
    idleWait = null;
    if (current.state === 'synchronized' && !changes) return { ...current, idle_wait: null, status: 'already_current' };
    const request = pending?.expected_module ? { expected_module: pending.expected_module, saved: true, reused: true } :
      !changes && pendingReload(current) ? { expected_module: current.profile_module, reused: true } :
      requestRuntimeReload({ moduleUrl, profileFile, changes });
    if (pending && !pending.expected_module) writePending({ ...pending, expected_module: request.expected_module });
    const confirmation = await waitForRuntimeLoad({ loadedFile, expectedModule: request.expected_module, signal });
    return { ...snapshot(current.active_tasks, current.active_error), ...request, ...confirmation,
      status: confirmation.confirmed ? 'reloaded' : 'unconfirmed',
      ...(confirmation.confirmed ? {} : { next: '重载请求已提交，尚未确认加载。用 codex_runtime action=status 查询，不要重复重载。' }) };
  }
  async function waitUntilIdle(current, generation, signal, progress, apply, settings = false, deadline = Date.now() + IDLE_WAIT_MS) {
    let observed = current;
    const waiting = idleWait = { status: 'waiting', deadline };
    try {
      for (;;) {
        signal?.throwIfAborted();
        observed = snapshot(observed.active_tasks, observed.active_error);
        if (!settings && observed.state === 'synchronized') return apply(observed);
        if (Date.now() >= deadline) {
          waiting.status = 'timed_out';
          throw Object.assign(new Error(IDLE_TIMEOUT), { code: 'idle_timeout', status: 408 });
        }
        if (observed.sessions_error) throw new Error(observed.sessions_error);
        // Submit synchronously after the final session check: another turn must not start in an await gap.
        if (!busy(observed, generation)) return apply(observed);
        progress?.(`等待 ${observed.active_tasks} 个 Codex 任务结束；等 ${observed.active_sessions} 个会话的当前一轮结束（最多再等 ${Math.ceil((deadline - Date.now()) / 1000)} 秒）`);
        await delay(Math.min(5000, deadline - Date.now()), undefined, { signal });
        const active = await activeCount(signal);
        observed = snapshot(active.count);
        generation = active.generation;
      }
    } finally {
      if (idleWait === waiting && waiting.status !== 'timed_out') idleWait = null;
    }
  }
  async function applyPending(current, signal) {
    const pending = readPending();
    if (!pending) return { ...snapshot(current.active_tasks), status: 'already_current' };
    try {
      signal?.throwIfAborted();
      if (pending.profile_file !== profileFile || pending.module_path !== modulePath(moduleUrl)) {
        throw Object.assign(new Error('待生效的设置属于另一份安装或配置，请撤销后重新保存。'), { status: 409 });
      }
      // Revalidate against the current profile, including Gemini and supported YAML shapes.
      const profile = profileRecord(profileFile, moduleUrl);
      settingsEdits(profile, pending.changes);
      const result = await reload(current, signal, pending.changes, pending);
      if (readPending()?.id === pending.id) {
        if (result.confirmed) clearPending(pending.id);
        else writePending({ ...readPending(), error: '设置已写入，但尚未确认生效。请刷新运行状态；无需重复保存。' });
      }
      return { ...result, pending_settings: pendingView() };
    } catch (error) {
      if (!signal?.aborted && readPending()?.id === pending.id) {
        writePending({ ...readPending(), error: `设置未能生效：${error.message} 请修改后重新保存，或撤销这次修改。` });
      }
      if (signal?.aborted) throw error;
      return { ...snapshot(current.active_tasks), status: 'failed', saved: true, error_status: error.status ?? 500,
        error: pendingView()?.error ?? error.message };
    }
  }
  function startPending(current, generation) {
    if (pendingController || disposed) return;
    const controller = pendingController = new AbortController();
    void (async () => {
      try {
        if (!current) {
          const active = await activeCount(controller.signal);
          current = snapshot(active.count);
          generation = active.generation;
        }
        const pending = readPending();
        if (!pending) return;
        if (!pending.expected_module) {
          const deadline = Date.parse(pending.saved_at) + IDLE_WAIT_MS;
          if (!Number.isFinite(deadline)) throw new Error('待生效设置的保存时间无效，请重新保存。');
          await waitUntilIdle(current, generation, controller.signal, undefined,
            (observed) => applyPending(observed, controller.signal), true, deadline);
        } else await applyPending(current, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) {
          const pending = readPending();
          if (pending) {
            try { writePending({ ...pending, error: `无法自动生效：${error.message} 请刷新状态后重新保存，或撤销这次修改。` }); }
            catch (failure) { ctx.logger?.warn?.(`无法保存待生效设置的错误原因：${failure.message}`); }
          }
        }
      } finally { if (pendingController === controller) pendingController = undefined; }
    })();
  }
  ctx.effect?.(() => () => { disposed = true; pendingController?.abort(); });
  queueMicrotask(() => {
    if (disposed) return;
    const pending = pendingView();
    if (pending && (!pending.error || pending.awaiting_load)) startPending();
  });
  const tool = {
    name: 'codex_runtime',
    description: '查看磁盘源码、实际加载版本、服务档位、网关、默认权限、在途 Codex 任务数及进行中的 DeepSeek 会话回合数。' +
      'reload 默认 when=idle，同时等 Codex 任务结束且所有会话 status 不为 running，最多等 10 分钟；超时不重载，需重新请求。' +
      'when=now 立即重载，可能中止正在进行的 DeepSeek 回合；Codex 后台任务继续运行，重载后按登记记录接回。' +
      '已提交的重载会复用原请求；等到实际加载标记才报告生效。后台取消只停止观察。',
    presentCall: (args) => ({ card: 'generic', kind: args?.action === 'reload' ? 'write' : 'read', title: 'Codex runtime' }),
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['status', 'reload'], default: 'status' },
      when: { type: 'string', enum: ['idle', 'now'], default: 'idle' },
    } },
    output: { schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    cancelPending() {
      const pending = readPending();
      if (pending?.expected_module && pendingView()) throw Object.assign(new Error('设置已写入，不能撤销。请等待加载后再保存新的设置。'), { status: 409 });
      clearPending();
      pendingController?.abort();
      pendingController = undefined;
      idleWait = null;
      return { cancelled: true };
    },
    async execute(args = {}, exec, changes) {
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('codex_runtime: arguments must be an object');
      const { action = 'status', when = 'idle' } = args;
      if (!['status', 'reload'].includes(action)) throw new Error('codex_runtime: invalid action');
      if (!['idle', 'now'].includes(when)) throw new Error('codex_runtime: invalid when');
      let current = null;
      if (action === 'reload' && !profileFile) {
        return { ...snapshot(null), status: 'failed', error_kind: 'profile_not_configured', error_status: 409,
          error: 'runtimeProfileFile 未配置，无法请求重载。' };
      }
      try {
        const deadline = Date.now() + IDLE_WAIT_MS;
        let count = null;
        let generation;
        let active_error = null;
        try {
          // 派发计数可能经历 0→1→0，提交空闲重载前须确认列表对应的代次未变。
          await queryWithTimeout(async (signal) => {
            do {
              ({ count, generation } = await activeCount(signal));
              if (action === 'reload' && when === 'idle' && Date.now() >= deadline) {
                idleWait = { status: 'timed_out', deadline };
                throw Object.assign(new Error(IDLE_TIMEOUT), { code: 'idle_timeout', status: 408 });
              }
              if (action === 'reload' && when === 'idle' && generation !== dispatchGeneration()) {
                await yieldTurn(undefined, { signal });
              }
            }
            while (action === 'reload' && when === 'idle' && generation !== dispatchGeneration());
          }, exec?.signal);
        } catch (error) {
          exec?.signal?.throwIfAborted();
          if (error.code === 'idle_timeout') {
            return { ...snapshot(count), status: 'failed', error_kind: 'idle_timeout', error_status: 408, error: IDLE_TIMEOUT };
          }
          count = null;
          active_error = String(error?.message ?? error);
        }
        current = snapshot(count, active_error);
        if (action === 'status') return { ...current, status: 'status' };
        if (when === 'idle' && current.sessions_error && !pendingReload(current) && (changes || current.state !== 'synchronized')) {
          return { ...current, status: 'failed', error_kind: 'session_status_unavailable', error_status: 503, error: current.sessions_error };
        }
        const idle = !busy(current, generation);
        if (changes) {
          const profile = profileRecord(profileFile, moduleUrl);
          settingsEdits(profile, changes);
          if (active_error && when === 'idle') return { ...current, status: 'failed', error_status: 502, error: active_error };
          if (!pendingFile) {
            if (when === 'now' || idle) return await reload(current, exec?.signal, changes);
            throw Object.assign(new Error('没有可用的本地保存目录，无法保存待生效的设置。请配置本地数据目录后重试。'), { status: 409 });
          }
          writePending({ id: randomUUID(), profile_file: profileFile, module_path: modulePath(moduleUrl),
            changes, saved_at: new Date().toISOString() });
          pendingController?.abort();
          pendingController = undefined;
          idleWait = null;
          if (when === 'now' || idle) {
            return await applyPending(current, exec?.signal);
          }
          startPending(current, generation);
          return { ...snapshot(count, active_error), status: 'waiting_for_idle', saved: true };
        }
        const awaiting = pendingReload(current);
        if (active_error && when === 'idle' && !awaiting) {
          return { ...current, status: 'failed', error_kind: 'active_count_unavailable', error_status: 502, error: active_error };
        }
        if (!current.can_reload) throw Object.assign(new Error(current.profile_error), { status: current.profile_error_status });
        if (awaiting || current.state === 'synchronized' || when === 'now' || idle) {
          return await reload(current, exec?.signal, changes);
        }
        const owner = exec?.agent?.id;
        const jobs = ctx.get?.('jobs');
        if ((owner === undefined && exec?.panel !== true) || !jobs?.start || !jobs?.list) {
          return { ...current, status: 'failed', error_kind: 'native_jobs_unavailable', error_status: 409,
            error: 'Codex 任务或 DeepSeek 回合仍在进行，且无法登记原生后台观察；未请求重载。' };
        }
        const existing = jobs.list(owner).find((job) => job.owner === owner && job.kind === 'codex-runtime' && job.label === label &&
          (job.status === 'running' || job.status === 'stopping'));
        if (existing) return { ...current, status: 'waiting_for_idle', background_job_id: existing.id, reused: true };
        const id = jobs.start({ owner, kind: 'codex-runtime', label,
          run(handle) {
            const controller = new AbortController();
            const signal = controller.signal;
            const done = (async () => {
              try {
                const result = await waitUntilIdle(current, generation, signal, (text) => handle.updateProgress(text),
                  (observed) => reload(observed, signal), false, deadline);
                return { status: 'completed', detail: result.status === 'unconfirmed' ? '重载请求已提交，尚未确认加载' : result.status,
                  result: JSON.stringify(result) };
              } catch (error) {
                const result = { status: signal.aborted ? 'cancelled' : 'failed', error: String(error?.message ?? error),
                  ...(error.code === 'idle_timeout' ? { error_kind: 'idle_timeout' } : {}),
                  ...(signal.aborted ? { note: '仅停止观察；不会取消 Codex，也不会撤销已发出的重载请求。' } : {}) };
                return { status: signal.aborted ? 'killed' : 'failed', detail: result.status, result: JSON.stringify(result) };
              }
            })();
            return { done, cancel: () => controller.abort() };
          },
        });
        return { ...snapshot(count, active_error), status: 'waiting_for_idle', background_job_id: id, reused: false };
      } catch (error) {
        return { ...(current ?? snapshot(null)), status: 'failed', error_kind: exec?.signal?.aborted ? 'aborted' : 'runtime_error',
          error_status: error?.status ?? 500, error: String(error?.message ?? error) };
      }
    },
  };
  ctx.tools.register(tool);
  return tool;
}
