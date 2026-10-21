/**
 * Voice-recording upload (multer, in memory only — never written to disk).
 * The declared MIME type is not trusted: the bytes must look like a real
 * WebM, Ogg, MP4/M4A, WAV or MP3 recording.
 */
import type { RequestHandler } from 'express';
import multer from 'multer';
import { HttpError } from '../lib/http';

export const MAX_AUDIO_BYTES = 5 * 1024 * 1024; // ~5 min of Opus; questions are a few seconds

/** Returns a file extension Groq accepts, or null if the bytes are not audio we support. */
export function sniffAudioType(buf: Buffer): { ext: string; mime: string } | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3)
    return { ext: 'webm', mime: 'audio/webm' };
  if (buf.subarray(0, 4).toString('ascii') === 'OggS') return { ext: 'ogg', mime: 'audio/ogg' };
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WAVE')
    return { ext: 'wav', mime: 'audio/wav' };
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') return { ext: 'm4a', mime: 'audio/mp4' };
  if (buf.subarray(0, 3).toString('ascii') === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0))
    return { ext: 'mp3', mime: 'audio/mpeg' };
  return null;
}

export function audioUpload(field = 'audio'): RequestHandler[] {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_AUDIO_BYTES, files: 1, fields: 3 },
    fileFilter: (_req, file, cb) => {
      // "audio/webm;codecs=opus" etc. Some browsers label Opus-in-WebM as video/webm.
      if (!/^(audio\/|video\/webm|video\/mp4|application\/ogg)/.test(file.mimetype)) {
        cb(new HttpError(415, 'UNSUPPORTED_FILE', 'Please send a voice recording.'));
        return;
      }
      cb(null, true);
    },
  }).single(field);

  const handle: RequestHandler = (req, res, next) => {
    upload(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        return next(
          err.code === 'LIMIT_FILE_SIZE'
            ? new HttpError(413, 'UPLOAD_ERROR', 'That recording is too long. Please try a shorter one.')
            : new HttpError(400, 'UPLOAD_ERROR', 'The recording could not be read.'),
        );
      }
      if (err) return next(err);
      next();
    });
  };

  const verify: RequestHandler = (req, _res, next) => {
    const f = req.file;
    if (!f || !f.size) return next(new HttpError(400, 'NO_FILES', 'No recording was received.'));
    const real = sniffAudioType(f.buffer);
    if (!real) return next(new HttpError(415, 'UNSUPPORTED_FILE', 'That is not a voice recording we can read.'));
    f.mimetype = real.mime;
    f.originalname = `speech.${real.ext}`;
    next();
  };

  return [handle, verify];
}
