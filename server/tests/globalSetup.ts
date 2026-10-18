/**
 * Starts one MongoDB for the whole test run.
 * - If TEST_MONGO_URI is set (e.g. your local MongoDB), it is used directly.
 * - Otherwise mongodb-memory-server downloads and starts a throwaway mongod.
 * Each test file uses its own randomly named database (see helpers.ts).
 */
import { MongoMemoryServer } from 'mongodb-memory-server';

export default async function globalSetup() {
  if (process.env.TEST_MONGO_URI) return;
  const mongod = await MongoMemoryServer.create();
  (globalThis as Record<string, unknown>).__MONGOD__ = mongod;
  process.env.TEST_MONGO_URI = mongod.getUri();
}
