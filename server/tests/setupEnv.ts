// Test environment variables, set before any app module is imported.
process.env.NODE_ENV = 'test';
process.env.MONGO_URI = process.env.TEST_MONGO_URI ?? 'mongodb://placeholder';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-that-is-at-least-32-chars';
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.LOGIN_MAX_FAILURES = '3';
process.env.UPLOAD_DIR = './tmp-test-uploads';
// Phase 2+: mock face service and mock Groq (see tests/mockServices.ts)
process.env.FACE_SERVICE_URL = 'http://127.0.0.1:45999';
process.env.FACE_SERVICE_SECRET = 'test-face-secret-123456';
process.env.FACE_SERVICE_TIMEOUT_MS = '1500';
process.env.GROQ_API_KEY = 'test-groq-key';
process.env.GROQ_MODEL = 'test-model';
process.env.GROQ_BASE_URL = 'http://127.0.0.1:45999/groq';
process.env.LLM_TIMEOUT_MS = '300';
process.env.LLM_PER_PATIENT_PER_MIN = '1000';
process.env.MATCH_THRESHOLD = '0.5';
process.env.UNSURE_THRESHOLD = '0.35';
