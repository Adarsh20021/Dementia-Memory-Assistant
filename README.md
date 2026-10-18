# AI-Based Dementia Memory Assistant (Face Recognition)

A voice-enabled memory aid for people living with dementia, with a caregiver dashboard. When a registered, consenting familiar person stands in front of the camera, the patient hears who it is, how they are related, and a gentle reminder of the last visit.

**Recognize → Retrieve context → Recall previous interaction → Communicate simply (text + voice).**

> This is a memory-aid and caregiver-support tool. It is **not** a diagnostic or medical decision-making system.

| Phase | Status |
|---|---|
| 1. Foundation: auth, RBAC, consent, audit | ✅ |
| 2. Face service: enroll, match, quality checks, thresholds | ✅ |
| 3. Patient UI + voice | ✅ |
| 4. Memories, visits, context builder, Groq + fallback | ✅ |
| 5. Caregiver dashboard | ✅ |
| 6. Liveness, security review, evaluation, docs | ✅ |

Tests: **109** server · **16** face service · **1** end-to-end on the real stack. See [docs/evaluation.md](docs/evaluation.md).

---

## Quick start on Windows (no Docker needed)

**You need:**
- **Node.js 20+**
- **Python 3.10–3.12** (tick "Add python.exe to PATH" when installing)
- **MongoDB** running locally (you already have it)

```powershell
cd C:\Users\adars\Desktop\Website
npm run setup     # installs everything, downloads face models, creates server\.env with secrets
npm run seed      # demo caregiver + patient "Ravi" + 3 fictional people
npm run dev       # face service + API + web app together
```

Open **http://localhost:5173** and sign in as `demo@example.com` / `DemoCare123`.

**Check MongoDB:**
- Run `mongosh --eval "db.version()"`; it should print 6.0 or newer.
- If it doesn't connect, open `services.msc`, find "MongoDB Server" and click **Start**.

### Daily use

| Command | What it does |
|---|---|
| `npm run dev` | Development, with auto-reload. App at http://localhost:5173 |
| `npm start` | Production-style: builds, then serves everything from http://localhost:4000 |
| `npm test` | Server tests + face-service tests |
| `npm run test:e2e` | Browser test on the real stack (first run `npx --prefix client playwright install chromium`) |
| `npm run evaluate -- --data <folder>` | FAR / FRR / accuracy report and plot |
| `npm run benchmark` | Face-service CPU latency |
| `npm run lint` / `npm run typecheck` | Code quality |

### First steps in the app

1. **Caregiver → Ravi → People → Priya:** add 3–5 photos (upload, or **Use the camera**).
2. **Set up the patient's device** (Settings → Patient device), easiest first:
   - **One tap:** sign in as the caregiver *on the patient's device* and press **Use this device for the patient**. You are signed out there, and the device opens in patient mode.
   - **PIN:** set a 4–6 digit PIN. If the device is ever signed out, it shows "Welcome back" and a number pad (demo PIN: `2580`).
   - **One-time code:** **Create pairing code**, then type it on the device under **Set up this device**.
   Patient devices stay signed in for 180 days, and every use extends it. Caregiver and patient sessions use separate cookies, so testing both in one browser no longer signs the patient out.
3. **Plan a visit** (Visits), so the patient sees "Priya is coming tomorrow at 4 pm" and can ask "When is Priya coming?". The patient can plan visits too.
4. Have the person stand in front of the camera and press **Who is this?** The patient then sees every shared memory and visit with that person. Each one has **Read aloud** and **Tell me simply** (AI).
5. **Settings → System status → Test AI** checks that the AI key works.

The full walkthrough is in [docs/demo-script.md](docs/demo-script.md).

### Using a tablet or phone for the patient

Browsers only allow the camera on `https://` or on `localhost`.

**Simplest:** run the patient screen on the same laptop.

