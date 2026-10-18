/**
 * Zod request validation. Parsed (and coerced/stripped) values replace the
 * raw input, so handlers only ever see validated data. Body schemas are
 * `.strict()` to block mass-assignment (e.g. sending `role: "caregiver"`).
 */
import type { RequestHandler } from 'express';
import type { ZodTypeAny } from 'zod';

export const validate =
  (schemas: { body?: ZodTypeAny; query?: ZodTypeAny }): RequestHandler =>
  (req, _res, next) => {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body ?? {});
      if (schemas.query) {
        const parsed = schemas.query.parse(req.query);
        req.query = parsed;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
