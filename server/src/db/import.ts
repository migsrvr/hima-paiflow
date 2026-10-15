import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from '../config.js';
import { createPostgresPool, PostgresAttemptStore } from '../services/postgresAttemptStore.js';

async function main() {
  const source = process.argv[2];
  if (!source || process.argv.length !== 3) throw new Error('Usage: npm run db:import -- /path/to/backed-up-attempts.json');
  const config = loadConfig();
  if (config.storage.backend !== 'postgres') throw new Error('db:import requires STORAGE_BACKEND=postgres.');
  const input: unknown = JSON.parse(await readFile(resolve(source), 'utf8'));
  const store = new PostgresAttemptStore(createPostgresPool(config.storage.databaseUrl, config.storage.sslCa));
  try {
    await store.ready();
    const result = await store.importAttempts(input);
    console.log(`Attempts import complete: ${result.imported} imported, ${result.skipped} identical records skipped.`);
  } finally { await store.close(); }
}
main().catch(() => {
  // Never print input payloads, signed envelopes, connection strings or raw provider errors.
  console.error('Attempts import failed; no batch records committed. Check source data, conflicts and database configuration.');
  process.exitCode = 1;
});
