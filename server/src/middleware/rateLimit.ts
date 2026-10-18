/**
 * Rate limiters. Disabled under NODE_ENV=test so tests are deterministic
 * (lockout logic is tested separately and does not depend on these).
 */
import type { RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { isTest } from '../config/env';

const make = (windowMin: number, limit: number): RequestHandler =>
  isTest
    ? (_req, _res, next) => next()
    : rateLimit({
        windowMs: windowMin * 60 * 1000,
        limit,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: {
          error: {
            code: 'RATE_LIMITED',
            message: 'Too many requests. Please wait a little and try again.',
          },
        },
      });

/** Whole API: generous ceiling. */
export const apiLimiter = make(15, 600);
/** Login / register / refresh. */
export const authLimiter = make(15, 30);
/** Device pairing codes: strict, to make guessing impractical. */
export const pairLimiter = make(15, 10);
