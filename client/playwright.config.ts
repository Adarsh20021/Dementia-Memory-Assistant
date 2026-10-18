/**
 * End-to-end happy path on the REAL stack: face service (real models),
 * Express API, built React client, and Chromium with a fake webcam that
 * shows a real face (e2e/fixtures/camera-person.y4m).
 *
 * Needs: MongoDB running locally, face-service Python deps + models, and
 * `npx playwright install chromium` once.
 *   npm run e2e
 * Env overrides: E2E_MONGO_URI, E2E_PYTHON (path to the face-service venv python),
 * PW_CHROMIUM_PATH (use a pre-installed Chromium).
 */
import { defineConfig, devices } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FACE_PORT = 8765;
const API_PORT = 4555;
const SECRET = 'e2e-face-secret-0123456789';
const python =
  process.env.E2E_PYTHON ?? (process.platform === 'win32' ? '.venv\\Scripts\\python' : 'python3');

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${API_PORT}`,
    ...devices['Desktop Chrome'],
    launchOptions: {
      executablePath: process.env.PW_CHROMIUM_PATH || undefined,
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-video-capture=${path.join(here, 'e2e/fixtures/camera-person.y4m')}`,
      ],
    },
    permissions: ['camera'],
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: `${python} run.py`,
      cwd: path.join(here, '../face-service'),
      url: `http://127.0.0.1:${FACE_PORT}/health`,
      env: { FACE_SERVICE_SECRET: SECRET, FACE_PORT: String(FACE_PORT) },
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      command: 'npm --prefix ../client run build && npx tsx src/server.ts',
      cwd: path.join(here, '../server'),
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      env: {
        NODE_ENV: 'development',
        PORT: String(API_PORT),
        MONGO_URI: process.env.E2E_MONGO_URI ?? 'mongodb://127.0.0.1:27017/dma_e2e',
        CLIENT_ORIGINS: `http://127.0.0.1:${API_PORT}`,
        CLIENT_DIST: '../client/dist',
        JWT_ACCESS_SECRET: 'e2e-access-secret-0123456789abcdef0123',
        ENCRYPTION_KEY: 'b'.repeat(64),
        UPLOAD_DIR: './tmp-e2e-uploads',
        FACE_SERVICE_URL: `http://127.0.0.1:${FACE_PORT}`,
        FACE_SERVICE_SECRET: SECRET,
        // A fake webcam shows a still picture, so the head-movement check is switched off here.
        LIVENESS_MODE: 'off',
        GROQ_API_KEY: '',
        GROQ_MODEL: '',
      },
      timeout: 180_000,
      reuseExistingServer: false,
    },
  ],
});
