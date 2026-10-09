#!/usr/bin/env node

const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { delimiter, join } = require('node:path');

const env = { ...process.env };
if (!env.HARUYUKI_DEBUG) env.HARUYUKI_DEBUG = '1';

/**
 * Resolve a bun binary this process can actually spawn.
 *
 * `spawn('bun')` works when Bun itself runs this file (Bun resolves the npm
 * `bun.cmd` shim), but `node scripts/dev.cjs` goes through CreateProcess on
 * Windows, which only appends `.exe` — so the shim was invisible and dev mode
 * died with `spawn bun ENOENT`. Look for the real executable instead of the
 * shim, in the same order a shell would.
 */
function resolveBunBinary() {
  const exe = process.platform === 'win32' ? 'bun.exe' : 'bun';
  const candidates = [];

  if (process.versions.bun) {
    // Already running under bun: its own executable is the safest choice.
    candidates.push(process.execPath);
  }

  // `process.env.PATH` reads case-insensitively, but spelling it on a copy of
  // that object is case-sensitive — and Windows spells it `Path`.
  const pathValue =
    Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';

  for (const entry of pathValue.split(delimiter)) {
    if (!entry) continue;
    candidates.push(join(entry, exe));
    // npm shim layout: the launcher is <prefix>/bun.cmd while the executable
    // lives at <prefix>/node_modules/bun/bin/bun.exe.
    candidates.push(join(entry, 'node_modules', 'bun', 'bin', exe));
  }

  if (env.USERPROFILE) {
    candidates.push(join(env.USERPROFILE, '.bun', 'bin', exe));
  }
  if (env.HOME) {
    candidates.push(join(env.HOME, '.bun', 'bin', exe));
  }

  return candidates.find((candidate) => existsSync(candidate)) ?? 'bun';
}

const bunArgs = [
  '--loader=.md:text',
  '--loader=.mdx:text',
  '--loader=.txt:text',
  'run',
  'src/index.ts',
  ...process.argv.slice(2),
];

const child = spawn(resolveBunBinary(), bunArgs, {
  stdio: 'inherit',
  env,
  windowsHide: true,
});

child.on('error', (error) => {
  console.error('failed to launch bun for dev mode:', error.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
