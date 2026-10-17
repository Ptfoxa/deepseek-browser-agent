import { build as viteBuild } from 'vite';
import { build as esbuild } from 'esbuild';
import { watch } from 'node:fs';
import { cp, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');
const watchMode = process.argv.includes('--watch');

function assertInsideDist(target) {
  const normalized = resolve(target);
  if (normalized !== dist && !normalized.startsWith(dist + '\\') && !normalized.startsWith(dist + '/')) {
    throw new Error(`Refusing to touch a path outside dist: ${normalized}`);
  }
}

async function copyStatic() {
  await cp(resolve(root, 'manifest.json'), resolve(dist, 'manifest.json'));
  await cp(resolve(root, 'icons'), resolve(dist, 'icons'), { recursive: true });
}

async function buildPanel() {
  await viteBuild({
    configFile: resolve(root, 'vite.config.ts'),
    logLevel: 'warn',
  });
  const builtHtml = resolve(dist, 'index.html');
  await rm(resolve(dist, 'sidepanel.html'), { force: true });
  await rename(builtHtml, resolve(dist, 'sidepanel.html'));
}

async function buildScripts() {
  const common = {
    bundle: true,
    minify: true,
    sourcemap: false,
    target: 'chrome114',
    logLevel: 'warning',
    define: {
      'process.env.NODE_ENV': '"production"',
    },
  };
  await esbuild({
    ...common,
    entryPoints: [resolve(root, 'src/background/index.ts')],
    outfile: resolve(dist, 'background.js'),
    format: 'esm',
  });
  await esbuild({
    ...common,
    entryPoints: [resolve(root, 'src/content/index.ts')],
    outfile: resolve(dist, 'content.js'),
    format: 'iife',
  });
}

async function verifyOutput() {
  const required = [
    'manifest.json',
    'background.js',
    'content.js',
    'sidepanel.html',
    'icons/icon-16.png',
    'icons/icon-32.png',
    'icons/icon-48.png',
    'icons/icon-128.png',
  ];
  for (const file of required) {
    const info = await stat(resolve(dist, file));
    if (!info.isFile() || info.size === 0) {
      throw new Error(`Build output missing or empty: ${file}`);
    }
  }
  const manifest = JSON.parse(await readFile(resolve(dist, 'manifest.json'), 'utf8'));
  if (manifest.manifest_version !== 3) {
    throw new Error('Manifest is not MV3');
  }
  const html = await readFile(resolve(dist, 'sidepanel.html'), 'utf8');
  if (!html.includes('script')) {
    throw new Error('Side panel HTML has no script bundle');
  }
  process.stdout.write(`Build complete: ${dist}\n`);
}

async function buildAll(clean) {
  if (clean) {
    assertInsideDist(dist);
    await rm(dist, { recursive: true, force: true });
  }
  await mkdir(dist, { recursive: true });
  await copyStatic();
  await buildPanel();
  await buildScripts();
  await verifyOutput();
}

async function main() {
  await buildAll(!watchMode);
  if (!watchMode) return;

  process.stdout.write('Watching src/ and manifest.json for changes...\n');
  let timer = null;
  let running = false;
  let pending = false;
  const rebuild = async () => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      await buildAll(false);
    } catch (error) {
      process.stderr.write(`Rebuild failed: ${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      running = false;
      if (pending) {
        pending = false;
        void rebuild();
      }
    }
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void rebuild(), 350);
  };
  watch(resolve(root, 'src'), { recursive: true }, schedule);
  watch(resolve(root, 'manifest.json'), schedule);
}

main().catch((error) => {
  process.stderr.write(`Build failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
