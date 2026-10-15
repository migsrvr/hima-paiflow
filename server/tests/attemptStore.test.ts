import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { FileAttemptStore, MemoryAttemptStore, parseAttempts, type PaymentAttempt } from '../src/services/attemptStore.js';
import { ServiceError } from '../src/services/errors.js';
import { createPostgresPool, PostgresAttemptStore } from '../src/services/postgresAttemptStore.js';
import type { Pool } from 'pg';

export function record(id = 'att_store_test'): PaymentAttempt {
  return {
    id, userId: 'student@example.edu', flow: 'checkout', deploymentId: 'deployment-test', idempotencyKey: id,
    kind: 'deposit', amountStroops: '10000001', assetCode: 'XLM', assetIssuer: null, status: 'created',
    createdAt: '2026-10-15T01:00:00.000Z', updatedAt: '2026-10-15T01:00:00.000Z',
    meta: { split: { centavos: 1234 }, retained: true },
  };
}

for (const backend of ['memory', 'file']) {
  test(`${backend}: async atomic identity, immutable signed envelope, detached reads and restart persistence`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hima-store-'));
    const path = join(dir, 'attempts.json');
    const store = backend === 'file' ? new FileAttemptStore(path) : new MemoryAttemptStore();
    try {
      const a = record();
      const claims = await Promise.all(Array.from({ length: 12 }, (_, i) => store.create({ ...a, id: `att_candidate_${i}` })));
      assert.equal(new Set(claims.map((claim) => claim.id)).size, 1);
      assert.equal((await store.list()).length, 1);
      const saved = claims[0];
      const read = await store.get(saved.id);
      assert.ok(read);
      read.meta!.retained = false;
      assert.equal((await store.get(saved.id))?.meta?.retained, true);
      assert.equal((await store.list({ userId: 'other@example.edu' })).length, 0);
      assert.equal((await store.list({ flow: 'allowance' })).length, 0);
      assert.equal((await store.findByKey(a.userId, a.flow, a.idempotencyKey))?.id, saved.id);
      await assert.rejects(store.create({ ...a, id: saved.id, idempotencyKey: 'another-key' }), ServiceError);
      await assert.rejects(store.put({ ...saved, userId: 'other@example.edu' }), ServiceError);
      const signed = { ...saved, status: 'submitted' as const, signedXdr: 'signed-envelope', txHash: 'hash' };
      await store.put(signed);
      await assert.rejects(store.put({ ...signed, signedXdr: 'replacement' }), ServiceError);
      await assert.rejects(store.put({ ...signed, status: 'cancelled' }), ServiceError);
      await store.put({ ...signed, status: 'confirmed' });
      await assert.rejects(store.put({ ...signed, status: 'pending' }), ServiceError);
      await store.ready();
      if (backend === 'file') {
        const restarted = new FileAttemptStore(path);
        assert.equal((await restarted.get(saved.id))?.status, 'confirmed');
        assert.equal((await restarted.get(saved.id))?.signedXdr, signed.signedXdr);
        assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), await restarted.list());
      }
    } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test('locks serialize independent callers, allow nested same-attempt updates, release after rejection', async () => {
  const store = new MemoryAttemptStore();
  const a = await store.create(record());
  let entered = 0;
  let active = 0;
  await Promise.all(Array.from({ length: 10 }, () => store.withLock(a.id, async () => {
    active++;
    assert.equal(active, 1);
    const current = (await store.get(a.id))!;
    await store.put({ ...current, meta: { count: ++entered } });
    await Promise.resolve();
    active--;
  })));
  assert.equal((await store.get(a.id))?.meta?.count, 10);
  await assert.rejects(store.withLock(a.id, async () => { throw new Error('interrupted'); }));
  assert.equal(await store.withLock(a.id, async () => 'released'), 'released');
});

