import assert from 'node:assert/strict';
import test from 'node:test';
import { PaiflowError } from '../src/integrations/paiflow/errors.js';
import { Clock, FakePaiflow, fakeRegistry, IDS } from './fakes.js';

test('each flow uses only its own deployment; a missing one is an error, never a fallback', async () => {
  const clock = new Clock();
  const checkout = new FakePaiflow(clock, IDS.checkout);
  const registry = fakeRegistry(clock, { checkout });
  assert.equal(registry.client('checkout'), checkout);
  assert.equal(registry.configured('allowance'), false);
  assert.throws(() => registry.client('allowance'), (e: unknown) => e instanceof PaiflowError && e.code === 'FLOW_NOT_CONFIGURED');
  assert.throws(() => registry.client('reward'), (e: unknown) => e instanceof PaiflowError && e.code === 'FLOW_NOT_CONFIGURED');

  const allowance = await registry.status('allowance');
  assert.equal(allowance.ready, false);
  assert.deepEqual(allowance.problems, ['Not configured (missing deployment id, API token).']);
  const reward = await registry.status('reward');
  assert.deepEqual(reward.problems, ['Not configured (missing deployment id, API token, webhook secret).']);
});

test('a webhook flow without its webhook secret is not configured', () => {
  const clock = new Clock();
  const registry = fakeRegistry(clock, { reward: new FakePaiflow(clock, IDS.reward) }, { reward: { webhookSecret: undefined } });
  assert.equal(registry.configured('reward'), false);
});

test('readiness reports a USDC deployment, the wrong trigger and unsupported operations', async () => {
  const clock = new Clock();
  const checkout = new FakePaiflow(clock, IDS.checkout);
  checkout.inputAsset = { kind: 'known', symbol: 'USDC' };
  const reward = new FakePaiflow(clock, IDS.reward);
  reward.triggerType = 'deposit';
  const registry = fakeRegistry(clock, { checkout, reward });

  const c = await registry.status('checkout');
  assert.equal(c.ready, false);
  assert.deepEqual(c.problems, ['Input asset is USDC; Hima prices these payments in XLM.']);

  const r = await registry.status('reward');
  assert.equal(r.ready, false);
  assert.deepEqual(r.problems, [
    'Deployment is deposit-triggered; Hima expects webhook.',
    'Paiflow does not support webhook calls for this deployment (enable HTTP callbacks).',
  ]);
});

test('a correct deployment is ready; status is cached for five minutes; outages are not cached', async () => {
  const clock = new Clock();
  const allowance = new FakePaiflow(clock, IDS.allowance);
  const reward = new FakePaiflow(clock, IDS.reward);
  reward.triggerType = 'webhook';
  reward.operations = { webhook: { status: 'supported', authentication: 'webhook_secret', requirements: [], nodeIds: [] } };
  const registry = fakeRegistry(clock, { allowance, reward });

  assert.equal((await registry.status('allowance')).ready, true);
  assert.equal((await registry.status('reward')).ready, true);
  await registry.status('allowance');
  assert.equal(allowance.capabilityReads, 1);
  clock.advance(5 * 60_000 + 1);
  await registry.status('allowance');
  assert.equal(allowance.capabilityReads, 2);

  allowance.onCapabilities = async () => { throw new PaiflowError('UPSTREAM_RPC', 502, 'busy'); };
  const down = await registry.status('allowance', { fresh: true });
  assert.deepEqual(down.problems, ['Could not read capabilities: UPSTREAM_RPC (502).']);
  allowance.onCapabilities = new FakePaiflow(clock, IDS.allowance).onCapabilities;
  assert.equal((await registry.status('allowance')).ready, true);
});
