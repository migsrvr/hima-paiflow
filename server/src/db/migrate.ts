import { loadConfig } from '../config.js';
import { createPostgresPool } from '../services/postgresAttemptStore.js';
import { migrate } from './migrations.js';

async function main() {
  const config = loadConfig();
  if (config.storage.backend !== 'postgres') throw new Error('db:migrate requires STORAGE_BACKEND=postgres.');
  const pool = createPostgresPool(config.storage.databaseUrl, config.storage.sslCa);
  pool.on('error', () => {});
  try { await migrate(pool); console.log('Hima database schema is current (version 1).'); }
  finally { await pool.end(); }
}
main().catch(() => {
  console.error('Database migration failed. Check storage configuration, TLS, connectivity and database permissions.');
  process.exitCode = 1;
});
