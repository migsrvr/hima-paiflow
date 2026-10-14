import { decimalToStroops, splitByPercents } from './amounts.js';
import type { RecipientLeg } from './flowCatalog.js';
import type { HorizonApi } from './horizonClient.js';

/**
 * verified: every expected leg was credited its share. mismatch: a configured recipient wasn't
 * credited what the flow should pay (wrong address, wrong share, or a changed deployment).
 * unavailable: Horizon hasn't got the transaction yet or couldn't be read; check again later.
 */
export type VerificationStatus = 'verified' | 'mismatch' | 'unavailable';

export interface LegResult {
  role: RecipientLeg['role'];
  label: string;
  percent: number;
  /** The configured recipient, or the account matched by amount when none is configured. */
  address: string | null;
  matchedBy: 'address' | 'amount' | null;
  expectedStroops: string;
  creditedStroops: string | null;
  ok: boolean;
}

export interface Verification {
  status: VerificationStatus;
  checkedAt: string;
  legs: LegResult[];
  /** Every native credit the transaction made, for evidence. */
  credits: { account: string; stroops: string }[];
  note?: string;
}

interface VerifierOptions {
  horizon: HorizonApi;
  now?: () => Date;
  log?: (message: string) => void;
}

const abs = (n: bigint) => (n < 0n ? -n : n);

/**
 * Checks a confirmed Paiflow payout against what the deployment is configured to pay, from the
 * transaction's own effects on Horizon (`account_credited`), independent of Paiflow's event format.
 */
export class PaymentVerifier {
  constructor(private readonly options: VerifierOptions) {}

  private now() {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  async verify(txHash: string, totalStroops: bigint, legs: readonly RecipientLeg[]): Promise<Verification> {
    const expected = splitByPercents(totalStroops, legs.map((l) => l.percent));
    const unavailable = (note: string): Verification => ({
      status: 'unavailable',
      checkedAt: this.now(),
      legs: legs.map((l, i) => ({
        role: l.role, label: l.label, percent: l.percent, address: l.address, matchedBy: null,
        expectedStroops: expected[i].toString(), creditedStroops: null, ok: false,
      })),
      credits: [],
      note,
    });

    let raw;
    try {
      raw = await this.options.horizon.credits(txHash);
    } catch {
      return unavailable("Couldn't read the transaction from Horizon.");
    }
    if (!raw) return unavailable("Horizon hasn't recorded this transaction yet.");

    // Native credits per account (a recipient listed twice would be summed).
    const byAccount = new Map<string, bigint>();
    for (const c of raw) {
      if (c.assetType !== 'native') continue;
      const stroops = decimalToStroops(c.amount);
      if (stroops !== undefined) byAccount.set(c.account, (byAccount.get(c.account) ?? 0n) + stroops);
    }
    // Rounding differences of a stroop or two per leg are not a mismatch.
    const tolerance = BigInt(legs.length);
    const claimed = new Set<string>();

    const results: LegResult[] = legs.map((leg, i) => {
      const want = expected[i];
      if (leg.address) {
        const got = byAccount.get(leg.address);
        claimed.add(leg.address);
        return {
          role: leg.role, label: leg.label, percent: leg.percent, address: leg.address, matchedBy: 'address' as const,
          expectedStroops: want.toString(), creditedStroops: got === undefined ? null : got.toString(),
          ok: got !== undefined && abs(got - want) <= tolerance,
        };
      }
      // No recipient configured: accept the account credited this leg's share, and say so.
      const match = [...byAccount].find(([account, got]) => !claimed.has(account) && abs(got - want) <= tolerance);
      if (match) claimed.add(match[0]);
      return {
        role: leg.role, label: leg.label, percent: leg.percent, address: match?.[0] ?? null,
        matchedBy: match ? ('amount' as const) : null,
        expectedStroops: want.toString(), creditedStroops: match ? match[1].toString() : null, ok: Boolean(match),
      };
    });

    const verification: Verification = {
      status: results.every((r) => r.ok) ? 'verified' : 'mismatch',
      checkedAt: this.now(),
      legs: results,
      credits: [...byAccount].map(([account, stroops]) => ({ account, stroops: stroops.toString() })),
    };
    if (results.some((r) => r.matchedBy === 'amount')) {
      verification.note = 'Some recipients were matched by amount because no address is configured for them.';
    }
    if (verification.status === 'mismatch') {
      this.options.log?.(`[verify] ${txHash} does not match the expected split: ${results.filter((r) => !r.ok).map((r) => r.label).join(', ')}.`);
    }
    return verification;
  }
}
