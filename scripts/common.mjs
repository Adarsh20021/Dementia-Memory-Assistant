// Shared helpers for the cross-platform (Windows / macOS / Linux) scripts.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const isWin = process.platform === 'win32';
export const VENV = path.join(ROOT, 'face-service', '.venv');
export const venvPython = () => path.join(VENV, isWin ? 'Scripts\\python.exe' : 'bin/python');

/** Finds a system Python 3.10+ to create the virtual environment with. */
export function findSystemPython() {
  const candidates = isWin ? [['py', ['-3']], ['python', []], ['python3', []]] : [['python3', []], ['python', []]];
  for (const [cmd, pre] of candidates) {
    const r = spawnSync(cmd, [...pre, '-c', 'import sys; print(sys.version_info[:2] >= (3, 10))'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === 'True') return [cmd, pre];
  }
  return null;
}

/** Python to run the face service with: the venv if it exists, otherwise the system one. */
export function pythonCmd() {
  if (existsSync(venvPython())) return [venvPython(), []];
  return findSystemPython();
}

// npm/npx are .cmd shims on Windows and need a shell; real executables (python.exe) must
// NOT go through a shell so paths with spaces keep working.
const needsShell = (cmd) => isWin && ['npm', 'npx'].includes(cmd);

export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: needsShell(cmd), cwd: ROOT, ...opts });
  if (r.status !== 0) {
    console.error(`\n✗ Command failed: ${cmd} ${args.join(' ')}`);
    process.exit(r.status ?? 1);
  }
}

const COLORS = { face: 35, api: 36, web: 32 };
/** Starts a long-running process with prefixed, coloured output. */
export function start(name, cmd, args, opts = {}) {
  const child = spawn(cmd, args, { cwd: ROOT, shell: needsShell(cmd), env: { ...process.env, FORCE_COLOR: '1' }, ...opts });
  const prefix = `\x1b[${COLORS[name] ?? 37}m[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) out.write(prefix + l + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  return child;
}

/** Reads KEY=value pairs from server/.env (for sharing FACE_SERVICE_SECRET). */
export async function readServerEnv() {
  const { readFile } = await import('node:fs/promises');
  try {
    const text = await readFile(path.join(ROOT, 'server', '.env'), 'utf8');
    return Object.fromEntries(
      text
        .split(/\r?\n/)
        .filter((l) => l && !l.startsWith('#') && l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
    );
  } catch {
    return {};
  }
}
