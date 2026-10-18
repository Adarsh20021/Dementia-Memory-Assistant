/**
 * Centralised, validated environment configuration.
 * The app refuses to start if a required variable is missing or malformed,
 * so misconfiguration fails loudly instead of silently weakening security.
 */
import 'dotenv/config';
import { z } from 'zod';

const bool = (def: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(def)
    .transform((v) => v === 'true');

/** Treats an empty value in .env ("GROQ_MODEL=") the same as a missing one. */
const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    /** Interface to listen on. Use 0.0.0.0 to allow other devices on your network (with HTTPS). */
    HOST: z.string().default('localhost'),
    HTTPS_KEY_FILE: z.string().optional(),
    HTTPS_CERT_FILE: z.string().optional(),
    MONGO_URI: z.string().min(1, 'MONGO_URI is required'),
    /** Comma-separated list of browser origins allowed by CORS. */
    CLIENT_ORIGINS: z.string().default('http://localhost:5173'),
    /** Number of reverse proxies in front of the API (for correct client IPs). */
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),

    // --- Auth ---
    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    ACCESS_TOKEN_TTL_MIN: z.coerce.number().int().positive().default(15),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
    /** Patient devices stay signed in this long (sliding: every use extends it). */
    PATIENT_SESSION_DAYS: z.coerce.number().int().positive().default(180),
    /** Patient PIN sign-in: failures before a temporary lock, and lock length. */
    PIN_MAX_FAILURES: z.coerce.number().int().positive().default(5),
    PIN_LOCKOUT_MIN: z.coerce.number().int().positive().default(15),
    LOGIN_MAX_FAILURES: z.coerce.number().int().positive().default(5),
    LOGIN_LOCKOUT_MIN: z.coerce.number().int().positive().default(15),
    PAIRING_CODE_TTL_MIN: z.coerce.number().int().positive().default(15),
    ALLOW_REGISTRATION: bool('true'),

    // --- Encryption at rest (AES-256-GCM): 32 bytes as 64 hex chars ---
    ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 64 hex characters (32 bytes)'),
    UPLOAD_DIR: z.string().default('./uploads'),
    /** Built React app served by Express in production (npm run build in client/). */
    CLIENT_DIST: z.string().default('../client/dist'),

    // --- Face recognition ---
    /** Cosine similarity at/above which we say who it is. */
    MATCH_THRESHOLD: z.coerce.number().min(0).max(1).default(0.5),
    /** Between UNSURE and MATCH we say "This may be ..." and ask the caregiver to confirm. */
    UNSURE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.35),
    /** Frames sent per recognition attempt, and how many must agree. */
    RECOG_FRAMES: z.coerce.number().int().min(1).max(8).default(5),
    RECOG_FRAMES_REQUIRED: z.coerce.number().int().min(1).max(8).default(3),
    /** Best person must beat the runner-up by this much in a frame, else the frame is ambiguous. */
    RECOG_MARGIN: z.coerce.number().min(0).max(1).default(0.05),
    /** "motion": require natural head movement across frames (rejects a flat photo). "off": disabled. */
    LIVENESS_MODE: z.enum(['motion', 'off']).default('motion'),
    LIVENESS_MIN_YAW_RANGE: z.coerce.number().min(0).max(1).default(0.06),
    FACE_SERVICE_URL: z.string().url().default('http://127.0.0.1:8000'),
    FACE_SERVICE_SECRET: z.preprocess(blankToUndefined, z.string().min(16).optional()),
    FACE_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
    MAX_PHOTOS_PER_PERSON: z.coerce.number().int().min(1).max(10).default(5),
    /** A repeat recognition of the same person within this window updates the same visit. */
    VISIT_DEDUP_MIN: z.coerce.number().int().min(0).default(30),

    // --- LLM: Groq (OpenAI-compatible) ---
    GROQ_API_KEY: z.preprocess(blankToUndefined, z.string().optional()),
    /** Fast, free-tier friendly model; check https://console.groq.com/docs/models (names change). */
    GROQ_MODEL: z.preprocess(blankToUndefined, z.string().default('openai/gpt-oss-20b')),
    GROQ_BASE_URL: z.string().url().default('https://api.groq.com/openai/v1'),
    /** Patient-facing latency budget for the LLM; after this we use the template. */
    LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
    /** Answers to questions and "tell me simply" retellings (the text is already on screen). */
    LLM_ASK_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
    /** Caregiver drafting can wait longer. */
    LLM_DRAFT_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
    /** Hard cap on LLM calls per day (all patients). 0 disables the LLM. */
    LLM_DAILY_CALL_LIMIT: z.coerce.number().int().min(0).default(500),
    /** Per patient, per minute. */
    LLM_PER_PATIENT_PER_MIN: z.coerce.number().int().min(1).default(6),

    // --- Data retention job ---
    RETENTION_JOB_INTERVAL_HOURS: z.coerce.number().positive().default(6),
  })
  .refine((e) => e.UNSURE_THRESHOLD < e.MATCH_THRESHOLD, {
    message: 'UNSURE_THRESHOLD must be lower than MATCH_THRESHOLD',
    path: ['UNSURE_THRESHOLD'],
  })
  .refine((e) => e.RECOG_FRAMES_REQUIRED <= e.RECOG_FRAMES, {
    message: 'RECOG_FRAMES_REQUIRED cannot exceed RECOG_FRAMES',
    path: ['RECOG_FRAMES_REQUIRED'],
  });

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    // Never print values, only which keys are wrong.
    throw new Error(`Invalid environment configuration:\n${issues.join('\n')}`);
  }
  return parsed.data;
}

export const env = load();
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const llmEnabled = () =>
  Boolean(env.GROQ_API_KEY && env.GROQ_MODEL && env.LLM_DAILY_CALL_LIMIT > 0);
export const clientOrigins = env.CLIENT_ORIGINS.split(',')
  .map((o) => o.trim())
  .filter(Boolean);
