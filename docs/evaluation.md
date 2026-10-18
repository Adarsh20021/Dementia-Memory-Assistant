# Evaluation

This covers how to produce every number the project report needs, and the numbers measured so far.

## 1. Recognition accuracy (FAR / FRR / accuracy / EER)

```powershell
npm run evaluate -- --data C:\path\to\eval_data --enroll 3 --match 0.5 --unsure 0.35
```

Dataset layout: one folder per person. Folders starting with `_` are treated as **strangers** and are never enrolled.

```
eval_data/
  volunteer_a/   10+ photos (different days, light, angles, glasses...)
  volunteer_b/
  ...
  _stranger_1/   photos of people who are NOT enrolled
```

Outputs go to `face-service/eval/results/`:
- `verification.csv`: pairwise FAR and FRR at thresholds 0.10–0.85
- `identification.csv`: how the app behaves (gallery = first 3 photos), with FAR, FRR, misidentification and accuracy
- `summary.json`: EER, values at your thresholds, and how genuine visitors and strangers split into match / unsure / unknown
- `far_frr.png`: plot for the report

**Getting data ethically:**
- Use volunteers (classmates, family) who give written consent.
- Alternatively, use a public research set such as LFW, with people that have 5+ images.
- Don't use photos of real patients.

**Choosing thresholds:**
- Pick `MATCH_THRESHOLD` where FAR on strangers is about 0 (a wrong name is worse than "I don't recognize this person").
- Pick `UNSURE_THRESHOLD` near the EER.
- Put both in `server/.env`.

### Smoke-test result (not a real evaluation)

`npm run evaluate -- --self-test` builds a tiny synthetic set: 4 enrolled and 2 stranger identities from one sample photo, each with 6 brightness, rotation, flip and blur variations. It proves the script works end to end. Because all variations come from one photo, its numbers are optimistic and **must not be reported as accuracy**.

| | Value |
|---|---|
| Genuine pair similarity, mean | 0.94 |
| Impostor pair similarity, mean / max | 0.06 / 0.28 |
| FAR / FRR at 0.50 | 0 / 0 |

Typical real-world ArcFace (MobileFaceNet) values: same person on different days is about 0.4–0.8, different people below about 0.3. That is why the defaults are MATCH 0.50 and UNSURE 0.35. Tune them with your own data.

## 2. Latency (target: under 3 s from button press to speech)

**Measured in the development container:** 2 CPU threads, no GPU. Real face models, Chromium, fake webcam. Data from `GET /patients/:id/evaluation/summary`.

| Stage | Median |
|---|---|
| Frame capture (5 frames, 350 ms apart; deliberate, for the head-movement check) | 1 415 ms |
| Face service: detect + align + embed + match, 5 frames | 190–240 ms |
| Server total: face service + DB + visit + summary | 215–270 ms |
| Client round trip: upload + server | 235–300 ms |
| **End-to-end: button → speech starts** | **1 660–1 735 ms** ✅ |

Notes:
- The browser had no speech voice installed, so "result → speech" is 12–15 ms here. Real text-to-speech usually adds 100–300 ms.
- With Groq enabled, add Groq's latency (capped at 3 s, then the template is used). Repeat recognitions are served from the cache.

**Face-service benchmark** (`npm run benchmark`), 5 frames at 640×480 with 10 candidate people: **median 218 ms, p95 245 ms, about 44 ms per frame**.

Re-run both on the laptop you will demo on:
- Do 20+ "Who is this?" attempts.
- Open the **Evaluation** tab and download the CSV.

## 3. Groq latency and fallback rate

The Evaluation tab shows `summarySources` (llm / cache / fallback) and the **fallback rate**. The CSV has `llmMs` per recognition.

Fallback happens when:
- there is no key;
- the call times out (over 3 s);
- the daily budget or rate limit is hit;
- a guardrail rejects the output;
- the person has no visit history or approved memories yet (the template already says everything).

## 4. Usability (SUS)

On the Evaluation tab, record the standard 10-item System Usability Scale for each participant (caregiver, family, and the patient where appropriate and with consent). Scores are 0–100 using the standard formula. The mean is shown, and every response is included in the JSON export.

For reference, 68 is average and 80+ is excellent.

## 5. Automated tests

| Suite | Count | Covers |
|---|---|---|
| `server` (Jest + Supertest) | 109 | Auth, lockout, refresh rotation and reuse, pairing, RBAC (patient token → 403 on all caregiver routes), ownership, consent and revocation, encryption at rest, enrollment, decision logic, liveness, context builder, guardrails, Groq fallback, timeout and cache, memories review and history, questions, export, SUS, retention |
| `face-service` (pytest) | 16 | Secret guard, quality checks (no face, multiple faces, small, blurry, dark), embeddings, matching only among candidates, flat-photo yaw invariance |
| `client` (Playwright e2e) | 1 | Real stack: caregiver sets up person, consent and photos → device pairing → fake webcam "Who is this?" → spoken result → patient memory → caregiver approves |
