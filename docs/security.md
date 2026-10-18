# Security and privacy review

Face data is biometric. Visit notes and memories are sensitive and health-adjacent. This document records how each risk is handled, the limits that remain, and how to verify each control.

## Data inventory

| Data | Where | Protection | Retention |
|---|---|---|---|
| Face photos (enrollment) | `server/uploads/<patient>/<person>/*.enc` | AES-256-GCM, random 96-bit IV per file | Until consent is revoked, the photo or person is deleted, or "delete all data" |
| Face embeddings (512-d) | `people.embeddings[].enc` | AES-256-GCM; decrypted only in memory for one request | Same as photos |
| Camera frames ("Who is this?") | RAM only, in Express and the face service | Never written to disk, DB or logs | Discarded after the request |
| Notes / reminders | `notes.textEnc` | AES-256-GCM | Until deleted |
| Memories (+ history) | `memories.summaryEnc`, `history[].summaryEnc` | AES-256-GCM | Until deleted |
| Visits, recognition events | `visits`, `recognitionEvents` | Contain IDs, timestamps and scores only | Auto-deleted after `retentionDays` (default 365) |
| Passwords | `users.passwordHash` | argon2id (19 MiB, t=2) | Until account deleted |
| Refresh tokens, pairing codes | `refreshTokens`, `pairingCodes` | SHA-256 hash only; TTL indexes | Auto-expire |
| Audit log | `auditLogs` | Action names and IDs only, with no content | Kept, so it can prove deletions happened |

## Controls (✓ = implemented and covered by tests)

**Authentication and sessions**
- ✓ **Caregiver passwords:** argon2id, 10+ characters with mixed case and a digit. Accounts lock after 5 failures for 15 minutes. Unknown emails and wrong passwords return the same error, with matching timing.
- ✓ **Tokens:** 15-minute access JWT (HS256, issuer checked, algorithm pinned). Refresh tokens rotate on every use and are httpOnly, SameSite=Strict, scoped to `/api/auth`, and Secure in production. Reusing an old refresh token revokes every session.
- ✓ **Patient sign-in:** no password. The caregiver issues an 8-character code (about 40 bits), single use, 15 minutes, stored hashed, rate-limited to 10 tries per 15 minutes. "Sign out all patient devices" revokes them all.

**Authorisation**
- ✓ **Role checks:** RBAC on every route. A patient token gets 403 on all 31 caregiver-only routes (`tests/rbac.test.ts`).
- ✓ **Ownership:** caregivers reach only their own patients. Others get 404, so the API doesn't reveal that a record exists.
- ✓ **Patient writes:** patients can edit or delete only entries they wrote. A patient edit sends the entry back to review.
- ✓ **Mass assignment:** every body schema is `.strict()`, so a request can't set `role`, `reviewStatus` or `source`.

**Consent**
- ✓ **Before biometrics:** consent is required before any photo or embedding exists. Adding a person without it fails validation. A caregiver consenting on someone's behalf must give a reason.
- ✓ **Checked at every use:** recognition candidates (consent active plus `recognition` scope), the result photo, context building (`visit-history` and `conversation-summaries` scopes), memory approval and visit creation.
- ✓ **Revocation:** deletes photo files and embeddings immediately, deactivates the person and writes `consent.revoke` to the audit log.

**Input handling**
- ✓ **Validation:** zod on every body and query, with friendly field-level messages.
- ✓ **NoSQL injection:** `express-mongo-sanitize` plus typed schemas.
- ✓ **Uploads:** multer keeps files in memory only, limits size and count, and checks the real image type by magic bytes, not the declared MIME type.
- ✓ **Size and abuse limits:** JSON bodies are capped at 100 kB. Rate limits cover the whole API, auth, pairing and recognition.

**Transport and browser**
- ✓ **Headers:** helmet, with a CSP of `default-src 'self'` that allows blob: images and media. CORS uses an allow-list.
- ✓ **XSS:** React escapes all text and nothing uses `dangerouslySetInnerHTML`. The access token is kept in memory, never in localStorage.
- ◐ **HTTPS:** the server supports it (`HTTPS_KEY_FILE` / `HTTPS_CERT_FILE`). You must use it whenever another device connects. Browsers also refuse the camera on plain `http://` except on localhost.

