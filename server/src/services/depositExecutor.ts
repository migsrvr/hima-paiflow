import { randomUUID } from 'node:crypto';
import { Address, type Keypair, Networks, scValToNative, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import { PaiflowError } from '../integrations/paiflow/errors.js';
import type { PaiflowRegistry } from '../integrations/paiflow/registry.js';
import type { PaiflowTxError, PreparedExecute } from '../integrations/paiflow/types.js';
import type { HorizonApi } from './horizonClient.js';
import type { AttemptFailure, AttemptStatus, AttemptStore, PaymentAttempt } from './attemptStore.js';
import { ServiceError } from './errors.js';

/** A prepared envelope may not commit to more than 10 XLM of fees. */
const MAX_FEE_STROOPS = 100_000_000n;
/** Envelopes must expire within ten minutes; Paiflow's are valid for 180 s. */
const MAX_VALIDITY_MS = 10 * 60_000;

export type DepositFlow = 'checkout' | 'allowance';

export interface DepositRequest {
  flow: DepositFlow;
  userId: string;
  /** Unique per user and flow: a retry with the same key returns the same attempt, never a second payment. */
  idempotencyKey: string;
  /** The account that pays the deposit and signs: the student for checkout, the sponsor for allowance. */
  signer: Keypair;
  amountStroops: bigint;
  amountCentavos?: number;
  merchantId?: string;
  reference?: string;
  meta?: Record<string, unknown>;
}

interface ExecutorOptions {
  registry: PaiflowRegistry;
  horizon: HorizonApi;
  store: AttemptStore;
  now?: () => Date;
  /** Minimum gap between Paiflow status reads for one attempt. */
  pollIntervalMs?: number;
  /** How long after `expiresAt` Horizon is asked whether the envelope ever landed. */
  expiryGraceMs?: number;
  log?: (message: string) => void;
}

/** Student-facing reasons for a payment that reached the network and failed. */
export function reasonForTxError(error: PaiflowTxError | undefined): AttemptFailure {
  const code = error?.code ?? 'FAILED';
  if (/too_?late|expired/i.test(code)) return { code, reason: 'Expired before it reached the network' };
  if (/insufficient|underfunded|balance/i.test(code)) return { code, reason: 'Not enough test funds in the wallet' };
  return { code, reason: 'The network rejected the payment' };
}

const FINAL: readonly AttemptStatus[] = ['confirmed', 'failed', 'cancelled'];
export const isFinal = (a: PaymentAttempt) => FINAL.includes(a.status);

/**
 * Runs a deposit-triggered Paiflow flow: prepare → verify the envelope → sign → save → submit →
 * reconcile. Shared by checkout (student signs) and allowance (sponsor signs).
 * The signed envelope is stored before it is submitted, so every retry, restart or status check
 * reuses that exact envelope, and Paiflow never sends it twice.
 */
export class DepositExecutor {
  private readonly lastChecked = new Map<string, number>();

  constructor(private readonly options: ExecutorOptions) {}

  private now() {
    return this.options.now?.() ?? new Date();
  }

  private log(message: string) {
    (this.options.log ?? console.warn)(message);
  }

  /** Starts (or, for a known key, resumes) a deposit. Errors before signing mean nothing was charged. */
  async start(request: DepositRequest): Promise<PaymentAttempt> {
    if (request.amountStroops <= 0n) throw new ServiceError('INVALID_AMOUNT', 400, 'Enter a positive payment amount.');
    let attempt = await this.options.store.findByKey(request.userId, request.flow, request.idempotencyKey);
    if (!attempt) {
      let deploymentId: string;
      try { deploymentId = this.options.registry.client(request.flow).deploymentId; }
      catch { throw new ServiceError('PAYMENTS_NOT_CONFIGURED', 503, "Payments aren't set up on the server yet"); }
      const status = await this.options.registry.status(request.flow);
      if (!status.ready) throw new ServiceError('FLOW_NOT_READY', 503, `${status.label} isn't ready: ${status.problems[0] ?? 'unknown problem'}`);
      const at = this.now().toISOString();
      attempt = await this.options.store.create({
        id: `att_${randomUUID()}`, userId: request.userId, flow: request.flow, deploymentId,
        idempotencyKey: request.idempotencyKey, kind: 'deposit', amountStroops: request.amountStroops.toString(),
        assetCode: 'XLM', assetIssuer: null, amountCentavos: request.amountCentavos,
        merchantId: request.merchantId, reference: request.reference, from: request.signer.publicKey(),
        meta: request.meta, status: 'created', createdAt: at, updatedAt: at,
      });
    }
    return this.options.store.withLock(attempt.id, () => this.startOnce(request, attempt!.id));
  }

  private async startOnce(request: DepositRequest, id: string): Promise<PaymentAttempt> {
    // Always read after acquiring the shared database lock; caller snapshots may be stale.
    const existing = await this.options.store.get(id);
    if (!existing) throw new ServiceError('PAYMENT_NOT_FOUND', 404, 'No payment with this id reached the server.');
    if (existing.amountStroops !== request.amountStroops.toString() || existing.amountCentavos !== request.amountCentavos
      || existing.merchantId !== request.merchantId || existing.reference !== request.reference
      || existing.from !== request.signer.publicKey()) {
      throw new ServiceError('PAYMENT_ID_REUSED', 409, 'This payment id was already used for a different payment.');
    }
    const lapses = typeof existing.meta?.quoteExpiresAt === 'string' ? Date.parse(existing.meta.quoteExpiresAt) : NaN;
    if (existing.status === 'awaiting_authorization' && this.now().getTime() > lapses) {
      await this.save(existing, 'cancelled', { failure: { code: 'QUOTE_EXPIRED', reason: 'This checkout expired before it was authorized' } });
      throw new ServiceError('QUOTE_EXPIRED', 409, 'This checkout expired before it was authorized');
    }
    if (existing.status === 'cancelled') {
      throw new ServiceError('PAYMENT_CANCELLED', 409, existing.failure?.reason ?? 'This payment was cancelled before it was sent.');
    }
    // A durable envelope is never prepared or signed again, including after a crash before submit.
    if (existing.signedXdr || (existing.status !== 'created' && existing.status !== 'awaiting_authorization')) {
      return this.refreshLocked(existing);
    }

    const { registry } = this.options;
    let client;
    try {
      client = registry.client(request.flow);
    } catch {
      throw new ServiceError('PAYMENTS_NOT_CONFIGURED', 503, "Payments aren't set up on the server yet");
    }
    if (client.deploymentId !== existing.deploymentId) {
      throw new ServiceError('PAYMENTS_NOT_CONFIGURED', 503, 'This payment deployment is no longer configured.');
    }
    const status = await registry.status(request.flow);
    if (!status.ready) {
      this.log(`[${request.flow}] refused: ${status.problems.join(' ')}`);
      throw new ServiceError('FLOW_NOT_READY', 503, `${status.label} isn't ready: ${status.problems[0] ?? 'unknown problem'}`);
    }

    // Nothing is signed until this succeeds, so every error here means nothing was charged.
    let prepared: PreparedExecute;
    try {
      prepared = await client.prepareExecute(request.signer.publicKey(), request.amountStroops.toString());
    } catch (error) {
      throw this.prepareError(request.flow, error);
    }

    const signed = this.sign(request.flow, prepared, request.signer, request.amountStroops);
    const at = this.now().toISOString();
    const attempt: PaymentAttempt = {
      // A quoted payment keeps its record (id, key, preview); otherwise a new one starts here.
      id: existing?.id ?? `att_${randomUUID()}`,
      userId: request.userId,
      flow: request.flow,
      deploymentId: client.deploymentId,
      idempotencyKey: request.idempotencyKey,
      kind: 'deposit',
      amountStroops: request.amountStroops.toString(),
      assetCode: 'XLM',
      assetIssuer: null,
      ...(request.amountCentavos !== undefined ? { amountCentavos: request.amountCentavos } : {}),
      ...(request.merchantId ? { merchantId: request.merchantId } : {}),
      ...(request.reference ? { reference: request.reference } : {}),
      from: request.signer.publicKey(),
      status: 'submitted',
      txHash: signed.hash,
      signedXdr: signed.xdr,
      expiresAt: prepared.expiresAt,
      ...(prepared.requestId ? { requestId: prepared.requestId } : {}),
      ...(existing?.meta || request.meta ? { meta: { ...existing?.meta, ...request.meta } } : {}),
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    };
    // Saved before submission: a crash or timeout from here on is reconciled with this exact envelope.
    await this.options.store.put(attempt);
    this.lastChecked.set(attempt.id, this.now().getTime());
    return this.submit(attempt, { first: true });
  }

  /** Latest state of a deposit attempt; Paiflow is asked at most once per poll interval. */
  async refresh(attempt: PaymentAttempt): Promise<PaymentAttempt> {
    return this.options.store.withLock(attempt.id, async () => {
      const current = await this.options.store.get(attempt.id);
      if (!current) throw new ServiceError('PAYMENT_NOT_FOUND', 404, 'No payment with this id reached the server.');
      return this.refreshLocked(current);
    });
  }

  private async refreshLocked(attempt: PaymentAttempt): Promise<PaymentAttempt> {
    if (isFinal(attempt) || attempt.kind !== 'deposit' || !attempt.signedXdr || !attempt.txHash) return attempt;
    const now = this.now().getTime();
    if (now - (this.lastChecked.get(attempt.id) ?? 0) < (this.options.pollIntervalMs ?? 2000)) return attempt;
    this.lastChecked.set(attempt.id, now);
    if (!this.options.registry.configured(attempt.flow)
      || this.options.registry.config(attempt.flow).deploymentId !== attempt.deploymentId) {
      // The deployment's settings were removed: the outcome can't be checked, so it stays as it is.
      this.log(`[${attempt.flow}] can't check ${attempt.id}: the flow is no longer configured.`);
      return attempt;
    }
    return this.reconcile(attempt);
  }

  /** Paiflow's view first; an unknown attempt is resubmitted (idempotent); after expiry Horizon decides. */
  private async reconcile(attempt: PaymentAttempt): Promise<PaymentAttempt> {
    const client = this.options.registry.client(attempt.flow);
    let status;
    try {
      status = await client.transactionStatus(attempt.txHash as string);
    } catch (error) {
      this.log(`[${attempt.flow}] Paiflow status unavailable for ${attempt.id} (${error instanceof PaiflowError ? error.code : 'error'}).`);
      return this.checkExpiry(attempt);
    }
    if (status?.status === 'SUCCESS') return this.confirm(attempt, status.ledger);
    if (status?.status === 'FAILED') return this.fail(attempt, reasonForTxError(status.error), status.ledger);
    if (status?.status === 'REJECTED') return this.fail(attempt, { code: 'REJECTED', reason: 'Paiflow refused the payment' });
    if (status?.status === 'PENDING') return this.save(attempt, 'pending');

    // UNKNOWN or unattributed: send the same signed envelope again. Paiflow never sends it twice.
    const next = await this.submit(attempt, { first: false });
    return next.status === 'pending' ? this.checkExpiry(next) : next;
  }

  private async submit(attempt: PaymentAttempt, { first }: { first: boolean }): Promise<PaymentAttempt> {
    const client = this.options.registry.client(attempt.flow);
    try {
      const result = await client.submitExecute(attempt.signedXdr as string, { requestId: attempt.requestId });
      if (result.txHash && result.txHash !== attempt.txHash) {
        this.log(`[${attempt.flow}] Paiflow reported hash ${result.txHash} for ${attempt.id}; keeping the signed envelope's hash.`);
      }
      if (result.status === 'SUCCESS') return this.confirm(attempt, result.ledger);
      if (result.status === 'FAILED') return this.fail(attempt, reasonForTxError(result.error), result.ledger);
      return this.save(attempt, 'pending');
    } catch (error) {
      if (first && error instanceof PaiflowError && error.refused) {
        // Paiflow answered and refused the first submission, so this envelope was never sent.
        this.log(`[${attempt.flow}] Paiflow refused ${attempt.id}: ${error.code} ${error.message}`);
        return this.fail(attempt, { code: 'REJECTED', reason: 'Paiflow refused the payment' });
      }
      // No answer, throttled, or a refusal of a resubmission: the outcome stays unknown.
      return this.save(attempt, 'pending');
    }
  }

  private async checkExpiry(attempt: PaymentAttempt): Promise<PaymentAttempt> {
    const expires = Date.parse(attempt.expiresAt ?? '');
    if (!Number.isFinite(expires) || this.now().getTime() < expires + (this.options.expiryGraceMs ?? 30_000)) {
      return this.save(attempt, 'pending');
    }
    try {
      const tx = await this.options.horizon.transaction(attempt.txHash as string);
      if (!tx) return this.fail(attempt, { code: 'EXPIRED', reason: 'Expired before the network confirmed it' });
      return tx.successful
        ? this.confirm(attempt, tx.ledger)
        : this.fail(attempt, { code: 'FAILED', reason: 'The network rejected the payment' }, tx.ledger);
    } catch {
      return this.save(attempt, 'pending');
    }
  }

  private async save(attempt: PaymentAttempt, status: AttemptStatus, patch: Partial<PaymentAttempt> = {}): Promise<PaymentAttempt> {
    const next: PaymentAttempt = { ...attempt, ...patch, status, updatedAt: this.now().toISOString() };
    await this.options.store.put(next);
    return next;
  }

  private confirm(attempt: PaymentAttempt, ledger?: number) {
    return this.save(attempt, 'confirmed', { ...(ledger ? { ledger } : {}), confirmedAt: this.now().toISOString() });
  }

  private fail(attempt: PaymentAttempt, failure: AttemptFailure, ledger?: number) {
    return this.save(attempt, 'failed', { failure, ...(ledger ? { ledger } : {}) });
  }

  private prepareError(flow: DepositFlow, error: unknown): ServiceError {
    if (!(error instanceof PaiflowError)) return new ServiceError('PAIFLOW_UNAVAILABLE', 502, "Couldn't reach Paiflow");
    this.log(`[${flow}] Paiflow prepare failed: ${error.code} ${error.message}`);
    switch (error.code) {
      case 'INSUFFICIENT_FUNDS':
        return new ServiceError('WALLET_NOT_FUNDED', 402, "The paying testnet wallet isn't funded");
      case 'VALIDATION':
        return new ServiceError('PAYMENT_REFUSED', 422, 'Paiflow refused the payment');
      case 'CONFLICT':
        return new ServiceError('PAYMENT_BUSY', 409, 'Another payment is still being prepared');
      case 'RATE_LIMITED':
        return new ServiceError('PAYMENTS_BUSY', 503, 'Paiflow is busy. Try again in a minute');
      case 'UNAUTHENTICATED':
      case 'FORBIDDEN':
      case 'NOT_FOUND':
      case 'NOT_CONFIGURED':
      case 'FLOW_NOT_CONFIGURED':
        return new ServiceError('PAYMENTS_NOT_CONFIGURED', 503, "Payments aren't set up on the server yet");
      default:
        return new ServiceError('PAIFLOW_UNAVAILABLE', 502, "Couldn't reach Paiflow");
    }
  }

  /** Checks the envelope Paiflow prepared is exactly the deposit we asked for, then signs it. */
  private sign(flow: DepositFlow, prepared: PreparedExecute, signer: Keypair, stroops: bigint): { xdr: string; hash: string } {
    const refuse = (why: string) => {
      this.log(`Refused a Paiflow envelope: ${why}.`);
      return new ServiceError('PAIFLOW_BAD_ENVELOPE', 502, 'Paiflow returned a payment Hima could not verify');
    };
    if (prepared.network !== 'testnet' || prepared.networkPassphrase !== Networks.TESTNET) throw refuse('not testnet');

    let tx: Transaction;
    try {
      const parsed = TransactionBuilder.fromXDR(prepared.xdr, Networks.TESTNET);
      if (!(parsed instanceof Transaction)) throw new Error('fee bump');
      tx = parsed;
    } catch {
      throw refuse('unreadable envelope');
    }

    if (tx.source !== signer.publicKey()) throw refuse('wrong source account');
    if (tx.operations.length !== 1) throw refuse('expected one operation');
    const op = tx.operations[0];
    if (op.type !== 'invokeHostFunction' || op.func.type !== 'hostFunctionTypeInvokeContract') throw refuse('not a contract call');
    const call = op.func.invokeContract;
    const contract = Address.fromScAddress(call.contractAddress).toString();
    const trigger = this.options.registry.config(flow).triggerContract;
    if (trigger && contract !== trigger) throw refuse('wrong contract');
    if (call.functionName.toString() !== 'deposit') throw refuse('not a deposit');
    const amounts = call.args.flatMap((arg) => {
      try {
        const value = scValToNative(arg);
        return typeof value === 'bigint' ? [value] : [];
      } catch {
        return [];
      }
    });
    if (!amounts.includes(stroops)) throw refuse('amount does not match');
    if (BigInt(tx.fee) > MAX_FEE_STROOPS) throw refuse('fee too high');
    const maxTime = Number(tx.timeBounds?.maxTime ?? 0) * 1000;
    if (!maxTime || maxTime > this.now().getTime() + MAX_VALIDITY_MS) throw refuse('validity window too long');

    tx.sign(signer);
    return { xdr: tx.toXDR(), hash: Buffer.from(tx.hash()).toString('hex') };
  }
}
