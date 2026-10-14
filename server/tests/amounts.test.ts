import assert from 'node:assert/strict';
import test from 'node:test';
import {
  centavosToStroops, decimalToStroops, formatCentavos, formatStroops, parseCentavos, pesosToCentavos,
} from '../src/services/amounts.js';

test('converts PHP centavos to stroops at the demo rate with integer math', () => {
  assert.equal(centavosToStroops(8500, 750), 113_333_333n); // ₱85 = 11.3333333 XLM
  assert.equal(formatStroops(centavosToStroops(8500, 750)), '11.3333333');
  assert.equal(formatStroops(centavosToStroops(150_000, 750)), '200.0000000'); // ₱1,500 = 200 XLM
  assert.equal(formatStroops(centavosToStroops(1, 750)), '0.0013333'); // ₱0.01, rounded half up
  assert.equal(centavosToStroops(2, 3), 6_666_667n); // 0.66666666… units: the last stroop rounds up
  assert.equal(formatStroops(centavosToStroops(500_000, 5800)), '86.2068966'); // ₱5,000 at ₱58 per USDC
});

test('rejects amounts that are not whole centavos', () => {
  assert.equal(pesosToCentavos(85), 8500);
  assert.equal(pesosToCentavos(0.1 + 0.2), 30);
  assert.equal(pesosToCentavos(12.345), undefined);
  assert.equal(pesosToCentavos(0), undefined);
  assert.equal(pesosToCentavos(-5), undefined);
  assert.equal(pesosToCentavos(Number.NaN), undefined);
  assert.throws(() => centavosToStroops(0, 750));
  assert.throws(() => centavosToStroops(100, 0));
});

test('parses the configured rate and Horizon balances', () => {
  assert.equal(parseCentavos('7.50'), 750);
  assert.equal(parseCentavos('7.5'), 750);
  assert.equal(parseCentavos('58'), 5800);
  assert.equal(parseCentavos('0'), undefined);
  assert.equal(parseCentavos('7.505'), undefined);
  assert.equal(parseCentavos('abc'), undefined);
  assert.equal(formatCentavos(750), '7.50');
  assert.equal(decimalToStroops('9988.6666667'), 99_886_666_667n);
  assert.equal(decimalToStroops('10000'), 100_000_000_000n);
  assert.equal(decimalToStroops('1.12345678'), undefined);
});
