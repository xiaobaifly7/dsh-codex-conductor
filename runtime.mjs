import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, lstatSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

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

function loadedRecord(loadedFile) {
  try {
    if (!loadedFile) throw new Error('loadedFile is not configured');
    const record = JSON.parse(readFileSync(loadedFile, 'utf8').replace(/^\uFEFF/, ''));
    if (!record || typeof record.module !== 'string' || typeof record.loadedAt !== 'string' ||
        !Number.isFinite(Date.parse(record.loadedAt)) || !Number.isInteger(record.pid) || record.pid <= 0) {
      throw new Error('Invalid runtime loaded record (module, loadedAt and pid are required)');
    }
    modulePath(record.module);
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
      matches.push({ id, name });
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
  if (!entry) throw new Error('Expected one runtime entry; found 0');
  return { bytes, ...decoded, entry, exact: exact !== null };
}

// The caller supplies the deduplicated in-flight runner count and owns idle/now scheduling.
export function runtimeStatus({ moduleUrl, loadedIdentity = null, loadedFile, profileFile, activeTasks = null }) {
  const source = runtimeIdentity(moduleUrl);
  const { record: loaded, error: loaded_error } = loadedRecord(loadedFile);
  let profile_module = null;
  let profile_error = null;
  let can_reload = false;
  try {
    const profile = profileRecord(profileFile, moduleUrl, true);
    profile_module = profile.entry.name.value;
    can_reload = profile.exact;
    if (!can_reload) profile_error = '配置指向另一位置，旧实例不能改写；请在 DeepSeek Harness 中刷新插件。';
  }
  catch (error) { profile_error = error.message; }
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
    active_tasks: activeTasks, state, can_reload };
}

export function requestRuntimeReload({ moduleUrl, profileFile }) {
  modulePath(moduleUrl);
  const profile = profileRecord(profileFile, moduleUrl);
  const token = randomUUID();
  const url = new URL(profile.entry.name.value);
  url.searchParams.set('v', token);
  const expected_module = url.href;
  const requested_revision = runtimeIdentity(moduleUrl).revision;
  const requested_at = new Date().toISOString();
  const edits = [[profile.entry.id, `codex-conductor-runtime-${token}`], [profile.entry.name, expected_module]];
  let text = profile.text;
  for (const [field, value] of edits.sort((a, b) => b[0].start - a[0].start)) {
    text = text.slice(0, field.start) + field.render(value) + text.slice(field.start + field.length);
  }
  const attributes = lstatSync(profileFile);
  if (!attributes.isFile()) throw new Error('Runtime profile must be a regular file');
  const mode = attributes.mode;
  const temporary = path.join(path.dirname(profileFile), `.${path.basename(profileFile)}.${token}.tmp`);
  let created = false;
  try {
    const fd = openSync(temporary, 'wx', mode);
    created = true;
    try { writeFileSync(fd, profile.encode(text)); fsyncSync(fd); } finally { closeSync(fd); }
    if (!readFileSync(profileFile).equals(profile.bytes)) throw new Error('Profile changed while preparing runtime reload');
    renameSync(temporary, profileFile);
    created = false;
  } finally {
    if (created) unlinkSync(temporary);
  }
  return { expected_module, requested_revision, requested_at };
}

