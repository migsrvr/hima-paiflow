import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair } from '@stellar/stellar-sdk';
import { MemoryAttemptStore } from '../src/services/attemptStore.js';
import { findOwnedAttempt, QUOTE_TTL_MS } from '../src/services/checkoutService.js';
import { DepositExecutor } from '../src/services/depositExecutor.js';
import { ServiceError } from '../src/services/errors.js';
import { CANTEEN, checkoutFor, Clock, FakeHorizon, FakePaiflow, fakeRegistry, IDS, SAVINGS } from './fakes.js';

const USER = 'bea.reyes@example.com';
const LUNCH = { paymentId: 'pay-1760414700000', merchantId: 'campus-canteen', amount: 85, reference: 'HM-1014-0042' };

function setup({ withWallet = true, balance = '9988.0000000' } = {}) {
  const student = withWallet ? Keypair.random() : undefined;
  const clock = new Clock();
  const paiflow = new FakePaiflow(clock, IDS.checkout);
  const horizon = new FakeHorizon();
  if (student) horizon.accounts.set(student.publicKey(), [{ assetType: 'native', balance }]);
  const store = new MemoryAttemptStore();
  const registry = fakeRegistry(clock, { checkout: paiflow });
  const executor = new DepositExecutor({ registry, horizon, store, now: clock.now, log: () => {} });
  const checkout = checkoutFor({ clock, registry, horizon, store, executor, student });
  return { clock, paiflow, horizon, store, checkout, student };
}

test('a quote prices ₱85 and its 90/10 split without preparing anything', async () => {
  const { checkout, paiflow } = setup();
  const quote = await checkout.quote(USER, LUNCH);
  assert.equal(paiflow.prepares.length, 0);
  assert.equal(quote.state, 'awaiting_authorization');
  assert.equal(quote.status, 'pending');
  assert.equal(quote.assetAmount, '11.3333333');
  assert.deepEqual(quote.split, [
    { role: 'merchant', label: 'Campus Canteen', percent: 90, amount: 76.5, assetAmount: '10.1999999' },
    { role: 'savings', label: 'Your savings', percent: 10, amount: 8.5, assetAmount: '1.1333334' },
  ]);
  assert.deepEqual(quote.autoSaved, { amount: 8.5, assetAmount: '1.1333334', verified: false });
  assert.ok(quote.quoteExpiresAt);
  assert.equal(quote.txHash, undefined);
  // Quoting again with the same payment id returns the same quote.
  assert.equal((await checkout.quote(USER, LUNCH)).quoteId, quote.quoteId);
});

test('paying a quote prepares once and keeps the same record', async () => {
  const { checkout, paiflow, store } = setup();
  const quote = await checkout.quote(USER, LUNCH);
  const [a, b] = await Promise.all([checkout.pay(USER, { quoteId: quote.quoteId }), checkout.pay(USER, { quoteId: quote.quoteId })]);
  assert.equal(a.id, quote.id);
  assert.equal(b.id, quote.id);
  assert.equal(paiflow.prepares.length, 1);
  assert.equal(a.state, 'pending');
  assert.match(a.txHash ?? '', /^[0-9a-f]{64}$/);
  assert.equal((await store.list()).length, 1);
  assert.deepEqual(a.split.map((l) => l.assetAmount), ['10.1999999', '1.1333334']);
  await checkout.pay(USER, { quoteId: quote.quoteId });
  assert.equal(paiflow.prepares.length, 1);
});

test('a full request quotes and pays in one step (the app\'s fallback)', async () => {
  const { checkout, paiflow } = setup();
  const view = await checkout.pay(USER, LUNCH);
  assert.equal(view.state, 'pending');
  assert.equal(view.paymentId, LUNCH.paymentId);
  assert.equal(paiflow.prepares[0].amount, '113333333');
});

test('an unauthorized quote lapses after five minutes and can never be paid', async () => {
  const { checkout, clock, paiflow } = setup();
  const quote = await checkout.quote(USER, LUNCH);
  clock.advance(QUOTE_TTL_MS + 1);
  await assert.rejects(checkout.pay(USER, { quoteId: quote.quoteId }), (e: unknown) =>
    e instanceof ServiceError && e.code === 'QUOTE_EXPIRED' && e.status === 409);
  const again = await checkout.quote(USER, LUNCH);
  assert.equal(again.status, 'cancelled');
  assert.equal(again.failure?.code, 'QUOTE_EXPIRED');
  assert.equal(paiflow.prepares.length, 0);
});