test('backup parser retains extra fields, rejects malformed and duplicate identities', () => {
  const a = { ...record(), preservedExtension: { source: 'backup' } };
  assert.deepEqual(parseAttempts([a]), [a]);
  assert.throws(() => parseAttempts([{ ...a, amountStroops: '1.2' }]));
  assert.throws(() => parseAttempts([{ ...a, updatedAt: 'invalid' }]));
  assert.throws(() => parseAttempts([a, { ...a, id: 'other' }]));
  assert.throws(() => parseAttempts([a, { ...a, idempotencyKey: 'other' }]));
});

test('production Pool always verifies TLS and rejects transaction pooling', async () => {
  const pool = createPostgresPool('postgresql://server:placeholder@localhost:5432/hima?sslmode=no-verify');
  assert.deepEqual(pool.options.ssl, { rejectUnauthorized: true });
  assert.equal(pool.options.max, 5);
  assert.equal(new URL(pool.options.connectionString!).searchParams.has('sslmode'), false);
  await pool.end();
  assert.throws(() => createPostgresPool('postgresql://server:placeholder@localhost:6543/hima'));
  assert.throws(() => createPostgresPool('https://localhost/hima'));
});

test('Neon uses a direct TLS connection and rejects pooled hostnames on port 5432', async () => {
  const direct = createPostgresPool('postgresql://neondb_owner:placeholder@ep-hima-demo.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require');
  assert.equal(new URL(direct.options.connectionString!).hostname, 'ep-hima-demo.us-east-2.aws.neon.tech');
  assert.deepEqual(direct.options.ssl, { rejectUnauthorized: true });
  assert.equal(direct.options.enableChannelBinding, true);
  await direct.end();
  for (const host of ['ep-hima-demo-pooler.us-east-2.aws.neon.tech', 'ep-hima-demo-pooler.c-2.us-east-2.aws.neon.tech']) {
    assert.throws(() => createPostgresPool(`postgresql://neondb_owner:placeholder@${host}:5432/neondb?sslmode=require`), /not transaction pooling/);
  }
});

test('database errors become a safe 503 and never switch to file storage', async () => {
  const pool = { on() {}, async query() { throw new Error('credential/provider details'); }, async end() {} } as unknown as Pool;
  const store = new PostgresAttemptStore(pool);
  for (const work of [() => store.get('id'), () => store.ready(), () => store.create(record())]) {
    await assert.rejects(work(), (error: unknown) => error instanceof ServiceError
      && error.status === 503 && error.code === 'STORAGE_UNAVAILABLE' && !error.message.includes('credential'));
  }
  await store.close();
});


test('Postgres lock keeps writes on one session, commits before submit, and destroys a lost session', async () => {
  const events: string[] = [];
  let stored = record();
  class Client extends EventEmitter {
    async query(sql: string, values?: unknown[]) {
      if (sql.includes('pg_advisory_lock(')) events.push('lock');
      else if (sql.includes('pg_advisory_unlock(')) events.push('unlock');
      else if (sql.startsWith('SELECT payload')) { events.push('read'); return { rows: [{ payload: structuredClone(stored) }] }; }
      else if (sql.startsWith('UPDATE')) { events.push('autocommit-write'); stored = JSON.parse(values![2] as string); }
      else throw new Error('unexpected query');
      return { rows: [] };
    }
    release(destroy: boolean) { events.push(destroy ? 'destroy' : 'release'); }
  }
  const client = new Client();
  const pool = { on() {}, async connect() { return client; }, async query() { throw new Error('pool must not be used inside a lock'); } } as unknown as Pool;
  const store = new PostgresAttemptStore(pool);
  await store.withLock(stored.id, async () => {
    const current = (await store.get(stored.id))!;
    await store.put({ ...current, status: 'submitted', signedXdr: 'exact-signed-envelope', txHash: 'hash' });
    events.push('submit');
    assert.equal(stored.signedXdr, 'exact-signed-envelope');
  });
  assert.deepEqual(events, ['lock', 'read', 'read', 'autocommit-write', 'submit', 'unlock', 'release']);
  events.length = 0;
  await assert.rejects(store.withLock(stored.id, async () => {
    client.emit('error', new Error('socket failure'));
    await store.get(stored.id);
  }), (error: unknown) => error instanceof ServiceError && error.status === 503);
  assert.deepEqual(events, ['lock', 'destroy']);
});
