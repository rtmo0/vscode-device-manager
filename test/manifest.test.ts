import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const source = readFileSync(join(root, 'src', 'extension.ts'), 'utf8');
const declared: string[] = manifest.contributes.commands.map((c: { command: string }) => c.command);
const views: string[] = Object.values(manifest.contributes.views as Record<string, { id: string }[]>).flat().map((v) => v.id);

test('every declared command is registered and every registered command is declared', () => {
  const registered = [...source.matchAll(/'(mobile-device-manager\.[A-Za-z]+)':/g)].map((m) => m[1]);
  assert.deepEqual([...declared].sort(), [...new Set(registered)].sort());
});

test('menus refer to declared commands or view focus commands', () => {
  const known = new Set([...declared, ...views.map((id) => `${id}.focus`)]);
  const menuCommands = Object.values(manifest.contributes.menus as Record<string, { command: string }[]>).flat().map((m) => m.command);
  for (const command of menuCommands) {
    assert.ok(known.has(command), `${command} is not declared`);
  }
});

test('settings read by the code are declared', () => {
  const properties = Object.keys(manifest.contributes.configuration.properties);
  assert.deepEqual(properties.sort(), ['mobile-device-manager.adbPath', 'mobile-device-manager.android.rootPath']);
});

test('the manifest uses only characters the Marketplace accepts', () => {
  // The Marketplace rejects lookalike characters (such as U+2011 non-breaking hyphen) as suspicious content.
  const allowed = new Set(['…', '—', '→']);
  const text = readFileSync(join(root, 'package.json'), 'utf8');
  const unusual = [...new Set([...text].filter((ch) => ch.charCodeAt(0) > 127 && !allowed.has(ch)))];
  assert.deepEqual(unusual.map((ch) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`), []);
});
