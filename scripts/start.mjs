// Production-style run on one machine: builds the client and server, then serves
// everything from http://localhost:4000 (Express serves the built React app).
//   npm start
import path from 'node:path';
import { ROOT, pythonCmd, readServerEnv, run, start } from './common.mjs';

run('npm', ['run', 'build'], { cwd: path.join(ROOT, 'client') });
run('npm', ['run', 'build'], { cwd: path.join(ROOT, 'server') });

const env = await readServerEnv();
const py = pythonCmd();
if (!py) {
  console.error('Python not found. Run npm run setup first.');
  process.exit(1);
}
const port = env.PORT || '4000';
const procs = [
  start('face', py[0], [...py[1], 'run.py'], {
    cwd: path.join(ROOT, 'face-service'),
    env: { ...process.env, FACE_SERVICE_SECRET: env.FACE_SERVICE_SECRET ?? '' },
  }),
  start('api', 'node', ['dist/server.js'], {
    cwd: path.join(ROOT, 'server'),
    env: { ...process.env, CLIENT_ORIGINS: env.CLIENT_ORIGINS || `http://localhost:${port}` },
  }),
];
console.log(`\nOpen http://localhost:${port}  (Ctrl+C stops everything)\n`);
const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
