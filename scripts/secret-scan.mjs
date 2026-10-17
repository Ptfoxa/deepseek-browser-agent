import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const targets = [
  'src',
  'tests',
  'scripts',
  '.github',
  'docs',
  'dist',
  'README.md',
  'SECURITY.md',
  '.env.example',
  'manifest.json',
];
const skipDirs = new Set(['node_modules', '.git', 'coverage', 'test-results', 'playwright-report']);
const textExtensions = new Set([
  '',
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.json',
  '.html',
  '.css',
  '.md',
  '.yml',
  '.yaml',
  '.example',
]);

const rules = [
  { name: 'deepseek-style-key', pattern: /\bsk-[A-Za-z0-9_-]{24,}\b/g },
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { name: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'private-key-block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'bearer-token-literal', pattern: /Bearer\s+[A-Za-z0-9._-]{28,}/g },
  {
    name: 'assigned-secret',
    pattern: /\b(?:api[_-]?key|secret|token|password)\b\s*[:=]\s*["'][A-Za-z0-9+/=_-]{24,}["']/gi,
  },
];

async function walk(path) {
  const info = await stat(path).catch(() => null);
  if (!info) return [];
  if (info.isFile()) return [path];
  if (!info.isDirectory()) return [];
  const out = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory() && skipDirs.has(entry.name)) continue;
    out.push(...(await walk(join(path, entry.name))));
  }
  return out;
}

const files = [];
for (const target of targets) {
  files.push(...(await walk(resolve(root, target))));
}

const findings = [];
let scanned = 0;
for (const file of files) {
  const ext = extname(file).toLowerCase();
  if (!textExtensions.has(ext)) continue;
  const info = await stat(file);
  if (info.size > 2_000_000) continue;
  const content = await readFile(file, 'utf8').catch(() => '');
  scanned += 1;
  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(content)) {
      findings.push({ file, rule: rule.name });
    }
  }
}

const relative = (file) => file.slice(root.length + 1).replaceAll('\\', '/');
if (findings.length) {
  process.stderr.write('Potential secrets detected. Values are intentionally not printed.\n');
  for (const finding of findings) {
    process.stderr.write(`- ${relative(finding.file)} :: ${finding.rule}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(`Secret scan clean (${scanned} files scanned).\n`);
}
