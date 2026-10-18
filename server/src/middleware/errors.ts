/**
 * Central error handling. Clients get a stable shape:
 *   { error: { code, message, details? } }
 * Internal errors are logged and returned as a generic 500 (no stack traces).
 */
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../lib/http';
import { logger } from '../lib/logger';

export const notFoundHandler: RequestHandler = (_req, res) => {
  res
    .status(404)
    .json({ error: { code: 'NOT_FOUND', message: 'This page or resource does not exist.' } });
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Some details are missing or not valid.',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
  if (err?.type === 'entity.parse.failed') {
    return res
      .status(400)
      .json({ error: { code: 'BAD_JSON', message: 'The request body is not valid JSON.' } });
  }
  if (err?.type === 'entity.too.large') {
    return res
      .status(413)
      .json({ error: { code: 'TOO_LARGE', message: 'The request is too large.' } });
  }
  if (err?.code === 11000) {
    return res.status(409).json({ error: { code: 'DUPLICATE', message: 'That already exists.' } });
  }
  logger.error({ err }, 'Unhandled error');
  return res
    .status(500)
    .json({ error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' } });
};
