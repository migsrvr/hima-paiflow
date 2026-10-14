import { STROOPS_PER_UNIT } from './amounts.js';

/**
 * What each Paiflow deployment is configured to pay, mirrored from the flows built in the Paiflow
 * builder. Paiflow holds the real configuration (recipients are fixed there); Hima uses this
 * mirror to show expected splits and to verify on-chain payouts against them, so any drift between
 * the two shows up as a verification mismatch instead of going unnoticed.
 */
export type RecipientRole = 'merchant' | 'spending' | 'savings' | 'emergency';

export interface RecipientLeg {
  role: RecipientRole;
  label: string;
  /** Public address the deployment pays; null until configured in server/.env. */
  address: string | null;
  percent: number;
}

export interface FlowCatalog {
  /** Flow 1: Receive (XLM) → Split. */
  checkout: { legs: RecipientLeg[] };
  /** Flow 2: Receive (XLM) → Condition amount > threshold → one of two Splits. */
  allowance: { thresholdStroops: string; whenAbove: RecipientLeg[]; otherwise: RecipientLeg[] };
  /** Flow 3: Webhook → Pay, released from the pre-funded pool. */
  reward: { recipient: RecipientLeg; amountStroops: string };
}

interface CatalogWallets {
  merchant: string | null;
  student: string | null;
  savings: string | null;
  emergency: string | null;
  rewardAmountStroops: bigint;
  /** Addresses a deployment was actually built with, when they differ from the wallets above. */
  overrides?: {
    checkout?: Partial<Record<'merchant' | 'savings', string>>;
    allowance?: Partial<Record<'spending' | 'savings' | 'emergency', string>>;
    reward?: string;
  };
}

/** Flow 2's condition: strictly more than 10 XLM takes the TRUE branch; exactly 10 XLM does not. */
export const ALLOWANCE_THRESHOLD_STROOPS = 10n * STROOPS_PER_UNIT;

export function buildCatalog(w: CatalogWallets): FlowCatalog {
  const leg = (role: RecipientRole, label: string, address: string | null, percent: number): RecipientLeg => ({ role, label, address, percent });
  const c = w.overrides?.checkout ?? {};
  const a = w.overrides?.allowance ?? {};
  const spending = a.spending ?? w.student;
  const savings = a.savings ?? w.savings;
  const emergency = a.emergency ?? w.emergency;
  return {
    checkout: { legs: [leg('merchant', 'Campus Canteen', c.merchant ?? w.merchant, 90), leg('savings', 'Your savings', c.savings ?? w.savings, 10)] },
    allowance: {
      thresholdStroops: ALLOWANCE_THRESHOLD_STROOPS.toString(),
      whenAbove: [leg('spending', 'Spending', spending, 70), leg('savings', 'Savings', savings, 20), leg('emergency', 'Emergency', emergency, 10)],
      otherwise: [leg('spending', 'Spending', spending, 85), leg('savings', 'Savings', savings, 10), leg('emergency', 'Emergency', emergency, 5)],
    },
    reward: { recipient: leg('savings', 'Your savings', w.overrides?.reward ?? w.savings, 100), amountStroops: w.rewardAmountStroops.toString() },
  };
}