**For a tablet on your Wi-Fi:**
1. Create a certificate with [mkcert](https://github.com/FiloSottile/mkcert): `mkcert -install`, then `mkcert -key-file server\certs\key.pem -cert-file server\certs\cert.pem <your-laptop-IP> localhost`.
2. In `server\.env`, set:
   - `HOST=0.0.0.0`
   - `HTTPS_KEY_FILE=./certs/key.pem`
   - `HTTPS_CERT_FILE=./certs/cert.pem`
   - `CLIENT_ORIGINS=https://<IP>:4000`
3. Run `npm start` and open `https://<IP>:4000` on the tablet (install the mkcert root certificate on the tablet).

### Docker? Not needed

The native setup above is the recommended way. If you want containers anyway, **Podman Desktop** is a drop-in replacement for Docker Desktop:
1. Run `npm --prefix client run build`.
2. Put `FACE_SERVICE_SECRET=...` in a `.env` file next to `docker-compose.yml`.
3. Run `podman compose up --build`.

---

## API keys

| Key | Needed? | Where |
|---|---|---|
| `GROQ_API_KEY` | Needed for AI summaries ("Tell me simply", "In short", Groq sentences, caregiver drafts) | [console.groq.com/keys](https://console.groq.com/keys) → Create API Key (free tier; starts with `gsk_`). Paste it into `server/.env` and restart. Without it, simple built-in sentences are used and everything else works. |
| `GROQ_MODEL` | Has a default (`llama-3.3-70b-versatile`) | Change it only if Groq retires the model; see [console.groq.com/docs/models](https://console.groq.com/docs/models). |
| `JWT_ACCESS_SECRET`, `ENCRYPTION_KEY`, `FACE_SERVICE_SECRET` | Required, but not API keys | Generated automatically by `npm run setup`. **Back up `ENCRYPTION_KEY`**: losing it makes the encrypted photos and notes unreadable. |

Face models (InsightFace buffalo_s) and speech (the browser's Web Speech API) need no keys.

---

## Project structure

```
client/          React (Vite, TS, Tailwind, React Router, TanStack Query)
  src/pages/patient     Who is this? · notes / remember this · settings
  src/pages/caregiver   overview · people + consent + photos · timeline · review · add memory · settings · audit · evaluation
  src/tts               TTSProvider interface (Web Speech by default; swap in a cloud TTS)
  e2e/                  Playwright happy path (fake webcam with a real face)
server/          Express API (TypeScript, Mongoose, zod, JWT, argon2, helmet, pino)
  src/routes            auth · patients · people · recognition · memories · visits · notes · insights
  src/services          decision logic · context builder · Groq client · guardrails · face client · retention
  prompts/              versioned Groq prompts (patientSummary.md, visitSummaryDraft.md, answerPhrasing.md)
  tests/                Jest + Supertest (mock face service + mock Groq)
face-service/    FastAPI + onnxruntime + OpenCV (SCRFD detector, ArcFace embeddings)
  app/                  engine · quality checks · API
  eval/                 evaluate.py (FAR/FRR/EER + plot) · benchmark.py
  tests/                pytest
scripts/         cross-platform setup / dev / start
docs/            architecture · OpenAPI · security review · evaluation · demo script
```

## Environment variables (`server/.env`)

`npm run setup` creates this file. Every value is validated at startup, and the server refuses to start with a clear message if something is wrong.

| Variable | Default | Purpose |
|---|---|---|
| `MONGO_URI` | `mongodb://127.0.0.1:27017/dementia_assistant` | Database |
| `PORT` / `HOST` | `4000` / `localhost` | Where the API listens (`0.0.0.0` for other devices, with HTTPS) |
| `HTTPS_KEY_FILE` / `HTTPS_CERT_FILE` | — | Enable HTTPS |
| `CLIENT_ORIGINS` | `http://localhost:5173,http://localhost:4000` | CORS allow-list |
| `JWT_ACCESS_SECRET` | generated | Signs 15-minute access tokens |
| `ENCRYPTION_KEY` | generated | AES-256-GCM key for photos, embeddings, notes, memories |
| `ACCESS_TOKEN_TTL_MIN` / `REFRESH_TOKEN_TTL_DAYS` | 15 / 30 | Caregiver session lifetimes |
| `PATIENT_SESSION_DAYS` | 180 | Patient device stays signed in (sliding) |
| `PIN_MAX_FAILURES` / `PIN_LOCKOUT_MIN` | 5 / 15 | Patient PIN lock after wrong tries |
| `LOGIN_MAX_FAILURES` / `LOGIN_LOCKOUT_MIN` | 5 / 15 | Account lockout |
| `PAIRING_CODE_TTL_MIN` | 15 | Patient device code lifetime |
| `ALLOW_REGISTRATION` | true | Set false after creating caregiver accounts |
| `FACE_SERVICE_URL` / `FACE_SERVICE_SECRET` | `http://127.0.0.1:8000` / generated | Internal face service |
| `MATCH_THRESHOLD` / `UNSURE_THRESHOLD` | 0.5 / 0.35 | Name the person / "This may be…" / below = "I don't recognize this person" |
| `RECOG_FRAMES` / `RECOG_FRAMES_REQUIRED` | 5 / 3 | Frames per attempt; how many must agree |
| `RECOG_MARGIN` | 0.05 | Best must beat the runner-up by this much |
| `LIVENESS_MODE` / `LIVENESS_MIN_YAW_RANGE` | motion / 0.06 | Head-movement check (`off` to disable) |
| `MAX_PHOTOS_PER_PERSON` | 5 | Enrollment limit |
| `VISIT_DEDUP_MIN` | 30 | Repeat recognitions within this window are one visit |
| `GROQ_API_KEY` / `GROQ_MODEL` / `GROQ_BASE_URL` | — / `llama-3.3-70b-versatile` / `https://api.groq.com/openai/v1` | Groq |
| `LLM_TIMEOUT_MS` / `LLM_ASK_TIMEOUT_MS` / `LLM_DRAFT_TIMEOUT_MS` | 3000 / 8000 / 15000 | Who-is-this sentence / questions and "Tell me simply" / caregiver drafts |
| `LLM_DAILY_CALL_LIMIT` / `LLM_PER_PATIENT_PER_MIN` | 500 / 6 | Cost caps |
| `RETENTION_JOB_INTERVAL_HOURS` | 6 | Auto-delete old visit records |
| `UPLOAD_DIR` / `CLIENT_DIST` | `./uploads` / `../client/dist` | Encrypted photos / built web app |

The face service reads `FACE_SERVICE_SECRET` from `server/.env`. Its own tuning variables (quality thresholds, `FACE_PORT`, `FACE_HOST`) are listed in `face-service/app/config.py`.

## Key design decisions

- **Face models:** InsightFace's own SCRFD + ArcFace ONNX models run directly on onnxruntime. The compiled `insightface` package needs C++ build tools on Windows, so it isn't used. The models are licensed for non-commercial research.
- **Stateless face service:** Express owns the encrypted embeddings and sends only the current patient's consented candidates, so a cross-patient match is impossible.
- **Decision logic in Express:** at least 3 of 5 frames must agree, the median score is compared with two thresholds, and the head-movement liveness check must pass. It is unit-tested, and the system never guesses.
- **Database first:** answers and context come from MongoDB. Groq only phrases them, under guardrails, with a deterministic template fallback, so the app works fully offline from the LLM.
- **Patient entries:** saved immediately as `pending` and only used after caregiver approval. The original wording is kept in the version history.
- **Patient sign-in:** a one-time pairing code instead of a password.

## Documentation

- [Architecture](docs/architecture.md)
- [API (OpenAPI 3)](docs/openapi.yaml), which you can paste into https://editor.swagger.io
- [Security and privacy review](docs/security.md), including liveness limits
- [Evaluation](docs/evaluation.md): how to get FAR/FRR, latency and SUS numbers, and what was measured
- [Demo script](docs/demo-script.md)

## Notes

- The face-service tests use InsightFace's public sample group photo (`face-service/tests/data/group.jpg`). The end-to-end fixtures are crops of it. Replace them with photos of consenting volunteers if you prefer.
- Test databases: the server tests start a throwaway MongoDB automatically, or set `TEST_MONGO_URI` to use your local one (random databases, dropped afterwards). The e2e test uses `dma_e2e` on your local MongoDB.
