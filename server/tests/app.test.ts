import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair } from '@stellar/stellar-sdk';
import { createApp, type AppServices } from '../src/app.js';
import { MemoryAttemptStore } from '../src/services/attemptStore.js';
import { ChatServiceError, type ChatClient } from '../src/services/chatService.js';
import { DepositExecutor } from '../src/services/depositExecutor.js';
import { buildCatalog } from '../src/services/flowCatalog.js';
import { SessionService } from '../src/services/sessionService.js';
import { WalletService } from '../src/services/walletService.js';
import { CANTEEN, checkoutFor, Clock, FakeHorizon, FakePaiflow, fakeRegistry, IDS, SAVINGS, TOKENS } from './fakes.js';
import { request } from './httpHarness.js';

function services(ai: ChatClient): AppServices & { horizon: FakeHorizon; student: Keypair } {
  const clock = new Clock();
  const registry = fakeRegistry(clock, { checkout: new FakePaiflow(clock, IDS.checkout) });
  const horizon = new FakeHorizon();
  const attempts = new MemoryAttemptStore();
  const executor = new DepositExecutor({ registry, horizon, store: attempts, now: clock.now, log: () => {} });
  const student = Keypair.random();
  horizon.accounts.set(student.publicKey(), [{ assetType: 'native', balance: '9988.0000000' }]);
  return {
    ai,
    sessions: new SessionService({ secret: 'z'.repeat(64) }),
    registry,
    catalog: buildCatalog({ merchant: CANTEEN, student: student.publicKey(), savings: SAVINGS, emergency: null, rewardAmountStroops: 50_000_000n }),
    attempts,
    executor,
    checkout: checkoutFor({ clock, registry, horizon, store: attempts, executor, student }),
    wallet: new WalletService({ registry, horizon, student, rateCentavos: 750 }),
    horizon,
    student,
  };
}

const unusedAi: ChatClient = { configured: false, async ask() { throw new Error('unused'); } };

