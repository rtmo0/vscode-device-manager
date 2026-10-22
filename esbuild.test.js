/* Bundles test/*.test.ts into out/test for node --test. */
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const testDir = path.join(__dirname, 'test');
const entries = fs
  .readdirSync(testDir)
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => path.join(testDir, name));

fs.rmSync(path.join(__dirname, 'out', 'test'), { recursive: true, force: true });

esbuild
  .build({
    entryPoints: entries,
    outdir: path.join(__dirname, 'out', 'test'),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    external: ['vscode'],
    logLevel: 'warning'
  })
  .catch(() => process.exit(1));
