/**
 * Image upload handling (multer, in memory only — nothing is written to a
 * temp folder). The declared MIME type is not trusted: the file's magic bytes
 * must be JPEG, PNG or WebP.
 */
import type { RequestHandler } from 'express';
import multer from 'multer';
import { HttpError } from '../lib/http';

const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];

export function sniffImageType(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png';
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp';
  return null;
}

/** Accepts up to `maxFiles` images in the `field` form field, each up to `maxBytes`. */
export function imageUpload(field: string, maxFiles: number, maxBytes: number): RequestHandler[] {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: maxFiles, fields: 5 },
    fileFilter: (_req, file, cb) => {
      if (!ALLOWED.includes(file.mimetype)) {
        cb(new HttpError(415, 'UNSUPPORTED_FILE', 'Please use JPG, PNG or WebP photos.'));
        return;
      }
      cb(null, true);
    },
  }).array(field, maxFiles);

  const handle: RequestHandler = (req, res, next) => {
    upload(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        const message =
          err.code === 'LIMIT_FILE_SIZE'
            ? `Each photo must be smaller than ${Math.round(maxBytes / 1024 / 1024)} MB.`
            : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE'
              ? `Please send at most ${maxFiles} photos.`
              : 'The upload could not be read.';
        return next(
          new HttpError(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, 'UPLOAD_ERROR', message),
        );
      }
      if (err) return next(err);
      next();
    });
  };

  const verify: RequestHandler = (req, _res, next) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (!files.length)
      return next(new HttpError(400, 'NO_FILES', 'Please add at least one photo.'));
    for (const f of files) {
      const real = sniffImageType(f.buffer);
      if (!real)
        return next(
          new HttpError(
            415,
            'UNSUPPORTED_FILE',
            'One of the files is not a real JPG, PNG or WebP image.',
          ),
        );
      f.mimetype = real;
    }
    next();
  };

  return [handle, verify];
}
