import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair } from '@stellar/stellar-sdk';
import { createApp } from '../src/app.js';
import { WindowCounter, type RateLimits } from '../src/middleware/rateLimit.js';
import { MemoryAttemptStore } from '../src/services/attemptStore.js';
import type { ChatClient } from '../src/services/chatService.js';
import { DepositExecutor } from '../src/services/depositExecutor.js';
import { buildCatalog } from '../src/services/flowCatalog.js';
import { SessionService } from '../src/services/sessionService.js';
import { WalletService } from '../src/services/walletService.js';
import { WalletTopUp } from '../src/services/walletTopUp.js';
import { CANTEEN, checkoutFor, Clock, FakeHorizon, FakePaiflow, fakeRegistry, IDS, SAVINGS } from './fakes.js';
import { request } from './httpHarness.js';

const LIMITS: RateLimits = { signInPerIpHour: 3, aiPerUserHour: 2, aiPerIpHour: 10, paymentsPerUserDay: 2, paymentsPerIpDay: 10, paymentsPerDay: 3 };

function demoApp(limits: RateLimits | null = LIMITS, topUp?: { maybeTopUp(): Promise<unknown>; balance(): Promise<bigint | null> }) {
  const clock = new Clock();
  const registry = fakeRegistry(clock, { checkout: new FakePaiflow(clock, IDS.checkout) });
  const horizon = new FakeHorizon();
  const attempts = new MemoryAttemptStore();
  const executor = new DepositExecutor({ registry, horizon, store: attempts, now: clock.now, log: () => {} });
  const student = Keypair.random();
  horizon.accounts.set(student.publicKey(), [{ assetType: 'native', balance: '9988.0000000' }]);
  const ai: ChatClient = { configured: true, async ask() { return { text: 'Keep your reserve.', calculated: [] }; } };
  const sessions = new SessionService({ secret: 'z'.repeat(64) });
  const app = createApp({
    ai,
    sessions,
    registry,
    catalog: buildCatalog({ merchant: CANTEEN, student: student.publicKey(), savings: SAVINGS, emergency: null, rewardAmountStroops: 1n }),
    attempts,
    executor,
    checkout: checkoutFor({ clock, registry, horizon, store: attempts, executor, student }),
    wallet: new WalletService({ registry, horizon, student, rateCentavos: 750 }),
    limits: limits ?? undefined,
    topUp,
    log: () => {},
  });
  const post = (path: string, body: unknown, token?: string) => request(app, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { app, sessions, post };
}

const lunch = (n: number) => ({ paymentId: `pay-demo-${n}00000`, merchantId: 'campus-canteen', amount: 85, reference: `HM-1027-00${n}` });

test('WindowCounter limits per key and resets after the window', () => {
  let t = 0;
  const counter = new WindowCounter(() => t);
  assert.equal(counter.hit('a', 2, 1000).ok, true);
  assert.equal(counter.hit('a', 2, 1000).ok, true);
  const third = counter.hit('a', 2, 1000);
  assert.deepEqual(third, { ok: false, retryAfter: 1 });
  assert.equal(counter.hit('b', 2, 1000).ok, true);
  t = 1000;
  assert.equal(counter.hit('a', 2, 1000).ok, true);
  assert.equal(counter.hit('a', 0, 1000).ok, true, '0 turns a limit off');
});

test('sign-in and AI are rate limited with 429 RATE_LIMITED', async () => {
  const { sessions, post } = demoApp();
  for (let i = 0; i < 3; i++) assert.equal((await post('/api/auth/session', { email: `v${i}@demo.dev` })).status, 200);
  const limited = await post('/api/auth/session', { email: 'v9@demo.dev' });
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error.code, 'RATE_LIMITED');
  assert.ok(Number(limited.headers.get('retry-after')) > 0);

  const { token } = sessions.issue('bea@demo.dev');
  for (let i = 0; i < 2; i++) assert.equal((await post('/api/ai/chat', { question: 'Lunch?' }, token)).status, 200);
  assert.equal((await post('/api/ai/chat', { question: 'Lunch?' }, token)).status, 429);
  // Another user on the same IP still has their own hourly allowance.
  assert.equal((await post('/api/ai/chat', { question: 'Lunch?' }, sessions.issue('kai@demo.dev').token)).status, 200);
});

