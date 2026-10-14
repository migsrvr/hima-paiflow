import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Keypair, Networks, type Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import { PaiflowError } from '../src/integrations/paiflow/errors.js';
import { FileAttemptStore, MemoryAttemptStore, type AttemptStore } from '../src/services/attemptStore.js';
import { DepositExecutor, type DepositRequest } from '../src/services/depositExecutor.js';
import { ServiceError } from '../src/services/errors.js';
import { Clock, envelope, FakeHorizon, FakePaiflow, fakeRegistry, hashOf, IDS } from './fakes.js';

const student = Keypair.random();
const USER = 'bea.reyes@example.com';
const LUNCH: DepositRequest = {
  flow: 'checkout', userId: USER, idempotencyKey: 'pay-1760414700000', signer: student,
  amountStroops: 113333333n, amountCentavos: 8500, merchantId: 'campus-canteen', reference: 'HM-1014-0042',
};

function setup(store: AttemptStore = new MemoryAttemptStore()) {
  const clock = new Clock();
  const paiflow = new FakePaiflow(clock, IDS.checkout);
  const horizon = new FakeHorizon();
  const logs: string[] = [];
  const registry = fakeRegistry(clock, { checkout: paiflow });
  const executor = new DepositExecutor({ registry, horizon, store, now: clock.now, log: (m) => logs.push(m) });
  return { clock, paiflow, horizon, store, executor, logs, registry };
}

test('verifies, signs, saves before submitting, then confirms', async () => {
  const { paiflow, executor, store, clock } = setup();
  paiflow.onSubmit = async (signedXdr) => {
    // The signed envelope is stored before Paiflow ever sees it.
    const saved = store.findByKey(USER, 'checkout', LUNCH.idempotencyKey);
    assert.equal(saved?.status, 'submitted');
    assert.equal(saved?.signedXdr, signedXdr);
    return { txHash: hashOf(signedXdr), status: 'PENDING' };
  };
  const attempt = await executor.start(LUNCH);
  assert.deepEqual(paiflow.prepares, [{ from: student.publicKey(), amount: '113333333' }]);
  assert.equal(attempt.status, 'pending');
  assert.equal(attempt.flow, 'checkout');
  assert.equal(attempt.deploymentId, IDS.checkout);
  assert.equal(attempt.userId, USER);
  assert.equal(attempt.assetCode, 'XLM');
  assert.equal(attempt.assetIssuer, null);

  const signed = TransactionBuilder.fromXDR(paiflow.submits[0], Networks.TESTNET) as Transaction;
  assert.equal(signed.signatures.length, 1);
  assert.ok(student.verify(signed.hash(), signed.signatures[0].signature));
  assert.equal(attempt.txHash, Buffer.from(signed.hash()).toString('hex'));

  paiflow.onStatus = async (hash) => ({ txHash: hash, status: 'SUCCESS', ledger: 1842917 });
  clock.advance(2500);
  const confirmed = await executor.refresh(attempt);
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.ledger, 1842917);
  assert.ok(confirmed.confirmedAt);
});

test('a retried start never prepares a second payment; a reused key with other details is refused', async () => {
  const { paiflow, executor } = setup();
  const [a, b] = await Promise.all([executor.start(LUNCH), executor.start(LUNCH)]);
  assert.equal(a.id, b.id);
  await executor.start(LUNCH);
  assert.equal(paiflow.prepares.length, 1);
  assert.equal(paiflow.submits.length, 1);
  await assert.rejects(executor.start({ ...LUNCH, amountStroops: 1n }), (e: unknown) =>
    e instanceof ServiceError && e.code === 'PAYMENT_ID_REUSED' && e.status === 409);
});

test('keys are per user: the same payment id from another user is a separate payment', async () => {
  const { paiflow, executor } = setup();
  const mine = await executor.start(LUNCH);
  const theirs = await executor.start({ ...LUNCH, userId: 'someone@else.edu' });
  assert.notEqual(mine.id, theirs.id);
  assert.equal(paiflow.prepares.length, 2);
});

test('refuses a deployment that is not ready (USDC input) before preparing anything', async () => {
  const { paiflow, executor, store } = setup();
  paiflow.inputAsset = { kind: 'known', symbol: 'USDC' };
  await assert.rejects(executor.start(LUNCH), (e: unknown) =>
    e instanceof ServiceError && e.code === 'FLOW_NOT_READY' && e.status === 503 && /USDC/.test(e.message));
  assert.equal(paiflow.prepares.length, 0);
  assert.equal(store.list().length, 0);
});

