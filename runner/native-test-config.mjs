import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function prepareNativeTest() {
  if (process.platform !== 'win32') throw new Error('Native migration tests require Windows');
  const config = new URL('../config/', import.meta.url);
  const yaml = readFileSync(new URL('cordis.patch.yml', config), 'utf8');
  const settings = Object.fromEntries([...yaml.matchAll(/^ {8}(\w+): (.+)$/gm)]
    .map(([, key, value]) => [key, value]));
  const { codexHome, runnerHome } = settings;
  const work = path.join(path.dirname(runnerHome), 'work');
  const portable = path.join(settings.pwshDir, 'pwsh.exe');
  mkdirSync(work, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  copyFileSync(new URL('codex.native.toml', config), path.join(codexHome, 'config.toml'));
  return { yaml, settings, work, portable };
}
