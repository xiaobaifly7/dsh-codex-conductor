// 会话交接：后继会话继承前任会话的 Codex 任务归属。别名只由本机请求文件建立，不向模型开放。
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const validSessionId = (id) => typeof id === 'string' && id.length >= 1 && id.length <= 100 && !/[^A-Za-z0-9_-]/.test(id);

export function writeJsonAtomic(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

// handover.json：{ links: { "<后继>": { from: "<前任>", at } } }。每个前任最多一个后继，可成链 A→B→C。
// 每次读文件而不缓存：热重载后的新实例和请求处理看到的是同一份记录，文件很小。
export function createAliases(directory) {
  const file = directory && path.join(directory, 'handover.json');
  const read = () => {
    if (!file) return {};
    try {
      const links = JSON.parse(fs.readFileSync(file, 'utf8')).links;
      return links && typeof links === 'object' && !Array.isArray(links) ? links : {};
    } catch { return {}; }
  };
  const predecessors = (id, links = read()) => {
    const chain = [];
    for (let current = id; links[current] && validSessionId(links[current].from) && !chain.includes(links[current].from) &&
      links[current].from !== id;) chain.push(current = links[current].from);
    return chain;
  };
  const successor = (id, links = read()) => Object.keys(links).find((to) => links[to]?.from === id);
  return {
    file,
    predecessors: (id) => (validSessionId(id) ? predecessors(id) : []),
    owners: (id) => (validSessionId(id) ? [id, ...predecessors(id)] : []),
    successor: (id) => (validSessionId(id) ? successor(id) : undefined),
    link(from, to) {
      if (!file) throw new Error('no local state directory');
      if (!validSessionId(from) || !validSessionId(to) || from === to) throw new Error('invalid session ids');
      const links = read();
      if (links[to]) throw new Error(`${to} already took over ${links[to].from}`);
      const taken = successor(from, links);
      if (taken) throw new Error(`${from} was already handed over to ${taken}`);
      if (predecessors(from, links).includes(to)) throw new Error(`${to} is a predecessor of ${from}`);
      fs.mkdirSync(directory, { recursive: true });
      writeJsonAtomic(file, { links: { ...links, [to]: { from, at: new Date().toISOString() } } });
    },
    unlink(from, to) {
      const links = read();
      if (links[to]?.from !== from) throw new Error(`${to} did not take over ${from}`);
      delete links[to];
      writeJsonAtomic(file, { links });
    },
  };
}
