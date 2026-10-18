// Development: face service + API (auto-reload) + React dev server, in one terminal.
//   npm run dev        then open http://localhost:5173
import path from 'node:path';
import { ROOT, pythonCmd, readServerEnv, start } from './common.mjs';

const env = await readServerEnv();
const py = pythonCmd();
if (!py) {
  console.error('Python not found. Run npm run setup first.');
  process.exit(1);
}
if (!env.FACE_SERVICE_SECRET) console.warn('⚠  FACE_SERVICE_SECRET is empty in server/.env — face recognition will not work. Run npm run setup.');

const procs = [
  start('face', py[0], [...py[1], 'run.py'], {
    cwd: path.join(ROOT, 'face-service'),
    env: { ...process.env, FACE_SERVICE_SECRET: env.FACE_SERVICE_SECRET ?? '' },
  }),
  start('api', 'npm', ['run', 'dev'], { cwd: path.join(ROOT, 'server') }),
  start('web', 'npm', ['run', 'dev'], { cwd: path.join(ROOT, 'client') }),
];

console.log('\nStarting… open http://localhost:5173 (Ctrl+C stops everything)\n');
const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => code && code !== 0 && console.error(`A process exited with code ${code}.`));
