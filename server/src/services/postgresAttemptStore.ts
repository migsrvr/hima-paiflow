import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import { Pool, type PoolClient } from 'pg';
import type { FlowName } from '../integrations/paiflow/types.js';
import { ServiceError } from './errors.js';
import { assertUpdate, parseAttempts, type AttemptStore, type PaymentAttempt } from './attemptStore.js';

/** Use a direct PostgreSQL connection or session pooler: payment advisory locks are session-owned. */
export function createPostgresPool(databaseUrl: string, ca?: string): Pool {
  let url: URL;
  try { url = new URL(databaseUrl); } catch { throw new Error('Invalid server configuration: DATABASE_URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username) {
    throw new Error('Invalid server configuration: DATABASE_URL');
  }
  const neonTransactionPooler = url.hostname.endsWith('.neon.tech')
    && url.hostname.split('.')[0].endsWith('-pooler');
  if (url.port === '6543' || url.searchParams.get('pgbouncer') === 'true' || neonTransactionPooler) {
    throw new Error('DATABASE_URL must use a direct connection or session pooler, not transaction pooling.');
  }
  // pg's connection-string SSL flags override its ssl object. Strip them to enforce verified TLS.
  for (const name of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat']) url.searchParams.delete(name);
  return new Pool({
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
    enableChannelBinding: true,
    max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000,
    statement_timeout: 30000, keepAlive: true, application_name: 'hima-server',
  });
}

const unavailable = () => new ServiceError('STORAGE_UNAVAILABLE', 503, 'Payment storage is temporarily unavailable. Please try again.');
const conflict = () => new ServiceError('ATTEMPT_CONFLICT', 409, 'Payment attempt identity is already used.');
interface LockContext { id: string; client: PoolClient; broken: boolean }

/** Every lock holds one session. Writes autocommit BEFORE submission, even while the lock is held. */
export class PostgresAttemptStore implements AttemptStore {
  private readonly held = new AsyncLocalStorage<LockContext>();
  constructor(private readonly pool: Pool) {
    // Idle socket failures must not crash the process or log credentials/provider details.
    pool.on('error', () => {});
  }
  private db() {
    const held = this.held.getStore();
    if (held?.broken) throw unavailable();
    return held?.client ?? this.pool;
  }
  private async safely<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (error instanceof ServiceError) throw error;
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') throw conflict();
      throw unavailable();
    }
  }
  async get(id: string): Promise<PaymentAttempt | undefined> {
    return this.safely(async () => (await this.db().query<{ payload: PaymentAttempt }>(
      'SELECT payload FROM public.hima_payment_attempts WHERE id = $1', [id],
    )).rows[0]?.payload);
  }
  async findByKey(userId: string, flow: FlowName, idempotencyKey: string): Promise<PaymentAttempt | undefined> {
    return this.safely(async () => (await this.db().query<{ payload: PaymentAttempt }>(
      'SELECT payload FROM public.hima_payment_attempts WHERE user_id = $1 AND flow = $2 AND idempotency_key = $3',
      [userId, flow, idempotencyKey],
    )).rows[0]?.payload);
  }
  async list(filter: { userId?: string; flow?: FlowName } = {}): Promise<PaymentAttempt[]> {
    return this.safely(async () => (await this.db().query<{ payload: PaymentAttempt }>(
      `SELECT payload FROM public.hima_payment_attempts
       WHERE ($1::text IS NULL OR user_id = $1) AND ($2::text IS NULL OR flow = $2) ORDER BY created_at, id`,
      [filter.userId ?? null, filter.flow ?? null],
    )).rows.map((row) => row.payload));
  }
  async create(attempt: PaymentAttempt): Promise<PaymentAttempt> {
    return this.safely(async () => {
      const { rows } = await this.db().query<{ payload: PaymentAttempt }>(
        `INSERT INTO public.hima_payment_attempts (id, user_id, flow, idempotency_key, created_at, updated_at, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
         ON CONFLICT (user_id, flow, idempotency_key) DO NOTHING RETURNING payload`,
        [attempt.id, attempt.userId, attempt.flow, attempt.idempotencyKey, attempt.createdAt, attempt.updatedAt, JSON.stringify(attempt)],
      );
      if (rows[0]) return rows[0].payload;
      const existing = await this.findByKey(attempt.userId, attempt.flow, attempt.idempotencyKey);
      if (!existing) throw unavailable();
      return existing;
    });
  }
  async put(attempt: PaymentAttempt): Promise<void> {
    return this.withLock(attempt.id, () => this.safely(async () => {
      const existing = await this.get(attempt.id);
      if (!existing) throw conflict();
      assertUpdate(existing, attempt);
      await this.db().query(
        'UPDATE public.hima_payment_attempts SET updated_at = $2, payload = $3::jsonb WHERE id = $1',
        [attempt.id, attempt.updatedAt, JSON.stringify(attempt)],
      );
    }));
  }
  async withLock<T>(id: string, work: () => Promise<T>): Promise<T> {
    const held = this.held.getStore();
    if (held) {
      if (held.broken) throw unavailable();
      if (held.id !== id) throw new Error('Nested locks must refer to the same attempt.');
      return work();
    }
    return this.safely(async () => {
      const client = await this.pool.connect();
      const context: LockContext = { id, client, broken: false };
      const onError = () => { context.broken = true; };
      client.on('error', onError);
      let locked = false;
      try {
        await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [`hima:attempt:${id}`]);
        locked = true;
        const value = await this.held.run(context, work);
        if (context.broken) throw unavailable();
        return value;
      } finally {
        if (locked && !context.broken) {
          try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`hima:attempt:${id}`]); }
          catch { context.broken = true; }
        }
        client.removeListener('error', onError);
        // Destroy broken sessions; never return a session with an uncertain lock to the pool.
        client.release(context.broken || (!locked));
      }
    });
  }
  async ready(): Promise<void> {
    await this.safely(async () => {
      // Verifies connectivity, schema and SELECT permission, including on an empty database.
      await this.pool.query('SELECT id, payload FROM public.hima_payment_attempts LIMIT 1');
      const { rows } = await this.pool.query('SELECT version FROM public.hima_schema_migrations WHERE version = 1');
      if (!rows.length) throw unavailable();
    });
  }
  async close() { await this.pool.end(); }

  /** An offline, all-or-nothing import. Exact reimports skip; conflicting records abort the batch. */
  async importAttempts(input: unknown): Promise<{ imported: number; skipped: number }> {
    const attempts = parseAttempts(input);
    return this.safely(async () => {
      const client = await this.pool.connect();
      let imported = 0;
      let skipped = 0;
      try {
        await client.query('BEGIN');
        // Blocks concurrent imports and payment writes during this maintenance operation.
        await client.query('LOCK TABLE public.hima_payment_attempts IN SHARE ROW EXCLUSIVE MODE');
        for (const attempt of attempts) {
          const { rows } = await client.query<{ payload: PaymentAttempt }>(
            `SELECT payload FROM public.hima_payment_attempts WHERE id = $1
             OR (user_id = $2 AND flow = $3 AND idempotency_key = $4)`,
            [attempt.id, attempt.userId, attempt.flow, attempt.idempotencyKey],
          );
          if (rows.length) {
            if (rows.length !== 1 || !isDeepStrictEqual(rows[0].payload, attempt)) throw conflict();
            skipped++;
            continue;
          }
          await client.query(
            `INSERT INTO public.hima_payment_attempts (id,user_id,flow,idempotency_key,created_at,updated_at,payload)
             VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
            [attempt.id, attempt.userId, attempt.flow, attempt.idempotencyKey, attempt.createdAt, attempt.updatedAt, JSON.stringify(attempt)],
          );
          imported++;
        }
        await client.query('COMMIT');
        return { imported, skipped };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally { client.release(); }
    });
  }
}
