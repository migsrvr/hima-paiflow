import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair } from '@stellar/stellar-sdk';
import { ServiceError } from '../src/services/errors.js';
import { WalletService } from '../src/services/walletService.js';
import { CHECKOUT_TRIGGER, Clock, FakeHorizon, FakePaiflow, fakeRegistry, IDS } from './fakes.js';

const student = Keypair.random();

function setup(configure?: (p: FakePaiflow) => void) {
  const clock = new Clock();
  const paiflow = new FakePaiflow(clock, IDS.checkout);
  configure?.(paiflow);
  const horizon = new FakeHorizon();
  const wallet = new WalletService({ registry: fakeRegistry(clock, { checkout: paiflow }), horizon, student, rateCentavos: 750, now: clock.now });
  return { horizon, wallet };
}

test('reports the real balance, asset, demo rate and checkout readiness, and never invents a balance', async () => {
  const { horizon, wallet } = setup();
  horizon.accounts.set(student.publicKey(), [{ assetType: 'native', balance: '9988.6666667' }]);
  const view = await wallet.wallet();
  assert.equal(view.publicKey, student.publicKey());
  assert.equal(view.balance, '9988.6666667');
  assert.deepEqual(view.asset, { code: 'XLM', kind: 'native' });
  assert.equal(view.phpPerUnit, '7.50');
  assert.equal(view.paiflow.ready, true);
  assert.equal(view.paiflow.triggerContract, CHECKOUT_TRIGGER);
  assert.equal(view.explorerAccountUrl, `https://stellar.expert/explorer/testnet/account/${student.publicKey()}`);

  horizon.down = true;
  const offline = await wallet.wallet();
  assert.equal(offline.balance, null);
  assert.equal(offline.balanceError, 'HORIZON_UNAVAILABLE');
});

test('a USDC checkout deployment shows as not ready, with the reason', async () => {
  const { wallet } = setup((p) => { p.inputAsset = { kind: 'known', symbol: 'USDC' }; });
  const view = await wallet.wallet();
  assert.equal(view.paiflow.ready, false);
  assert.deepEqual(view.paiflow.problems, ['Input asset is USDC; Hima prices these payments in XLM.']);
  assert.equal(view.balance, null);
  assert.equal(view.balanceError, 'ACCOUNT_NOT_FUNDED');
});

test('Freighter lookups validate the address and read its testnet balance', async () => {
  const { horizon, wallet } = setup();
  const freighter = Keypair.random().publicKey();
  await assert.rejects(wallet.lookupAccount('GNOTAKEY'), (e: unknown) => e instanceof ServiceError && e.code === 'INVALID_ADDRESS');
  assert.deepEqual(await wallet.lookupAccount(freighter), {
    address: freighter, exists: false, assetCode: 'XLM', balance: null,
    explorerAccountUrl: `https://stellar.expert/explorer/testnet/account/${freighter}`,
  });
  horizon.accounts.set(freighter, [{ assetType: 'native', balance: '120.5000000' }]);
  assert.equal((await wallet.lookupAccount(freighter)).balance, '120.5000000');
});

test('without a student wallet the server says so instead of guessing', async () => {
  const clock = new Clock();
  const wallet = new WalletService({ registry: fakeRegistry(clock, {}), horizon: new FakeHorizon(), rateCentavos: 750 });
  await assert.rejects(wallet.wallet(), (e: unknown) => e instanceof ServiceError && e.code === 'STELLAR_NOT_CONFIGURED');
});
