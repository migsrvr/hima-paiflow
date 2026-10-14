import { formatStroops } from './amounts.js';
import type { AttemptFailure, AttemptStatus, PaymentAttempt } from './attemptStore.js';

export const EXPLORER_BASE = 'https://stellar.expert/explorer/testnet';

/**
 * What clients see of an attempt. Never includes the signed envelope, request ids or anything secret.
 * `status` is the three-state outcome the app shows (pending until final); `state` is the full lifecycle.
 */
export interface AttemptView {
  id: string;
  flow: PaymentAttempt['flow'];
  /** The client's idempotency key (the app's payment id for checkout). */
  paymentId: string;
  status: 'pending' | 'confirmed' | 'failed' | 'cancelled';
  state: AttemptStatus;
  /** PHP, checkout only. */
  amount?: number;
  merchantId?: string;
  reference?: string;
  assetCode: string;
  /** Exact on-chain amount, seven decimals ("11.3333333"). */
  assetAmount: string;
  txHash?: string;
  ledger?: number;
  explorerUrl?: string;
  failure?: AttemptFailure;
  submittedAt: string;
  settledAt?: string;
}

export function attemptView(a: PaymentAttempt): AttemptView {
  const status = a.status === 'confirmed' || a.status === 'failed' || a.status === 'cancelled' ? a.status : 'pending';
  const settledAt = a.confirmedAt ?? (status === 'failed' || status === 'cancelled' ? a.updatedAt : undefined);
  return {
    id: a.id,
    flow: a.flow,
    paymentId: a.idempotencyKey,
    status,
    state: a.status,
    ...(a.amountCentavos !== undefined ? { amount: a.amountCentavos / 100 } : {}),
    ...(a.merchantId ? { merchantId: a.merchantId } : {}),
    ...(a.reference ? { reference: a.reference } : {}),
    assetCode: a.assetCode,
    assetAmount: formatStroops(BigInt(a.amountStroops)),
    ...(a.txHash ? { txHash: a.txHash, explorerUrl: `${EXPLORER_BASE}/tx/${a.txHash}` } : {}),
    ...(a.ledger ? { ledger: a.ledger } : {}),
    ...(a.failure ? { failure: a.failure } : {}),
    submittedAt: a.createdAt,
    ...(settledAt ? { settledAt } : {}),
  };
}
