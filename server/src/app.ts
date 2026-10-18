/**
 * Express application factory (no network listen here, so tests can import it).
 */
import { existsSync } from 'fs';
import path from 'path';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import mongoSanitize from 'express-mongo-sanitize';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { clientOrigins, env, isTest } from './config/env';
import { logger } from './lib/logger';
import { caregiverOfPatient, patientOrCaregiver } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/errors';
import { apiLimiter } from './middleware/rateLimit';
import authRoutes from './routes/auth.routes';
import insightsRoutes from './routes/insights.routes';
import memoriesRoutes from './routes/memories.routes';
import notesRoutes from './routes/notes.routes';
import patientsRoutes from './routes/patients.routes';
import peopleRoutes from './routes/people.routes';
import recognitionRoutes from './routes/recognition.routes';
import scheduleRoutes from './routes/schedule.routes';
import systemRoutes from './routes/system.routes';
import visitsRoutes from './routes/visits.routes';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          // Photos are fetched with auth and shown as blob: URLs; camera preview uses a MediaStream.
          'img-src': ["'self'", 'data:', 'blob:'],
          'media-src': ["'self'", 'blob:'],
          'connect-src': ["'self'"],
        },
      },
    }),
  );
  app.use(
    cors({
      // Only allow-listed browser origins; requests without an Origin (curl, same-origin) pass.
      origin: (origin, cb) => cb(null, !origin || clientOrigins.includes(origin)),
      credentials: true,
    }),
  );
  if (!isTest) app.use(pinoHttp({ logger }));
  app.use(express.json({ limit: '100kb' })); // images use multipart, not JSON
  app.use(cookieParser());
  app.use(mongoSanitize()); // strips $-operators and dotted keys (NoSQL injection)

  const api = express.Router();
  api.use(apiLimiter);

  api.get('/health', (_req, res) => res.json({ status: 'ok' }));
  api.use('/auth', authRoutes);
  api.use('/system', systemRoutes);
  // Patient-scoped sub-resources (access chain applied at the mount).
  api.use('/patients/:patientId/people', ...caregiverOfPatient, peopleRoutes);
  api.use('/patients/:patientId/visits', ...caregiverOfPatient, visitsRoutes);
  api.use('/patients/:patientId/notes', ...patientOrCaregiver, notesRoutes);
  api.use('/patients/:patientId/memories', ...patientOrCaregiver, memoriesRoutes);
  api.use('/patients/:patientId/schedule', ...patientOrCaregiver, scheduleRoutes);
  // Routers whose access rules differ per route (guards applied per route).
  api.use('/patients', patientsRoutes);
  api.use('/patients/:patientId', recognitionRoutes);
  api.use('/patients/:patientId', insightsRoutes);

  app.use('/api', api);
  app.use('/api', notFoundHandler);

  // Serve the built React app (client/dist) from the same origin, if it exists.
  const clientDist = path.resolve(env.CLIENT_DIST);
  if (existsSync(path.join(clientDist, 'index.html'))) {
    app.use(express.static(clientDist, { index: false, maxAge: '1h' }));
    app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
  }
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
