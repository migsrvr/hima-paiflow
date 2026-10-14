import assert from 'node:assert/strict';
import test from 'node:test';
import { splitByPercents } from '../src/services/amounts.js';
import { buildCatalog } from '../src/services/flowCatalog.js';
import { PaymentVerifier } from '../src/services/paymentVerification.js';
import { CANTEEN, FakeHorizon, SAVINGS } from './fakes.js';

const HASH = '207a94233da6622e765d1973ff4e99b0ebb19f4222f66192ead6a16fd6a67d87';
const TOTAL = 113_333_333n; // ₱85 at ₱7.50 per XLM
const legs = (merchant: string | null, savings: string | null) =>
  buildCatalog({ merchant, student: null, savings, emergency: null, rewardAmountStroops: 1n }).checkout.legs;

test('Paiflow splits round each leg down and give the last leg the remainder', () => {
  assert.deepEqual(splitByPercents(TOTAL, [90, 10]), [101_999_999n, 11_333_334n]);
  assert.deepEqual(splitByPercents(120_000_000n, [70, 20, 10]), [84_000_000n, 24_000_000n, 12_000_000n]);
  assert.deepEqual(splitByPercents(99_999_999n, [85, 10, 5]), [84_999_999n, 9_999_999n, 5_000_001n]);
});

test('verifies the live checkout split (ledger 5185778) against the configured recipients', async () => {
  const horizon = new FakeHorizon();
  horizon.credit(HASH, [CANTEEN, '10.1999999'], [SAVINGS, '1.1333334']);
  const v = await new PaymentVerifier({ horizon }).verify(HASH, TOTAL, legs(CANTEEN, SAVINGS));
  assert.equal(v.status, 'verified');
  assert.deepEqual(v.legs.map((l) => [l.role, l.creditedStroops, l.matchedBy, l.ok]), [
    ['merchant', '101999999', 'address', true],
    ['savings', '11333334', 'address', true],
  ]);
  assert.equal(v.note, undefined);
});

test('a recipient that wasn\'t paid its share is a mismatch, with the evidence', async () => {
  const horizon = new FakeHorizon();
  const stranger = 'GDJ7JMWCANIY6BT7SDFWD3XSA7GFZQ5DAZKHOJDXOQZUTBW6HDLUP6BD';
  horizon.credit(HASH, [CANTEEN, '10.1999999'], [SAVINGS, '1.1333334']);
  const logs: string[] = [];
  const v = await new PaymentVerifier({ horizon, log: (m) => logs.push(m) }).verify(HASH, TOTAL, legs(stranger, SAVINGS));
  assert.equal(v.status, 'mismatch');
  assert.deepEqual(v.legs.map((l) => l.ok), [false, true]);
  assert.equal(v.legs[0].creditedStroops, null);
  assert.equal(v.credits.length, 2);
  assert.match(logs[0], /does not match the expected split: Campus Canteen/);

  const short = new FakeHorizon();
  short.credit(HASH, [CANTEEN, '9.0000000'], [SAVINGS, '1.1333334']);
  assert.equal((await new PaymentVerifier({ horizon: short }).verify(HASH, TOTAL, legs(CANTEEN, SAVINGS))).status, 'mismatch');
});

test('without configured recipients, legs are matched by amount and the result says so', async () => {
  const horizon = new FakeHorizon();
  horizon.credit(HASH, [SAVINGS, '1.1333334'], [CANTEEN, '10.1999999']);
  const v = await new PaymentVerifier({ horizon }).verify(HASH, TOTAL, legs(null, null));
  assert.equal(v.status, 'verified');
  assert.deepEqual(v.legs.map((l) => [l.address, l.matchedBy]), [[CANTEEN, 'amount'], [SAVINGS, 'amount']]);
  assert.match(v.note ?? '', /matched by amount/);
});

test('a stroop of rounding is tolerated; Horizon outages and unknown hashes are "unavailable", not failures', async () => {
  const horizon = new FakeHorizon();
  horizon.credit(HASH, [CANTEEN, '10.2000000'], [SAVINGS, '1.1333333']);
  assert.equal((await new PaymentVerifier({ horizon }).verify(HASH, TOTAL, legs(CANTEEN, SAVINGS))).status, 'verified');

  const empty = await new PaymentVerifier({ horizon: new FakeHorizon() }).verify(HASH, TOTAL, legs(CANTEEN, SAVINGS));
  assert.equal(empty.status, 'unavailable');
  assert.match(empty.note ?? '', /hasn't recorded/);
  const down = new FakeHorizon();
  down.down = true;
  assert.equal((await new PaymentVerifier({ horizon: down }).verify(HASH, TOTAL, legs(CANTEEN, SAVINGS))).status, 'unavailable');
});
