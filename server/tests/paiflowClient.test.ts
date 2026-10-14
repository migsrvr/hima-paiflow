import assert from 'node:assert/strict';
import test from 'node:test';
import { PaiflowClient } from '../src/integrations/paiflow/client.js';
import { PaiflowError } from '../src/integrations/paiflow/errors.js';

const DEPLOYMENT = 'd3496d67-891b-46c8-bedb-55fe0bef5f0f';
const TOKEN = `pfk_${'a'.repeat(64)}`;
const HASH = '94be52e8a937b6ddcb85da7cd917f97d412753e5e3ca47ea48b252a264b2278d';
const ORIGIN = 'https://beta.app.paiflow.xyz';

function clientWith(fetchImpl: typeof fetch, extra: { webhookSecret?: string; baseUrl?: string } = {}) {
  return new PaiflowClient({ baseUrl: extra.baseUrl ?? `${ORIGIN}/`, deploymentId: DEPLOYMENT, token: TOKEN, webhookSecret: extra.webhookSecret, fetchImpl });
}

test('prepares an execute deposit with the deployment token and keeps the request id', async () => {
  const client = clientWith(async (url, init) => {
    assert.equal(url, `${ORIGIN}/api/v1/deployments/${DEPLOYMENT}/execute`);
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${TOKEN}`);
    assert.deepEqual(JSON.parse(String(init?.body)), { from: 'GABC', amount: '113333333' });
    return Response.json(
      { data: { xdr: 'AAAA', networkPassphrase: 'Test SDF Network ; September 2015', network: 'testnet', expiresAt: '2026-10-14T05:00:00.000Z' } },
      { headers: { 'x-history-request-id': '0c9d7a3e-5b1f-4e2a-8d6c-7f4b3a2e1d0c' } },
    );
  });
  const prepared = await client.prepareExecute('GABC', '113333333');
  assert.equal(prepared.xdr, 'AAAA');
  assert.equal(prepared.requestId, '0c9d7a3e-5b1f-4e2a-8d6c-7f4b3a2e1d0c');
});

test('the old /api/v1 base URL still resolves to the same endpoints', async () => {
  const client = clientWith(async (url) => {
    assert.equal(url, `${ORIGIN}/api/v1/deployments/${DEPLOYMENT}/capabilities`);
    return Response.json({ data: { deploymentId: DEPLOYMENT, network: 'testnet', triggerType: 'deposit', inputAsset: { kind: 'native' }, operations: {} } });
  }, { baseUrl: `${ORIGIN}/api/v1` });
  assert.deepEqual((await client.capabilities()).inputAsset, { kind: 'native' });
});

test('submits without waiting and forwards the preparation request id', async () => {
  const client = clientWith(async (url, init) => {
    assert.equal(url, `${ORIGIN}/api/v1/deployments/${DEPLOYMENT}/execute/submit?wait=false`);
    assert.equal(new Headers(init?.headers).get('x-preparation-request-id'), 'req-1');
    assert.deepEqual(JSON.parse(String(init?.body)), { signedXdr: 'SIGNED' });
    return Response.json({ data: { txHash: HASH.toUpperCase(), status: 'FAILED', ledger: 7, error: { code: 'txTooLate', message: 'Expired' } } });
  });
  assert.deepEqual(await client.submitExecute('SIGNED', { requestId: 'req-1' }), {
    txHash: HASH, status: 'FAILED', ledger: 7, error: { code: 'txTooLate', message: 'Expired' },
  });
});

test('reads transaction status; an unattributed hash is null, not a failure', async () => {
  const client = clientWith(async (url) => String(url).endsWith(HASH)
    ? Response.json({ data: { txHash: HASH, network: 'testnet', status: 'UNKNOWN' } })
    : Response.json({ error: { code: 'NOT_FOUND', message: 'Not attributed' } }, { status: 404 }));
  assert.equal((await client.transactionStatus(HASH))?.status, 'UNKNOWN');
  assert.equal(await client.transactionStatus('0'.repeat(64)), null);
});

test('webhook releases use the webhook secret (never the pfk_ token) and always carry an idempotency key', async () => {
  const seen: { url: string; headers: Headers; body: unknown }[] = [];
  const replies = [
    Response.json({ data: { attemptId: '6b1f0c52-3d4e-4a8b-9c7d-2e5f8a1b3c4d', network: 'testnet', status: 'PENDING' } }, { status: 202 }),
    Response.json({ data: { attemptId: '6b1f0c52-3d4e-4a8b-9c7d-2e5f8a1b3c4d', txHash: HASH, network: 'testnet', status: 'SUCCESS', ledger: 9 } }),
  ];
  const client = clientWith(async (url, init) => {
    seen.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return replies.shift() as Response;
  }, { webhookSecret: 'whsec-123' });

  const first = await client.webhook({ escrow: true, amount: '50000000' }, { idempotencyKey: 'hima-reward:abc:under-allocation:2026-10-12' });
  assert.deepEqual(first, { attemptId: '6b1f0c52-3d4e-4a8b-9c7d-2e5f8a1b3c4d', txHash: undefined, status: 'PENDING', ledger: undefined, error: undefined, httpStatus: 202 });
  const replay = await client.webhook({ escrow: true, amount: '50000000' }, { idempotencyKey: 'hima-reward:abc:under-allocation:2026-10-12' });
  assert.equal(replay.status, 'SUCCESS');
  assert.equal(replay.txHash, HASH);

  assert.equal(seen[0].url, `${ORIGIN}/api/webhooks/${DEPLOYMENT}`);
  assert.equal(seen[0].headers.get('x-webhook-secret'), 'whsec-123');
  assert.equal(seen[0].headers.get('authorization'), null);
  assert.equal(seen[0].headers.get('idempotency-key'), 'hima-reward:abc:under-allocation:2026-10-12');
  assert.deepEqual(seen[0].body, { escrow: true, amount: '50000000' });

  const noSecret = clientWith(async () => { throw new Error('must not fetch'); });
  await assert.rejects(noSecret.webhook({ escrow: true, amount: '1' }, { idempotencyKey: 'k' }), (e: unknown) =>
    e instanceof PaiflowError && e.code === 'NOT_CONFIGURED');
  await assert.rejects(client.webhook({ escrow: true, amount: '1' }, { idempotencyKey: 'has spaces' }), (e: unknown) =>
    e instanceof PaiflowError && e.code === 'VALIDATION');
});

test('reads balances and funding nodes, and prepares, submits and reconciles funding', async () => {
  const client = clientWith(async (url, init) => {
    const path = String(url).replace(`${ORIGIN}/api/v1/deployments/${DEPLOYMENT}`, '');
    if (path === '/balances') {
      return Response.json({ data: {
        deploymentId: DEPLOYMENT, network: 'testnet',
        totals: [{ tokenContract: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC', balanceStroops: '500000000' }],
        nodes: [{ nodeId: 'webhook', templateKind: 'WEBHOOK', contractAddress: 'CB', tokenContract: 'CDLZ', balanceStroops: '500000000', readAt: 'x', stale: false }],
        freshness: { status: 'fresh', totalsComplete: true, attemptedAt: 'x', cached: false },
      } });
    }
    if (path === '/funding' && init?.method === 'GET') {
      return Response.json({ data: { deploymentId: DEPLOYMENT, network: 'testnet', nodes: [
        { nodeId: 'webhook', templateKind: 'WEBHOOK', contractAddress: 'CB', action: 'webhook.fund', tokenContractAddress: 'CDLZ', authorization: 'funding_wallet', effect: 'Adds funds only' },
      ] } });
    }
    if (path === '/funding') {
      assert.deepEqual(JSON.parse(String(init?.body)), { nodeId: 'webhook', fromAddress: 'GSPONSOR', tokenContractAddress: 'CDLZ', amountStroops: '500000000' });
      return Response.json({ data: {
        intent: 'i-1', txHash: HASH, expiresAt: 'x', xdr: 'XDR', action: 'webhook.fund', nodeId: 'webhook',
        fromAddress: 'GSPONSOR', tokenContractAddress: 'CDLZ', amountStroops: '500000000', network: 'testnet', networkPassphrase: 'Test SDF Network ; September 2015',
      } });
    }
    if (path === '/funding/submit') return Response.json({ data: { txHash: HASH, network: 'testnet', status: 'SUCCESS', ledger: 4 } });
    if (path === '/funding/reconcile') return Response.json({ data: { intent: 'i-1', action: 'webhook.fund', txHash: HASH, network: 'testnet', state: 'SUCCESS', expiresAt: 'x' } });
    throw new Error(`unexpected ${path}`);
  });
  const balances = await client.balances();
  assert.equal(balances.totals[0].balanceStroops, '500000000');
  assert.equal(balances.freshness, 'fresh');
  assert.equal(balances.totalsComplete, true);
  assert.deepEqual((await client.discoverFunding()).map((n) => n.action), ['webhook.fund']);
  const prepared = await client.prepareFunding({ nodeId: 'webhook', fromAddress: 'GSPONSOR', tokenContractAddress: 'CDLZ', amountStroops: '500000000' });
  assert.equal(prepared.intent, 'i-1');
  assert.equal((await client.submitFunding({ action: 'webhook.fund', intent: 'i-1', signedXdr: 'S' })).status, 'SUCCESS');
  assert.equal((await client.reconcileFunding({ action: 'webhook.fund', intent: 'i-1' })).state, 'SUCCESS');
});

test('maps errors: refusals, throttling with Retry-After, and no answer at all', async () => {
  const refused = clientWith(async () => Response.json({ error: { code: 'INSUFFICIENT_FUNDS', message: 'from does not exist' } }, { status: 402 }));
  await assert.rejects(refused.prepareExecute('GABC', '1'), (error: unknown) =>
    error instanceof PaiflowError && error.code === 'INSUFFICIENT_FUNDS' && error.refused);

  const throttled = clientWith(async () => Response.json({ error: { code: 'RATE_LIMITED', message: 'Slow down' } }, { status: 429, headers: { 'Retry-After': '12' } }));
  await assert.rejects(throttled.submitExecute('SIGNED'), (error: unknown) =>
    error instanceof PaiflowError && error.code === 'RATE_LIMITED' && !error.refused && error.retryAfterMs === 12_000);

  const down = clientWith(async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(down.submitExecute('SIGNED'), (error: unknown) =>
    error instanceof PaiflowError && error.code === 'NETWORK' && !error.refused);

  const slow = clientWith(async () => { throw new DOMException('Timed out', 'TimeoutError'); });
  await assert.rejects(slow.capabilities(), (error: unknown) => error instanceof PaiflowError && error.code === 'TIMEOUT');
});

test('a client without a token never makes a request', async () => {
  const client = new PaiflowClient({
    baseUrl: ORIGIN, deploymentId: DEPLOYMENT, token: '',
    fetchImpl: async () => { throw new Error('must not fetch'); },
  });
  assert.equal(client.configured, false);
  await assert.rejects(client.capabilities(), (error: unknown) => error instanceof PaiflowError && error.code === 'NOT_CONFIGURED');
});
