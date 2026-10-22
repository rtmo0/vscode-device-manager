/* eslint-disable @typescript-eslint/no-var-requires */
const esbuild = require('esbuild');
const path = require('path');

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

async function main() {
  const options = {
    entryPoints: [path.join(__dirname, 'src', 'extension.ts')],
    bundle: true,
    outfile: path.join(__dirname, 'dist', 'extension.js'),
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: !production,
    minify: production,
    logLevel: 'info'
  };

  if (watch) {
    const context = await esbuild.context(options);
    await context.watch();
    console.log('[esbuild] watching…');
  } else {
    await esbuild.build(options);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
