import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Keypair } from '@stellar/stellar-sdk';
import { Pool } from 'pg';
import { migrate } from '../src/db/migrations.js';
import { DepositExecutor } from '../src/services/depositExecutor.js';
import type { PaymentAttempt } from '../src/services/attemptStore.js';
import { PostgresAttemptStore } from '../src/services/postgresAttemptStore.js';
import { Clock, FakeHorizon, FakePaiflow, fakeRegistry, hashOf, IDS } from './fakes.js';

const databaseUrl = process.env.HIMA_TEST_DATABASE_URL;

test('PostgreSQL: migrations, persistence, unique claims, advisory locks, atomic imports and interrupted submission', {
  skip: !databaseUrl ? 'Set HIMA_TEST_DATABASE_URL to a dedicated local PostgreSQL database ending in _test.' : false,
}, async () => {
  const url = new URL(databaseUrl!);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Integration tests only write to localhost.');
  assert.match(url.pathname, /_test$/, 'Use a dedicated database ending in _test.');
  // Production always uses verified TLS. This explicit local-only test fixture may use a Unix/local TCP server without TLS.
  const pool = new Pool({ connectionString: databaseUrl, ssl: false, max: 5, connectionTimeoutMillis: 3000, statement_timeout: 10000 });
  const secondPool = new Pool({ connectionString: databaseUrl, ssl: false, max: 5, connectionTimeoutMillis: 3000, statement_timeout: 10000 });
  const first = new PostgresAttemptStore(pool);
  const second = new PostgresAttemptStore(secondPool);
  const prefix = `hima_it_${randomUUID()}`;
  const clock = new Clock();
  const base: PaymentAttempt = {
    id: `${prefix}_record`, userId: `${prefix}@example.edu`, flow: 'checkout', deploymentId: IDS.checkout,
    idempotencyKey: `${prefix}_key`, kind: 'deposit', amountStroops: '123456789', assetCode: 'XLM', assetIssuer: null,
    status: 'created', createdAt: clock.now().toISOString(), updatedAt: clock.now().toISOString(),
    meta: { preserved: ['backup', { centavos: 8500 }] },
  };
  try {
    await Promise.all([migrate(pool), migrate(secondPool)]);
    await first.ready();
    await second.ready();
    const claims = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      (i % 2 ? first : second).create({ ...base, id: `${prefix}_claim_${i}` })));
    const claimed = claims[0];
    assert.equal(new Set(claims.map((a) => a.id)).size, 1);
    assert.deepEqual(await second.get(claimed.id), claimed);
    assert.equal((await first.list({ userId: base.userId })).length, 1);
    await assert.rejects(first.create({ ...base, id: claimed.id, idempotencyKey: 'different' }));
    await assert.rejects(first.put({ ...claimed, userId: 'other' }));
    let active = 0;
    await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? first : second).withLock(claimed.id, async () => {
      assert.equal(++active, 1);
      const current = (await (i % 2 ? first : second).get(claimed.id))!;
      await (i % 2 ? first : second).put({ ...current, meta: { count: Number(current.meta?.count ?? 0) + 1 } });
      active--;
    })));
    assert.equal((await first.get(claimed.id))?.meta?.count, 12);

    const backup = { ...base, id: `${prefix}_backup`, idempotencyKey: `${prefix}_backup_key`, extraBackupField: 'retained' };
    assert.deepEqual(await first.importAttempts([backup]), { imported: 1, skipped: 0 });
    assert.deepEqual(await second.importAttempts([backup]), { imported: 0, skipped: 1 });
    assert.deepEqual(await second.get(backup.id), backup);
    const rollback = { ...base, id: `${prefix}_rollback`, idempotencyKey: `${prefix}_rollback_key` };
    await assert.rejects(first.importAttempts([rollback, { ...backup, amountStroops: '2' }]));
    assert.equal(await second.get(rollback.id), undefined, 'whole conflicting batch rolls back');
    const security = await pool.query(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.hima_payment_attempts'::regclass`);
    assert.equal(security.rows[0].relrowsecurity, true);

    const paiflow = new FakePaiflow(clock, IDS.checkout);
    const registry = fakeRegistry(clock, { checkout: paiflow });
    const horizon = new FakeHorizon();
    const signer = Keypair.random();
    const request = { flow: 'checkout' as const, userId: base.userId, idempotencyKey: `${prefix}_payment`, signer, amountStroops: 10000001n };
    const one = new DepositExecutor({ store: first, registry, horizon, now: clock.now, log: () => {} });
    const two = new DepositExecutor({ store: second, registry, horizon, now: clock.now, log: () => {} });
    let activeSubmits = 0;
    paiflow.onSubmit = async (xdr) => {
      assert.equal(++activeSubmits, 1);
      const persisted = await pool.query('SELECT payload FROM public.hima_payment_attempts WHERE user_id=$1 AND idempotency_key=$2', [base.userId, request.idempotencyKey]);
      assert.equal(persisted.rows[0].payload.signedXdr, xdr, 'visible from a separate database session before submit');
      await Promise.resolve();
      activeSubmits--;
      return { txHash: hashOf(xdr), status: 'PENDING' };
    };
    const [a, b] = await Promise.all([one.start(request), two.start(request)]);
    assert.equal(a.id, b.id);
    assert.equal(paiflow.prepares.length, 1);
    assert.equal(new Set(paiflow.submits).size, 1);

    class InterruptedStore extends PostgresAttemptStore {
      override async put(attempt: PaymentAttempt) {
        await super.put(attempt);
        if (attempt.status === 'submitted') throw new Error('simulated interruption before submit');
      }
    }
    const interrupted = new InterruptedStore(pool);
    const interruptRequest = { ...request, idempotencyKey: `${prefix}_interrupted` };
    const worker = new DepositExecutor({ store: interrupted, registry, horizon, now: clock.now, log: () => {} });
    await assert.rejects(worker.start(interruptRequest), /simulated interruption/);
    const persisted = (await second.findByKey(base.userId, 'checkout', interruptRequest.idempotencyKey))!;
    const prepareCount = paiflow.prepares.length;
    paiflow.onSubmit = async (xdr) => ({ txHash: hashOf(xdr), status: 'PENDING' });
    const restarted = new DepositExecutor({ store: second, registry, horizon, now: clock.now, log: () => {} });
    const recovered = await restarted.start(interruptRequest);
    assert.equal(paiflow.prepares.length, prepareCount);
    assert.equal(recovered.signedXdr, persisted.signedXdr);
    assert.equal(paiflow.submits.at(-1), persisted.signedXdr);
  } finally {
    // Only our fixture user; never erase another run's records or truncate shared tables.
    await pool.query('DELETE FROM public.hima_payment_attempts WHERE user_id=$1', [base.userId]).catch(() => {});
    await Promise.all([first.close(), second.close()]);
  }
  await assert.rejects(first.ready(), (error: unknown) => error instanceof Error && 'status' in error && error.status === 503);
});
