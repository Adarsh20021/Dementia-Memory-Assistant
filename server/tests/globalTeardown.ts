import type { MongoMemoryServer } from 'mongodb-memory-server';

export default async function globalTeardown() {
  const mongod = (globalThis as Record<string, unknown>).__MONGOD__ as
    MongoMemoryServer | undefined;
  if (mongod) await mongod.stop();
}