export async function waitForRuntimeLoad({ loadedFile, expectedModule, timeoutMs = 15000, signal }) {
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


export function registerRuntimeTool({ ctx, conductor, moduleUrl, loadedIdentity, profileFile, loadedFile, activeDispatches, dispatchGeneration }) {
  const label = 'Codex runtime · 等待空闲后重载';
  const snapshot = (activeTasks, active_error = null) => ({
    ...runtimeStatus({ moduleUrl, loadedIdentity, profileFile, loadedFile, activeTasks }), active_error,
  });
  async function activeCount(signal) {
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
    } while (offset < total);
    // 查询期间取得 job_id 的派发仍计入在途任务，避免误判空闲。
    return { count: Math.max(starting, ids.size + activeDispatches()), generation };
  }
  async function reload(current, signal) {
    signal?.throwIfAborted();
    if (current.state === 'synchronized') return { ...current, status: 'already_current' };
    const request = requestRuntimeReload({ moduleUrl, profileFile });
    const confirmation = await waitForRuntimeLoad({ loadedFile, expectedModule: request.expected_module, signal });
    return { ...snapshot(current.active_tasks, current.active_error), ...request, ...confirmation,
      status: confirmation.confirmed ? 'reloaded' : 'unconfirmed' };
  }
  return ctx.tools.register({
    name: 'codex_runtime',
    description: '查看磁盘源码、实际加载版本、服务档位、网关、默认权限及在途 Codex 任务数；reload 默认等空闲后重载，when=now 立即请求。' +
      '不会取消或启动 Codex 任务。只有加载标记确认新模块后才报告生效；后台取消只停止观察。',
    presentCall: (args) => ({ card: 'generic', kind: args?.action === 'reload' ? 'write' : 'read', title: 'Codex runtime' }),
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['status', 'reload'], default: 'status' },
      when: { type: 'string', enum: ['idle', 'now'], default: 'idle' },
    } },
    output: { schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(args = {}, exec) {
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('codex_runtime: arguments must be an object');
      const { action = 'status', when = 'idle' } = args;
      if (!['status', 'reload'].includes(action)) throw new Error('codex_runtime: invalid action');
      if (!['idle', 'now'].includes(when)) throw new Error('codex_runtime: invalid when');
      let current = null;
      if (action === 'reload' && !profileFile) {
        return { ...snapshot(null), status: 'failed', error_kind: 'profile_not_configured', error: 'runtimeProfileFile 未配置，无法请求重载。' };
      }
      try {
        let count = null;
        let generation;
        let active_error = null;
        try {
          // 派发计数可能经历 0→1→0，提交空闲重载前须确认列表对应的代次未变。
          do { ({ count, generation } = await activeCount(exec?.signal)); }
          while (when === 'idle' && generation !== dispatchGeneration());
        } catch (error) {
          exec?.signal?.throwIfAborted();
          count = null;
          active_error = String(error?.message ?? error);
        }
        current = snapshot(count, active_error);
        if (action === 'status') return { ...current, status: 'status' };
        if (active_error && when === 'idle') {
          return { ...current, status: 'failed', error_kind: 'active_count_unavailable', error: active_error };
        }
        if (!current.can_reload) throw new Error(current.profile_error);
        if (current.state === 'synchronized' || when === 'now' || current.active_tasks === 0) return await reload(current, exec?.signal);
        const owner = exec?.agent?.id;
        const jobs = ctx.get?.('jobs');
        if (owner === undefined || !jobs?.start || !jobs?.list) {
          return { ...current, status: 'failed', error_kind: 'native_jobs_unavailable',
            error: 'Codex 仍在运行且无法登记原生后台观察；未请求重载。' };
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
                let observed = current;
                while ((observed.active_tasks > 0 || generation !== dispatchGeneration()) && observed.state !== 'synchronized') {
                  handle.updateProgress('等待 Codex 空闲，在途任务数：' + observed.active_tasks);
                  await delay(5000, undefined, { signal });
                  const active = await activeCount(signal);
                  observed = snapshot(active.count);
                  generation = active.generation;
                }
                const result = await reload(observed, signal);
                return { status: result.status === 'unconfirmed' ? 'failed' : 'completed', detail: result.status,
                  result: JSON.stringify(result) };
              } catch (error) {
                const result = { status: signal.aborted ? 'cancelled' : 'failed', error: String(error?.message ?? error),
                  ...(signal.aborted ? { note: '仅停止观察；不会取消 Codex，也不会撤销已发出的重载请求。' } : {}) };
                return { status: signal.aborted ? 'killed' : 'failed', detail: result.status, result: JSON.stringify(result) };
              }
            })();
            return { done, cancel: () => controller.abort() };
          },
        });
        return { ...current, status: 'waiting_for_idle', background_job_id: id, reused: false };
      } catch (error) {
        return { ...(current ?? snapshot(null)), status: 'failed', error_kind: exec?.signal?.aborted ? 'aborted' : 'runtime_error',
          error: String(error?.message ?? error) };
      }
    },
  });
}
