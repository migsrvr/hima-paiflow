import { randomUUID } from 'node:crypto';
import type { Keypair } from '@stellar/stellar-sdk';
import type { PaiflowRegistry } from '../integrations/paiflow/registry.js';
import { centavosToStroops, decimalToStroops, formatCentavos, formatStroops, pesosToCentavos, splitByPercents } from './amounts.js';
import type { AttemptStore, PaymentAttempt } from './attemptStore.js';
import { attemptView, type AttemptView } from './attemptView.js';
import type { DepositExecutor } from './depositExecutor.js';
import { ServiceError } from './errors.js';
import type { RecipientLeg } from './flowCatalog.js';
import type { HorizonApi } from './horizonClient.js';
import type { PaymentVerifier, Verification } from './paymentVerification.js';

/** Merchants Hima can pay: each maps to the checkout deployment whose Split pays that merchant. */
const PAYABLE_MERCHANTS = new Set(['campus-canteen']);
/** How long a quote waits for the student to authorize it. */
export const QUOTE_TTL_MS = 5 * 60_000;
/** The paying account keeps 1 XLM base reserve, plus room for the deposit's network fee. */
const RESERVE_STROOPS = 15_000_000n;
/** A verification Horizon couldn't answer yet is retried at most this often. */
const VERIFY_RETRY_MS = 10_000;

export interface CheckoutRequest {
  /** The app's payment id: the idempotency key for this checkout. */
  paymentId: string;
  merchantId: string;
  /** PHP, at most two decimals. */
  amount: number;
  /** The Hima receipt reference ("HM-1014-0042"). */
  reference: string;
}

export interface SplitLine {
  role: RecipientLeg['role'];
  label: string;
  percent: number;
  /** PHP share of the price the student pays. */
  amount: number;
  /** Seven-decimal XLM share as the Split pays it (the last leg takes the rounding remainder). */
  assetAmount: string;
}

export interface CheckoutView extends AttemptView {
  /** The quote this payment was priced from (the attempt id). */
  quoteId: string;
  /** While awaiting authorization: when the quote lapses. */
  quoteExpiresAt?: string;
  split: SplitLine[];
  /** The student's 10% auto-save. On-chain amount is the verified credit once confirmed. */
  autoSaved: { amount: number; assetAmount: string; verified: boolean } | null;
  verification?: {
    status: Verification['status'];
    checkedAt: string;
    legs: { role: string; label: string; ok: boolean; assetAmount: string | null; address: string | null }[];
    note?: string;
  };
}

interface CheckoutOptions {
  executor: DepositExecutor;
  registry: PaiflowRegistry;
  store: AttemptStore;
  horizon: HorizonApi;
  verifier: PaymentVerifier;
  /** The checkout deployment's Split, mirrored from the flow catalog. */
  legs: readonly RecipientLeg[];
  /** The student's paying wallet (server-held). */
  student?: Keypair;
  rateCentavos: number;
  maxPaymentCentavos: number;
  now?: () => Date;
  log?: (message: string) => void;
}

interface StoredSplit {
  legs: { role: RecipientLeg['role']; label: string; percent: number; centavos: number; stroops: string }[];
}

/**
 * Flow 1, NFC merchant checkout: quote → authorize → pay → verify. The PHP budget and
 * Safe-to-Spend stay in the app's tested engine; the server enforces the merchant allowlist,
 * limits, on-chain funds, ownership and settlement, and verifies the Split on Horizon.
 */
export class CheckoutService {
  constructor(private readonly options: CheckoutOptions) {}

  get configured(): boolean {
    return Boolean(this.options.student);
  }

  private now() {
    return this.options.now?.() ?? new Date();
  }

