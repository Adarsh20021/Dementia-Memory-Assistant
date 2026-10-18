/**
 * Structured logging with pino. Secrets, tokens, cookies, images and
 * embeddings are redacted so they can never end up in log files.
 */
import pino from 'pino';
import { env } from '../config/env';

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.NODE_ENV === 'production' ? 'info' : 'debug',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-face-secret"]',
      'res.headers["set-cookie"]',
      '*.password',
      '*.passwordHash',
      '*.code',
      '*.embeddings',
      '*.image',
      '*.photo',
    ],
    censor: '[redacted]',
  },
});