test('HTTP contract, UID normalization, validation, CORS, sessions and safe error handling', async () => {
  let calls = 0;
  const logs: string[] = [];
  const s = services({
    configured: true,
    async ask(question: string, context?: unknown) {
      calls++;
      if (question === 'fail') throw new ChatServiceError('AI_UNAVAILABLE', 502, 'Hima AI is temporarily unavailable. Please try again.');
      assert.equal(question, 'Can I afford lunch?');
      assert.deepEqual(context, { safeToSpend: 420 });
      return { text: 'Keep your emergency reserve protected.', calculated: [] };
    },
  });
  const app = createApp({ ...s, corsOrigins: ['http://localhost:8081'], log: (line) => logs.push(line) });
  const fetch = (path: string, init?: RequestInit) => request(app, path, init);
  const { token } = s.sessions.issue('bea.reyes@example.com');
  const post = (body: unknown, auth = true) => fetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

  const health = await fetch('/health');
  assert.deepEqual(await health.json(), { status: 'ok', ai: true, payments: true });
  assert.equal(health.headers.has('x-powered-by'), false);
  assert.equal(health.headers.get('cache-control'), 'no-store');

  for (const uid of ['22:E9:4A:7A', '22E94A7A', '22e94a7a', '04A1B2C34F2A']) {
    const response = await fetch(`/api/merchants/resolve-tag/${encodeURIComponent(uid)}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id: 'campus-canteen', name: 'Campus Canteen', category: 'food', icon: 'utensils', verified: true });
  }
  assert.equal((await fetch('/api/merchants/resolve-tag/123')).status, 400);
  assert.equal((await fetch('/api/merchants/resolve-tag/FFFFFFFF')).status, 404);

  assert.equal((await post({ question: 'Can I afford lunch?' }, false)).status, 401);
  const reply = await post({ question: '  Can I afford lunch?  ', context: { safeToSpend: 420 } });
  assert.equal(reply.status, 200);
  assert.deepEqual(await reply.json(), { text: 'Keep your emergency reserve protected.', calculated: [], suggestion: null });
  const callsBeforeInvalid = calls;
  for (const body of [{ question: '' }, {}, { question: 1 }, { question: 'a'.repeat(2001) }]) {
    assert.equal((await post(body)).status, 400);
  }
  assert.equal(calls, callsBeforeInvalid);
  const tooLarge = await post({ question: 'Help', context: { text: 'a'.repeat(40000) } });
  assert.equal(tooLarge.status, 413);
  const unavailable = await post({ question: 'fail' });
  assert.equal(unavailable.status, 502);
  assert.equal((await unavailable.json()).error.code, 'AI_UNAVAILABLE');
  assert.equal((await fetch('/not-found')).status, 404);
  assert.equal((await fetch('/ai/chat', { method: 'POST' })).status, 404);

  const cors = await fetch('/health', { headers: { Origin: 'http://localhost:8081' } });
  assert.equal(cors.headers.get('access-control-allow-origin'), 'http://localhost:8081');
  const denied = await fetch('/health', { headers: { Origin: 'http://untrusted.example' } });
  assert.equal(denied.headers.has('access-control-allow-origin'), false);
  await fetch('/health', { headers: { Origin: 'http://untrusted.example' } });

  // Every request is logged (no bodies), and a blocked browser origin is explained once.
  assert.ok(logs.some((l) => /^GET \/health 200 \d+ ms$/.test(l)));
  assert.ok(logs.some((l) => /^POST \/api\/ai\/chat 502 \d+ ms$/.test(l)));
  assert.ok(logs.some((l) => /^GET \/health 200 \d+ ms origin=http:\/\/localhost:8081$/.test(l)));
  assert.equal(logs.filter((l) => l.startsWith('[cors] Blocked browser requests from http://untrusted.example')).length, 1);
  assert.equal(logs.some((l) => l.includes('Keep your emergency reserve') || l.includes(token)), false);
});

test('sign-in, checkout, payment status and wallet routes: sessions, validation, ownership', async () => {
  const s = services(unusedAi);
  const app = createApp({ ...s, log: () => {} });
  const fetch = (path: string, init?: RequestInit) => request(app, path, init);
  const json = (body: unknown, token?: string) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

  const signIn = await fetch('/api/auth/session', json({ email: ' Bea.Reyes@Example.com ' }));
  assert.equal(signIn.status, 200);
  const { token, userId } = await signIn.json();
  assert.equal(userId, 'bea.reyes@example.com');
  assert.equal((await fetch('/api/auth/session', json({ email: 'not-an-email' }))).status, 400);
  const other = (await (await fetch('/api/auth/session', json({ email: 'someone@else.edu' }))).json()).token;

  const lunch = { paymentId: 'pay-1760414700000', merchantId: 'campus-canteen', amount: 85, reference: 'HM-1014-0042' };
  assert.equal((await fetch('/api/checkout/payments', json(lunch))).status, 401);
  assert.equal((await fetch('/api/checkout/payments', json(lunch, 'forged.token'))).status, 401);
  const created = await fetch('/api/checkout/payments', json(lunch, token));
  assert.equal(created.status, 200);
  const view = await created.json();
  assert.equal(view.status, 'pending');
  assert.equal(view.assetAmount, '11.3333333');
  assert.equal('signedXdr' in view, false);

  for (const bad of [{}, { ...lunch, amount: -1 }, { ...lunch, amount: '85' }, { ...lunch, paymentId: 'x' },
    { ...lunch, reference: 'has spaces' }, { ...lunch, destination: 'GATTACKER' }]) {
    const res = await fetch('/api/checkout/payments', json(bad, token));
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'INVALID_REQUEST');
  }
  const notPayable = await fetch('/api/checkout/payments', json({ ...lunch, paymentId: 'pay-kape', merchantId: 'kape-corner' }, token));
  assert.equal(notPayable.status, 404);
  assert.deepEqual(await notPayable.json(), { error: { code: 'MERCHANT_NOT_PAYABLE', message: "This merchant can't take Hima payments yet." } });

  // Quote first, then pay the quote: same record, one preparation.
  const quoteBody = { ...lunch, paymentId: 'pay-1760414799999' };
  const quoted = await fetch('/api/checkout/quote', json(quoteBody, token));
  assert.equal(quoted.status, 200);
  const quote = await quoted.json();
  assert.equal(quote.state, 'awaiting_authorization');
  assert.deepEqual(quote.split.map((l: { amount: number }) => l.amount), [76.5, 8.5]);
  assert.equal((await fetch('/api/checkout/payments', json({ quoteId: quote.quoteId }, other))).status, 404);
  const paidQuote = await (await fetch('/api/checkout/payments', json({ quoteId: quote.quoteId }, token))).json();
  assert.equal(paidQuote.id, quote.id);
  assert.equal(paidQuote.state, 'pending');
  assert.equal((await fetch('/api/checkout/quote', json({ quoteId: quote.quoteId }, token))).status, 400);

  const auth = (t: string) => ({ headers: { Authorization: `Bearer ${t}` } });
  assert.equal((await (await fetch('/api/payments/pay-1760414700000', auth(token))).json()).id, view.id);
  assert.equal((await fetch(`/api/payments/${view.id}`, auth(token))).status, 200);
  assert.equal((await fetch('/api/payments/pay-1760414700000', auth(other))).status, 404);
  assert.equal((await fetch(`/api/payments/${view.id}`, auth(other))).status, 404);
  assert.equal((await fetch('/api/payments/pay-1760414700000')).status, 401);
  assert.equal((await fetch('/api/payments/%20', auth(token))).status, 400);

  s.horizon.accounts.set(s.student.publicKey(), [{ assetType: 'native', balance: '9988.6666667' }]);
  const wallet = await (await fetch('/api/wallet/stellar', auth(token))).json();
  assert.equal(wallet.publicKey, s.student.publicKey());
  assert.equal(wallet.phpPerUnit, '7.50');
  assert.equal((await fetch('/api/wallet/stellar')).status, 401);
  assert.equal((await fetch('/api/wallet/stellar/accounts/bad', auth(token))).status, 400);
});

test('deployment metadata is public and never includes tokens or secrets', async () => {
  const s = services(unusedAi);
  const app = createApp({ ...s, log: () => {} });
  const res = await request(app, '/api/paiflow/flows');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.flows.map((f: { flow: string; ready: boolean }) => [f.flow, f.ready]), [['checkout', true], ['allowance', false], ['reward', false]]);
  assert.deepEqual(body.flows[0].expected.legs.map((l: { label: string; percent: number }) => [l.label, l.percent]), [['Campus Canteen', 90], ['Your savings', 10]]);
  const raw = JSON.stringify(body);
  for (const secret of [...Object.values(TOKENS), 'whsec-test']) assert.equal(raw.includes(secret), false);
});

test('public readiness follows storage health while liveness retains its contract', async () => {
  const s = services(unusedAi);
  const app = createApp({ ...s, log: () => {} });
  const ready = await request(app, '/ready');
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { status: 'ready' });
  s.attempts.ready = async () => { throw new Error('private database connection details'); };
  const down = await request(app, '/ready');
  assert.equal(down.status, 503);
  assert.deepEqual(await down.json(), { status: 'not_ready' });
  const health = await request(app, '/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok', ai: false, payments: true });
});
