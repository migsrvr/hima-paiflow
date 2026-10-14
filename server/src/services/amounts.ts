// Integer money helpers. PHP amounts are centavos and Stellar amounts are stroops
// (10^7 per unit); neither ever passes through floating-point arithmetic.

export const STROOPS_PER_UNIT = 10_000_000n;

/** "7.50" -> 750. Undefined unless the string is a positive peso amount with at most two decimals. */
export function parseCentavos(value: string): number | undefined {
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return undefined;
  const centavos = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return centavos > 0 ? centavos : undefined;
}

/** 85 -> 8500. Undefined for non-finite, non-positive or sub-centavo amounts. */
export function pesosToCentavos(amount: number): number | undefined {
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const centavos = Math.round(amount * 100);
  return Math.abs(centavos - amount * 100) < 1e-6 && Number.isSafeInteger(centavos) ? centavos : undefined;
}

/** PHP centavos -> stroops of the input asset at `rateCentavos` per unit, rounded half up. */
export function centavosToStroops(centavos: number, rateCentavos: number): bigint {
  if (!Number.isSafeInteger(centavos) || centavos <= 0) throw new RangeError('centavos must be a positive integer');
  if (!Number.isSafeInteger(rateCentavos) || rateCentavos <= 0) throw new RangeError('rate must be a positive integer');
  const rate = BigInt(rateCentavos);
  return (BigInt(centavos) * STROOPS_PER_UNIT * 2n + rate) / (2n * rate);
}

/** 113333333n -> "11.3333333": the exact on-chain amount with all seven decimals. */
export function formatStroops(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / STROOPS_PER_UNIT;
  const fraction = (abs % STROOPS_PER_UNIT).toString().padStart(7, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/** Horizon's "9988.6666667" -> 99886666667n. Undefined unless it is a plain decimal with at most seven places. */
export function decimalToStroops(value: string): bigint | undefined {
  const match = /^(\d+)(?:\.(\d{1,7}))?$/.exec(value.trim());
  if (!match) return undefined;
  return BigInt(match[1]) * STROOPS_PER_UNIT + BigInt((match[2] ?? '').padEnd(7, '0'));
}

/**
 * Splits `total` by whole-number percentages the way Paiflow's Split pays out on-chain: every leg
 * but the last is rounded down, and the last leg receives the remainder. Observed live:
 * 11.3333333 XLM at 90/10 paid 10.1999999 and 1.1333334.
 */
export function splitByPercents(total: bigint, percents: readonly number[]): bigint[] {
  let paid = 0n;
  return percents.map((percent, i) => {
    if (i === percents.length - 1) return total - paid;
    const leg = (total * BigInt(percent)) / 100n;
    paid += leg;
    return leg;
  });
}

/** 750 -> "7.50". */
export function formatCentavos(centavos: number): string {
  return `${Math.floor(centavos / 100)}.${String(centavos % 100).padStart(2, '0')}`;
}