test('never signs an envelope other than the requested deposit', async () => {
  const other = Keypair.random().publicKey();
  const cases: Array<[string, (from: string, amount: string) => string, string?]> = [
    ['wrong contract', (f, a) => envelope(f, BigInt(a), { contract: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC' })],
    ['not a deposit', (f, a) => envelope(f, BigInt(a), { fn: 'withdraw' })],
    ['amount does not match', (f, a) => envelope(f, BigInt(a) + 1n)],
    ['wrong source account', (_f, a) => envelope(other, BigInt(a))],
    ['expected one operation', (f, a) => envelope(f, BigInt(a), { extraOp: true })],
    ['fee too high', (f, a) => envelope(f, BigInt(a), { fee: '200000000' })],
    ['unreadable envelope', () => 'not-xdr'],
    ['not testnet', (f, a) => envelope(f, BigInt(a)), Networks.PUBLIC],
  ];
  for (const [name, build, passphrase] of cases) {
    const { paiflow, executor, store, logs } = setup();
    paiflow.onPrepare = async (from, amount) => ({
      xdr: build(from, amount),
      networkPassphrase: passphrase ?? Networks.TESTNET,
      network: passphrase ? 'mainnet' : 'testnet',
      expiresAt: new Date(Date.now() + 180_000).toISOString(),
    });
    await assert.rejects(executor.start(LUNCH), (e: unknown) => e instanceof ServiceError && e.code === 'PAIFLOW_BAD_ENVELOPE', name);
    assert.deepEqual(logs, [`Refused a Paiflow envelope: ${name}.`]);
    assert.equal(paiflow.submits.length, 0, name);
    assert.equal(store.list().length, 0, name);
  }
});

test('preparation errors mean nothing was signed or charged', async () => {
  const cases: Array<[PaiflowError, string, number]> = [
    [new PaiflowError('INSUFFICIENT_FUNDS', 402, 'from does not exist'), 'WALLET_NOT_FUNDED', 402],
    [new PaiflowError('VALIDATION', 422, 'refused'), 'PAYMENT_REFUSED', 422],
    [new PaiflowError('RATE_LIMITED', 429, 'slow', 5000), 'PAYMENTS_BUSY', 503],
    [new PaiflowError('UNAUTHENTICATED', 401, 'token'), 'PAYMENTS_NOT_CONFIGURED', 503],
    [new PaiflowError('NETWORK', undefined, 'down'), 'PAIFLOW_UNAVAILABLE', 502],
  ];
  for (const [error, code, status] of cases) {
    const { paiflow, executor, store } = setup();
    paiflow.onPrepare = async () => { throw error; };
    await assert.rejects(executor.start(LUNCH), (e: unknown) => e instanceof ServiceError && e.code === code && e.status === status, code);
    assert.equal(store.list().length, 0);
    assert.equal(paiflow.submits.length, 0);
  }
});

test('final outcomes: on-chain failure, refusal of the first submission, and REJECTED', async () => {
  {
    const { paiflow, executor } = setup();
    paiflow.onSubmit = async (x) => ({ txHash: hashOf(x), status: 'FAILED', ledger: 9, error: { code: 'txTooLate', message: 'window expired' } });
    const failed = await executor.start(LUNCH);
    assert.equal(failed.status, 'failed');
    assert.deepEqual(failed.failure, { code: 'txTooLate', reason: 'Expired before it reached the network' });
  }
  {
    const { paiflow, executor } = setup();
    paiflow.onSubmit = async () => { throw new PaiflowError('VALIDATION', 422, 'not this flow'); };
    const refused = await executor.start(LUNCH);
    assert.equal(refused.status, 'failed');
    assert.equal(refused.failure?.code, 'REJECTED');
  }
  {
    const { paiflow, executor, clock } = setup();
    const attempt = await executor.start(LUNCH);
    paiflow.onStatus = async (hash) => ({ txHash: hash, status: 'REJECTED' });
    clock.advance(2500);
    assert.equal((await executor.refresh(attempt)).status, 'failed');
  }
});

test('an unknown outcome stays pending, resends the same envelope, and fails only once Horizon proves it never landed', async () => {
  const { paiflow, executor, clock } = setup();
  paiflow.onSubmit = async () => { throw new PaiflowError('NETWORK', undefined, 'no answer'); };
  let attempt = await executor.start(LUNCH);
  assert.equal(attempt.status, 'pending');

  clock.advance(2500);
  attempt = await executor.refresh(attempt);
  assert.equal(attempt.status, 'pending');
  assert.equal(paiflow.submits.length, 2);
  assert.equal(paiflow.submits[1], paiflow.submits[0]);

  // A refusal of a resubmission doesn't prove the first send never landed either.
  paiflow.onStatus = async (hash) => ({ txHash: hash, status: 'UNKNOWN' });
  paiflow.onSubmit = async () => { throw new PaiflowError('VALIDATION', 422, 'refused'); };
  clock.advance(2500);
  attempt = await executor.refresh(attempt);
  assert.equal(attempt.status, 'pending');

  // Past expiry (+ grace) Horizon decides: never seen means it can never land.
  clock.advance(180_000 + 30_000);
  attempt = await executor.refresh(attempt);
  assert.equal(attempt.status, 'failed');
  assert.equal(attempt.failure?.code, 'EXPIRED');
  assert.equal(paiflow.prepares.length, 1);
});

test('after expiry, a transaction Horizon did see is confirmed, not failed', async () => {
  const { paiflow, horizon, executor, clock } = setup();
  paiflow.onSubmit = async () => { throw new PaiflowError('TIMEOUT', undefined, 'slow'); };
  const created = await executor.start(LUNCH);
  paiflow.onStatus = async () => { throw new PaiflowError('UPSTREAM_RPC', 502, 'busy'); };
  clock.advance(240_000);
  horizon.transactions.set(created.txHash as string, { hash: created.txHash as string, successful: true, ledger: 77, createdAt: '' });
  const settled = await executor.refresh(created);
  assert.equal(settled.status, 'confirmed');
  assert.equal(settled.ledger, 77);
});

test('status reads are throttled per attempt', async () => {
  const { paiflow, executor, clock } = setup();
  const attempt = await executor.start(LUNCH);
  paiflow.onStatus = async (hash) => ({ txHash: hash, status: 'PENDING' });
  clock.advance(2500);
  await executor.refresh(attempt);
  await executor.refresh(attempt);
  assert.equal(paiflow.statusReads, 1);
});

test('pending attempts survive a server restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hima-attempts-'));
  try {
    const file = join(dir, 'attempts.json');
    const first = setup(new FileAttemptStore(file));
    const created = await first.executor.start(LUNCH);
    const restarted = setup(new FileAttemptStore(file));
    restarted.paiflow.onStatus = async (hash) => ({ txHash: hash, status: 'SUCCESS', ledger: 5 });
    const reloaded = restarted.store.findByKey(USER, 'checkout', LUNCH.idempotencyKey);
    assert.ok(reloaded);
    const after = await restarted.executor.refresh(reloaded);
    assert.equal(after.txHash, created.txHash);
    assert.equal(after.status, 'confirmed');
    assert.equal(restarted.paiflow.prepares.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the sponsor can sign for the allowance flow through its own deployment', async () => {
  const clock = new Clock();
  const allowance = new FakePaiflow(clock, IDS.allowance);
  const sponsor = Keypair.random();
  allowance.onPrepare = async (from, amount) => ({
    xdr: envelope(from, BigInt(amount), { contract: 'CASK6B3643QXKPEEJWPSPGL3TRGXOFYKFZGW7SVHOW5T4MUFBPNXYSQR' }),
    networkPassphrase: Networks.TESTNET, network: 'testnet', expiresAt: new Date(clock.t + 180_000).toISOString(),
  });
  const executor = new DepositExecutor({ registry: fakeRegistry(clock, { allowance }), horizon: new FakeHorizon(), store: new MemoryAttemptStore(), now: clock.now, log: () => {} });
  const attempt = await executor.start({ flow: 'allowance', userId: USER, idempotencyKey: 'fund-1', signer: sponsor, amountStroops: 120000000n });
  assert.equal(attempt.deploymentId, IDS.allowance);
  assert.equal(attempt.from, sponsor.publicKey());
  assert.deepEqual(allowance.prepares, [{ from: sponsor.publicKey(), amount: '120000000' }]);
});