  /** Prices a checkout and holds it for authorization. Nothing is prepared or signed yet. */
  async quote(userId: string, request: CheckoutRequest): Promise<CheckoutView> {
    const { centavos, student } = this.validate(request);
    const amountStroops = centavosToStroops(centavos, this.options.rateCentavos);

    const existing = await this.options.store.findByKey(userId, 'checkout', request.paymentId);
    if (existing) {
      if (existing.amountCentavos !== centavos || existing.merchantId !== request.merchantId || existing.reference !== request.reference) {
        throw new ServiceError('PAYMENT_ID_REUSED', 409, 'This payment id was already used for a different payment.');
      }
      return this.present(await this.expireIfLapsed(existing));
    }

    const flow = await this.options.registry.status('checkout');
    if (!flow.ready) throw new ServiceError('FLOW_NOT_READY', 503, `${flow.label} isn't ready: ${flow.problems[0] ?? 'unknown problem'}`);
    await this.checkFunds(student.publicKey(), amountStroops);

    const stroopsLegs = splitByPercents(amountStroops, this.options.legs.map((l) => l.percent));
    const centavoLegs = splitByPercents(BigInt(centavos), this.options.legs.map((l) => l.percent));
    const split: StoredSplit = {
      legs: this.options.legs.map((l, i) => ({
        role: l.role, label: l.label, percent: l.percent, centavos: Number(centavoLegs[i]), stroops: stroopsLegs[i].toString(),
      })),
    };
    const at = this.now();
    const attempt: PaymentAttempt = {
      id: `att_${randomUUID()}`,
      userId,
      flow: 'checkout',
      deploymentId: this.options.registry.config('checkout').deploymentId,
      idempotencyKey: request.paymentId,
      kind: 'deposit',
      amountStroops: amountStroops.toString(),
      assetCode: 'XLM',
      assetIssuer: null,
      amountCentavos: centavos,
      merchantId: request.merchantId,
      reference: request.reference,
      from: student.publicKey(),
      status: 'awaiting_authorization',
      meta: { split, quoteExpiresAt: new Date(at.getTime() + QUOTE_TTL_MS).toISOString() },
      createdAt: at.toISOString(),
      updatedAt: at.toISOString(),
    };
    const claimed = await this.options.store.create(attempt);
    if (claimed.amountCentavos !== centavos || claimed.merchantId !== request.merchantId || claimed.reference !== request.reference) {
      throw new ServiceError('PAYMENT_ID_REUSED', 409, 'This payment id was already used for a different payment.');
    }
    return this.present(await this.expireIfLapsed(claimed));
  }

  /**
   * Pays an authorized quote. `{ quoteId }` pays an existing quote; a full request quotes and pays
   * in one step. Repeating either never pays twice.
   */
  async pay(userId: string, input: { quoteId: string } | CheckoutRequest): Promise<CheckoutView> {
    let attempt: PaymentAttempt;
    if ('quoteId' in input) {
      const found = await this.options.store.get(input.quoteId);
      if (!found || found.userId !== userId || found.flow !== 'checkout') {
        throw new ServiceError('PAYMENT_NOT_FOUND', 404, 'No payment with this id reached the server.');
      }
      attempt = found;
    } else {
      const quoted = await this.quote(userId, input);
      attempt = (await this.options.store.get(quoted.id))!;
    }

    attempt = await this.expireIfLapsed(attempt);
    if (attempt.status === 'cancelled') {
      throw new ServiceError('QUOTE_EXPIRED', 409, attempt.failure?.reason ?? 'This checkout expired. Start again.');
    }
    const student = this.options.student;
    if (!student) throw new ServiceError('STELLAR_NOT_CONFIGURED', 503, "Hima's testnet wallet isn't set up on the server yet.");
    const next = await this.options.executor.start({
      flow: 'checkout',
      userId,
      idempotencyKey: attempt.idempotencyKey,
      signer: student,
      amountStroops: BigInt(attempt.amountStroops),
      amountCentavos: attempt.amountCentavos,
      merchantId: attempt.merchantId,
      reference: attempt.reference,
    });
    return this.present(next);
  }

  /** The client view of a checkout attempt; verifies the Split on Horizon once it is confirmed. */
  async present(attempt: PaymentAttempt): Promise<CheckoutView> {
    return this.options.store.withLock(attempt.id, async () => {
      let current = await this.options.store.get(attempt.id);
      if (!current) throw new ServiceError('PAYMENT_NOT_FOUND', 404, 'No payment with this id reached the server.');
      if (current.status === 'confirmed' && current.txHash && this.needsVerification(current)) {
        const verification = await this.options.verifier.verify(current.txHash, BigInt(current.amountStroops), this.options.legs);
        current = { ...current, meta: { ...current.meta, verification }, updatedAt: this.now().toISOString() };
        await this.options.store.put(current);
      }
      return this.view(current);
    });
  }

  private needsVerification(a: PaymentAttempt): boolean {
    const v = a.meta?.verification as Verification | undefined;
    if (!v) return true;
    return v.status === 'unavailable' && this.now().getTime() - Date.parse(v.checkedAt) >= VERIFY_RETRY_MS;
  }

  /** The stored quote split, or (for payments made before quotes) the same split computed from the flow. */
  private splitOf(a: PaymentAttempt): StoredSplit['legs'] {
    const stored = (a.meta?.split as StoredSplit | undefined)?.legs;
    if (stored) return stored;
    if (a.amountCentavos === undefined) return [];
    const percents = this.options.legs.map((l) => l.percent);
    const stroops = splitByPercents(BigInt(a.amountStroops), percents);
    const centavos = splitByPercents(BigInt(a.amountCentavos), percents);
    return this.options.legs.map((l, i) => ({ role: l.role, label: l.label, percent: l.percent, centavos: Number(centavos[i]), stroops: stroops[i].toString() }));
  }

