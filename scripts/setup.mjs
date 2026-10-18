// One-time setup, no Docker needed:  npm run setup
//  1. installs server + client packages
//  2. creates face-service/.venv, installs Python packages, downloads the face models
//  3. creates server/.env with freshly generated secrets (never overwrites an existing one)
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, findSystemPython, run, venvPython, VENV } from './common.mjs';

const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  console.error(`Node.js 20 or newer is required (you have ${process.versions.node}).`);
  process.exit(1);
}

console.log('\n▶ 1/3 Installing Node packages (server, client)…');
run('npm', ['install', '--no-audit', '--no-fund'], { cwd: path.join(ROOT, 'server') });
run('npm', ['install', '--no-audit', '--no-fund'], { cwd: path.join(ROOT, 'client') });

console.log('\n▶ 2/3 Setting up the face service (Python)…');
if (!existsSync(venvPython())) {
  const py = findSystemPython();
  if (!py) {
    console.error('Python 3.10+ was not found. Install it from https://www.python.org/downloads/ (tick "Add to PATH"), then run npm run setup again.');
    process.exit(1);
  }
  console.log(`Creating a virtual environment with: ${[py[0], ...py[1]].join(' ')}`);
  // Note: the Windows "py" launcher may print harmless "WARNING: ... entry ignored" lines here.
  run(py[0], [...py[1], '-m', 'venv', VENV]);
}
console.log('Installing Python packages (numpy, OpenCV, onnxruntime, FastAPI) — this can take a few minutes…');
run(venvPython(), ['-m', 'pip', 'install', '--upgrade', 'pip', '--disable-pip-version-check']);
run(venvPython(), [
  '-m',
  'pip',
  'install',
  '--disable-pip-version-check',
  '-r',
  path.join(ROOT, 'face-service', 'requirements.txt'),
]);
run(venvPython(), ['-c', 'import cv2, numpy, onnxruntime, fastapi; print("Python packages OK")']);
run(venvPython(), [path.join(ROOT, 'face-service', 'scripts', 'download_models.py')]);

console.log('\n▶ 3/3 Creating server/.env…');
const envPath = path.join(ROOT, 'server', '.env');
if (existsSync(envPath)) {
  console.log('server/.env already exists — left unchanged.');
} else {
  let text = await readFile(path.join(ROOT, 'server', '.env.example'), 'utf8');
  const set = (key, value) => {
    text = text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
  };
  set('JWT_ACCESS_SECRET', randomBytes(48).toString('base64url'));
  set('ENCRYPTION_KEY', randomBytes(32).toString('hex'));
  set('FACE_SERVICE_SECRET', randomBytes(24).toString('hex'));
  await writeFile(envPath, text, 'utf8');
  console.log('Created server/.env with new secrets.');
  console.log('⚠  Back up ENCRYPTION_KEY somewhere safe: without it, stored photos and notes cannot be read.');
}

console.log(`
✓ Setup complete.

Next:
  1. Make sure MongoDB is running (Windows: services.msc → "MongoDB Server" → Running).
  2. Optional: add GROQ_API_KEY and GROQ_MODEL to server/.env for Groq sentences.
  3. npm run seed      (demo caregiver + 3 fictional people)
  4. npm run dev       (opens http://localhost:5173)
`);
