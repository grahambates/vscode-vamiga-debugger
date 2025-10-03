const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',

  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        console.error(`    ${location.file}:${location.line}:${location.column}:`);
      });
      console.log('[watch] build finished');
    });
  },
};

async function main() {
  // Clean old build output (except for the bundled files we're about to create)
  const fs = require('fs');
  if (fs.existsSync('out') && !watch) {
    const files = fs.readdirSync('out');
    for (const file of files) {
      if (file.endsWith('.js') && !file.startsWith('extension') || 
          file.endsWith('.js.map') && !file.startsWith('extension') ||
          file.endsWith('.d.ts')) {
        try {
          fs.unlinkSync(`out/${file}`);
        } catch (err) {
          // Ignore cleanup errors
        }
      }
    }
  }

  // Build extension
  const extensionCtx = await esbuild.context({
    entryPoints: [
      'src/extension.ts'
    ],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outdir: 'out',
    external: ['vscode'],
    logLevel: 'silent',
    plugins: [
      esbuildProblemMatcherPlugin,
    ],
  });

  // Build webview
  const webviewCtx = await esbuild.context({
    entryPoints: [
      'src/webview/memoryViewer/main.ts'
    ],
    bundle: true,
    format: 'iife',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'browser',
    outdir: 'out/webview',
    logLevel: 'silent',
    plugins: [
      esbuildProblemMatcherPlugin,
    ],
  });
  if (watch) {
    await extensionCtx.watch();
    await webviewCtx.watch();
  } else {
    await extensionCtx.rebuild();
    await webviewCtx.rebuild();
    await extensionCtx.dispose();
    await webviewCtx.dispose();
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});