/**
 * Process entry point: connect to MongoDB, start HTTP server, shut down cleanly.
 */
import { readFileSync } from 'fs';
import https from 'https';
import mongoose from 'mongoose';
import { createApp } from './app';
import { env } from './config/env';
import { logger } from './lib/logger';
import { scheduleRetention } from './services/retention.service';

async function main() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(env.MONGO_URI);
  logger.info('Connected to MongoDB');
  scheduleRetention();

  const app = createApp();
  // Optional HTTPS (needed when the patient uses a tablet over the network: browsers only
  // allow the camera on https:// or on localhost). See README "Using a tablet".
  const server =
    env.HTTPS_KEY_FILE && env.HTTPS_CERT_FILE
      ? https
          .createServer(
            { key: readFileSync(env.HTTPS_KEY_FILE), cert: readFileSync(env.HTTPS_CERT_FILE) },
            app,
          )
          .listen(env.PORT, env.HOST, () =>
            logger.info(`API listening on https://${env.HOST}:${env.PORT}`),
          )
      : app.listen(env.PORT, env.HOST, () =>
          logger.info(`API listening on http://${env.HOST}:${env.PORT}/api`),
        );

  const shutdown = (signal: string) => {
    logger.info(`${signal} received, shutting down`);
    server.close(() => {
      mongoose.disconnect().finally(() => process.exit(0));
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