  private view(a: PaymentAttempt): CheckoutView {
    const split = this.splitOf(a);
    const verification = a.meta?.verification as Verification | undefined;
    const savings = split.find((l) => l.role === 'savings');
    const savingsCredit = verification?.legs.find((l) => l.role === 'savings');
    const verifiedSavings = verification?.status === 'verified' && savingsCredit?.creditedStroops ? savingsCredit.creditedStroops : null;
    const quoteExpiresAt = typeof a.meta?.quoteExpiresAt === 'string' && a.status === 'awaiting_authorization' ? a.meta.quoteExpiresAt : undefined;
    return {
      ...attemptView(a),
      quoteId: a.id,
      ...(quoteExpiresAt ? { quoteExpiresAt } : {}),
      split: split.map((l) => ({
        role: l.role, label: l.label, percent: l.percent, amount: l.centavos / 100, assetAmount: formatStroops(BigInt(l.stroops)),
      })),
      autoSaved: savings
        ? {
          amount: savings.centavos / 100,
          assetAmount: formatStroops(BigInt(verifiedSavings ?? savings.stroops)),
          verified: verifiedSavings !== null,
        }
        : null,
      ...(verification
        ? {
          verification: {
            status: verification.status,
            checkedAt: verification.checkedAt,
            legs: verification.legs.map((l) => ({
              role: l.role, label: l.label, ok: l.ok, address: l.address,
              assetAmount: l.creditedStroops === null ? null : formatStroops(BigInt(l.creditedStroops)),
            })),
            ...(verification.note ? { note: verification.note } : {}),
          },
        }
        : {}),
    };
  }

  /** A quote nobody authorized in time is cancelled; it never reached Paiflow, so nothing was charged. */
  private async expireIfLapsed(attempt: PaymentAttempt): Promise<PaymentAttempt> {
    return this.options.store.withLock(attempt.id, async () => {
      const a = (await this.options.store.get(attempt.id))!;
      const lapses = typeof a.meta?.quoteExpiresAt === 'string' ? Date.parse(a.meta.quoteExpiresAt) : Number.NaN;
      if (a.status !== 'awaiting_authorization' || !(this.now().getTime() > lapses)) return a;
      const cancelled: PaymentAttempt = {
        ...a, status: 'cancelled', failure: { code: 'QUOTE_EXPIRED', reason: 'This checkout expired before it was authorized' },
        updatedAt: this.now().toISOString(),
      };
      await this.options.store.put(cancelled);
      return cancelled;
    });
  }

  private validate(request: CheckoutRequest) {
    const centavos = pesosToCentavos(request.amount);
    if (centavos === undefined) throw new ServiceError('INVALID_AMOUNT', 400, 'Enter an amount in pesos with up to two decimals.');
    const student = this.options.student;
    if (!student) throw new ServiceError('STELLAR_NOT_CONFIGURED', 503, "Hima's testnet wallet isn't set up on the server yet.");
    if (!PAYABLE_MERCHANTS.has(request.merchantId)) {
      throw new ServiceError('MERCHANT_NOT_PAYABLE', 404, "This merchant can't take Hima payments yet.");
    }
    if (centavos > this.options.maxPaymentCentavos) {
      throw new ServiceError('AMOUNT_TOO_LARGE', 400, `Payments are limited to ₱${formatCentavos(this.options.maxPaymentCentavos)} on testnet.`);
    }
    return { centavos, student };
  }

  /** The paying wallet must hold the amount plus its reserve. If Horizon can't be read, Paiflow's own simulation decides. */
  private async checkFunds(publicKey: string, amountStroops: bigint) {
    let balances;
    try {
      balances = await this.options.horizon.balances(publicKey);
    } catch {
      this.options.log?.('[checkout] Horizon unavailable; skipping the wallet balance check.');
      return;
    }
    const native = balances?.find((b) => b.assetType === 'native');
    const stroops = native ? decimalToStroops(native.balance) ?? 0n : 0n;
    if (stroops < amountStroops + RESERVE_STROOPS) {
      throw new ServiceError('WALLET_NOT_FUNDED', 402, "Hima's testnet wallet doesn't have enough test XLM");
    }
  }
}

/** Any flow's attempt, by Hima id or the app's payment id. Someone else's attempt is "not found". */
export async function findOwnedAttempt(store: AttemptStore, userId: string, idOrKey: string): Promise<PaymentAttempt> {
  const byId = await store.get(idOrKey);
  if (byId && byId.userId === userId) return byId;
  const byKey = await store.findByKey(userId, 'checkout', idOrKey);
  if (byKey) return byKey;
  throw new ServiceError('PAYMENT_NOT_FOUND', 404, 'No payment with this id reached the server.');
}