test('payments: daily quota per user and overall; repeating a sent payment always passes', async () => {
  let topUps = 0;
  const { sessions, post } = demoApp(LIMITS, { async maybeTopUp() { topUps++; }, async balance() { return 0n; } });
  const bea = sessions.issue('bea@demo.dev').token;
  const kai = sessions.issue('kai@demo.dev').token;

  assert.equal((await post('/api/checkout/payments', lunch(1), bea)).status, 200);
  assert.equal((await post('/api/checkout/payments', lunch(2), bea)).status, 200);
  const third = await post('/api/checkout/payments', lunch(3), bea);
  assert.equal(third.status, 429);
  assert.match((await third.json()).error.message, /testnet payments per day/);
  // A retry of an already-sent payment is never refused.
  assert.equal((await post('/api/checkout/payments', lunch(1), bea)).status, 200);
  assert.ok(topUps >= 2, 'each paid request checks the wallet top-up');

  // An unpaid quote doesn't use the quota; the overall cap (3) applies across users.
  const quote = await (await post('/api/checkout/quote', lunch(4), kai)).json();
  assert.equal((await post('/api/checkout/payments', { quoteId: quote.quoteId }, kai)).status, 200);
  assert.equal((await post('/api/checkout/payments', lunch(5), kai)).status, 429);
});

test('no limits when the app is created without them (tests, local tools)', async () => {
  const { sessions, post } = demoApp(null);
  const token = sessions.issue('bea@demo.dev').token;
  for (let i = 1; i <= 4; i++) assert.equal((await post('/api/checkout/payments', lunch(i), token)).status, 200);
});

test('WalletTopUp: only when low, at most once per interval, and never throws', async () => {
  let t = 0;
  let balance = '50.0000000';
  const horizon = new FakeHorizon();
  const wallet = Keypair.random().publicKey();
  horizon.accounts.set(wallet, [{ assetType: 'native', balance }]);
  const funded: string[] = [];
  const merged: string[] = [];
  const topUp = new WalletTopUp({
    horizon, wallet, belowStroops: 100_0000000n, minIntervalMs: 1000, now: () => t,
    async fund(publicKey) { funded.push(publicKey); },
    async merge(source, destination) { merged.push(`${source.publicKey()}->${destination}`); return 'hash1'; },
  });

  assert.deepEqual(await topUp.maybeTopUp(), { status: 'topped_up', txHash: 'hash1' });
  assert.equal(merged.length, 1);
  assert.ok(merged[0].endsWith(`->${wallet}`));
  assert.equal(funded[0], merged[0].split('->')[0], 'the funded throwaway account is the one merged');
  assert.deepEqual(await topUp.maybeTopUp(), { status: 'skipped', reason: 'recent' });

  t = 2000;
  balance = '500.0000000';
  horizon.accounts.set(wallet, [{ assetType: 'native', balance }]);
  assert.deepEqual(await topUp.maybeTopUp(), { status: 'skipped', reason: 'funded' });

  t = 4000;
  horizon.down = true;
  assert.deepEqual(await topUp.maybeTopUp(), { status: 'skipped', reason: 'balance unavailable' });

  const empty = new FakeHorizon();
  empty.accounts.set(wallet, [{ assetType: 'native', balance: '0.0000000' }]);
  const failing = new WalletTopUp({
    horizon: empty, wallet, belowStroops: 1n, log: () => {},
    async fund() { throw new Error('friendbot down'); },
  });
  assert.deepEqual(await failing.maybeTopUp(), { status: 'skipped', reason: 'failed' });

  const off = new WalletTopUp({ horizon, wallet, belowStroops: 0n });
  assert.deepEqual(await off.maybeTopUp(), { status: 'skipped', reason: 'off' });
});
