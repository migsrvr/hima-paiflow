import type { Pool } from 'pg';

/** Deliberately separate from app startup: run npm run db:migrate before starting a release. */
export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('hima:schema-migrations', 0))");
    await client.query(`CREATE TABLE IF NOT EXISTS public.hima_schema_migrations (
      version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await client.query('SELECT version FROM public.hima_schema_migrations WHERE version = 1');
    if (!applied.rows.length) {
      await client.query(`CREATE TABLE public.hima_payment_attempts (
        id text PRIMARY KEY,
        user_id text NOT NULL,
        flow text NOT NULL CHECK (flow IN ('checkout','allowance','reward')),
        idempotency_key text NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
        UNIQUE (user_id, flow, idempotency_key),
        CHECK (payload->>'id' IS NOT DISTINCT FROM id),
        CHECK (payload->>'userId' IS NOT DISTINCT FROM user_id),
        CHECK (payload->>'flow' IS NOT DISTINCT FROM flow),
        CHECK (payload->>'idempotencyKey' IS NOT DISTINCT FROM idempotency_key),
        CHECK ((payload->>'createdAt')::timestamptz IS NOT DISTINCT FROM created_at),
        CHECK ((payload->>'updatedAt')::timestamptz IS NOT DISTINCT FROM updated_at)
      )`);
      await client.query('CREATE INDEX hima_attempts_user_created ON public.hima_payment_attempts (user_id, created_at)');
      // Keep tables server-only, including on hosts with a public Data API.
      await client.query('ALTER TABLE public.hima_payment_attempts ENABLE ROW LEVEL SECURITY');
      await client.query('ALTER TABLE public.hima_schema_migrations ENABLE ROW LEVEL SECURITY');
      await client.query('REVOKE ALL ON public.hima_payment_attempts, public.hima_schema_migrations FROM PUBLIC');
      await client.query(`DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
          REVOKE ALL ON public.hima_payment_attempts, public.hima_schema_migrations FROM anon;
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          REVOKE ALL ON public.hima_payment_attempts, public.hima_schema_migrations FROM authenticated;
        END IF;
      END $$`);
      await client.query('INSERT INTO public.hima_schema_migrations (version) VALUES (1)');
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}