test('refuses before quoting: merchant, amount, limits, wallet, funds and a deployment that is not ready', async () => {
  const { checkout, paiflow } = setup();
  const refuses = async (svc: typeof checkout, request: Partial<typeof LUNCH>, code: string, status?: number) => {
    await assert.rejects(svc.quote(USER, { ...LUNCH, ...request }), (e: unknown) =>
      e instanceof ServiceError && e.code === code && (status === undefined || e.status === status), code);
  };
  await refuses(checkout, { merchantId: 'kape-corner' }, 'MERCHANT_NOT_PAYABLE', 404);
  await refuses(checkout, { paymentId: 'pay-big', amount: 5000.01 }, 'AMOUNT_TOO_LARGE', 400);
  await refuses(checkout, { paymentId: 'pay-odd', amount: 85.005 }, 'INVALID_AMOUNT', 400);
  await refuses(setup({ withWallet: false }).checkout, {}, 'STELLAR_NOT_CONFIGURED', 503);
  // 11.33 XLM + the 1.5 XLM reserve doesn't fit in 12 XLM.
  await refuses(setup({ balance: '12.0000000' }).checkout, {}, 'WALLET_NOT_FUNDED', 402);
  const usdc = setup();
  usdc.paiflow.inputAsset = { kind: 'known', symbol: 'USDC' };
  await refuses(usdc.checkout, {}, 'FLOW_NOT_READY', 503);
  assert.equal(paiflow.prepares.length, 0);
});

test('a confirmed payment is verified against the Split on Horizon', async () => {
  const { checkout, paiflow, horizon, store, clock } = setup();
  const paid = await checkout.pay(USER, LUNCH);
  paiflow.onStatus = async (hash) => ({ txHash: hash, status: 'SUCCESS', ledger: 5185778 });
  horizon.credit(paid.txHash as string, [CANTEEN, '10.1999999'], [SAVINGS, '1.1333334']);
  clock.advance(2500);

  const attempt = await store.get(paid.id);
  assert.ok(attempt);
  await store.put({ ...attempt, status: 'confirmed', ledger: 5185778 });
  const confirmed = await checkout.present(attempt);
  assert.equal(confirmed.verification?.status, 'verified');
  assert.deepEqual(confirmed.verification?.legs.map((l) => [l.label, l.assetAmount, l.ok]), [
    ['Campus Canteen', '10.1999999', true],
    ['Your savings', '1.1333334', true],
  ]);
  assert.deepEqual(confirmed.autoSaved, { amount: 8.5, assetAmount: '1.1333334', verified: true });
  // Stored, so later reads don't ask Horizon again.
  assert.equal(((await store.get(paid.id))?.meta?.verification as { status: string }).status, 'verified');
});

test('a payment is found by its Hima id or the app\'s payment id, and only by its owner', async () => {
  const { checkout, store } = setup();
  const view = await checkout.quote(USER, LUNCH);
  assert.equal((await findOwnedAttempt(store, USER, view.id)).id, view.id);
  assert.equal((await findOwnedAttempt(store, USER, LUNCH.paymentId)).id, view.id);
  for (const lookup of [view.id, LUNCH.paymentId]) {
    await assert.rejects(findOwnedAttempt(store, 'someone@else.edu', lookup), (e: unknown) =>
      e instanceof ServiceError && e.code === 'PAYMENT_NOT_FOUND' && e.status === 404);
  }
  await assert.rejects(checkout.pay('someone@else.edu', { quoteId: view.quoteId }), (e: unknown) =>
    e instanceof ServiceError && e.code === 'PAYMENT_NOT_FOUND');
});

test('concurrent quote claims return one record and conflicting requests cannot reuse it', async () => {
  const { checkout, store, paiflow } = setup();
  const quotes = await Promise.all(Array.from({ length: 8 }, () => checkout.quote(USER, LUNCH)));
  assert.equal(new Set(quotes.map((quote) => quote.id)).size, 1);
  assert.equal((await store.list()).length, 1);
  await assert.rejects(checkout.quote(USER, { ...LUNCH, amount: 90 }), (error: unknown) =>
    error instanceof ServiceError && error.status === 409 && error.code === 'PAYMENT_ID_REUSED');
  assert.equal(paiflow.prepares.length, 0);
});