**Face service**
- ✓ **Not exposed:** binds to 127.0.0.1 by default and isn't published in compose.
- ✓ **Shared secret:** every route requires `X-Face-Secret`, compared in constant time.
- ✓ **No leakage:** API docs are disabled and access logs are off, so images are never logged.
- ✓ **Stateless:** it stores nothing and can only match against the candidates Express sends for one patient.

**LLM (Groq)**
- ✓ **Backend only:** the key lives only in the backend `.env`.
- ✓ **Minimal data:** only first name, relationship, age, visit dates and approved, consented memories are sent. No images, embeddings, IDs or surnames (asserted in tests).
- ✓ **Guardrails:** at most 3 sentences and 55 words, no questions, no health or diagnosis words. Every number and capitalised name must appear in the facts.
- ✓ **Failure handling:** a 3-second timeout, a daily call budget and a per-patient rate limit. On any failure, the deterministic template is used.
- ◐ **Prompt injection:** a memory could contain instructions to the model. Patient text is excluded until a caregiver approves it, and the output guardrails reject unsupported names, numbers and health terms. A determined approved-memory injection could still change the tone of the sentence, but not add new facts that pass the guardrails.

**Logging**
- ✓ **Redaction:** pino redacts authorization headers, cookies, passwords, codes, embeddings and images.
- ✓ **Audit log:** covers logins, failures, lockouts, refresh-token reuse, pairing, people, consent, enrollment, memory review, visits, export, settings, deletion and retention purges.

**Data rights (DPDP Act 2023 / GDPR spirit)**
- ✓ **Notice and access:** a plain-language privacy page, plus a JSON export of everything except biometrics.
- ✓ **Erasure:** "delete all data" and per-person deletion.
- ✓ **Retention:** a configurable auto-delete job.

## Liveness: what it does and its limits

**Method.** Five frames are captured over about 1.4 s while the patient is prompted to "ask your visitor to slowly turn their head". For each frame we compute the yaw ratio, the horizontal nose offset from the eye midpoint divided by the eye distance. A real head turning in 3D changes this ratio. A flat printed photo, even when tilted or moved, keeps it almost constant: it's a plane, so an affine or perspective warp barely changes it (verified in `face-service/tests/test_service.py`). If the range across frames is below `LIVENESS_MIN_YAW_RANGE` (0.06), the outcome is `liveness_failed` and **no name is revealed**.

**It stops:**
- a printed photo or a phone showing a still photo held up to the camera.

**It does not stop:**
- a video of the person turning their head played on a screen;
- a 3D mask;
- a very cooperative attacker who bends a printed photo.

**Weaker spots:**
- visitors who keep perfectly still fail the check and are asked to try again. That's a usability cost, not a security hole.

**Better options for production:**
- a dedicated anti-spoofing model, such as MiniFASNet / Silent-Face, or a depth or IR camera.

In this app the threat is low-stakes. A false match makes the patient hear a wrong name, and that is also what the caregiver-confirmation band and the N-of-M frame rule protect against. The check can be turned off with `LIVENESS_MODE=off`, for example for demos with a fake camera.

## Remaining risks / production checklist

- **Encryption key management:** `ENCRYPTION_KEY` sits in `.env`. In production, use a secret manager or KMS and keep an offline backup. Losing the key makes the encrypted data unrecoverable. Key rotation is not automated; the `v1:` payload prefix leaves room for it.
- **Database:** MongoDB should require authentication (`mongodb://user:pass@…`) and listen on localhost only. Atlas does this by default.
- **Backups:** encrypted photos are files in `server/uploads`. Back them up together with the database.
- **Registration:** set `ALLOW_REGISTRATION=false` after creating the caregiver accounts.
- **Dependencies:** run `npm audit` and `pip-audit` before every release.
- **Help requests:** these only appear on the dashboard. Real-time SMS or push alerts would need an extra provider.
- **Liveness:** see the limits above.

## How to verify

```powershell
npm test                       # 109 API/unit tests + 16 face-service tests
npm --prefix server run lint
npm run test:e2e               # real face models + browser happy path
```
