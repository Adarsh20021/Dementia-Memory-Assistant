/**
 * Small HTTP helpers: a typed error class and an async route wrapper.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** An error that is safe to show to the client (status + stable code + friendly message). */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const notFound = (what = 'That item') =>
  new HttpError(404, 'NOT_FOUND', `${what} was not found.`);

/** Wraps an async handler so rejected promises reach the error middleware. */
export const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

/** True if the value is a 24-char hex MongoDB ObjectId string. */
export const isObjectId = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v);
