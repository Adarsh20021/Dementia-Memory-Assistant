/**
 * /api/system   (caregivers only) — a plain-language health check, so problems
 * like a missing AI key or a stopped face service are visible in the dashboard.
 *
 *   GET  /status    AI configuration + last AI result, face-service reachability
 *   POST /ai-test   sends one tiny request to the AI and reports what happened
 */
import { Router } from 'express';
import { env } from '../config/env';
import { ah } from '../lib/http';
import { authenticate, requireRole } from '../middleware/auth';
import { chat, llmStatus } from '../services/llm.service';

const router = Router();
router.use(authenticate, requireRole('caregiver'));

async function faceStatus() {
  try {
    const res = await fetch(`${env.FACE_SERVICE_URL}/health`, {
      signal: AbortSignal.timeout(2500),
    });
    return {
      reachable: res.ok,
      secretSet: Boolean(env.FACE_SERVICE_SECRET),
      url: env.FACE_SERVICE_URL,
    };
  } catch {
    return {
      reachable: false,
      secretSet: Boolean(env.FACE_SERVICE_SECRET),
      url: env.FACE_SERVICE_URL,
    };
  }
}

router.get(
  '/status',
  ah(async (_req, res) => {
    const [ai, face] = await Promise.all([llmStatus(), faceStatus()]);
    res.json({ ai, face });
  }),
);

router.post(
  '/ai-test',
  ah(async (req, res) => {
    const r = await chat({
      system: 'Reply with exactly: Hello, I am working.',
      user: 'Say hello.',
      // Counted against this caregiver, not a patient.
      patientId: `caregiver:${req.user!.id}`,
      timeoutMs: env.LLM_DRAFT_TIMEOUT_MS,
      maxTokens: 20,
    });
    const status = await llmStatus();
    res.json(
      r.ok
        ? { ok: true, reply: r.text, ms: r.ms, model: status.model }
        : {
            ok: false,
            reason: r.reason,
            ms: r.ms,
            detail: status.lastCall?.detail,
            model: status.model,
          },
    );
  }),
);

export default router;
