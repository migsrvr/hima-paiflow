import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FlowName } from '../integrations/paiflow/types.js';

/**
 * One lifecycle for every flow:
 *   created → awaiting_authorization → submitted → pending → confirmed
 *   any pre-submission state → cancelled; submitted/pending → failed (only when verified)
 * Only `confirmed` attempts count as completed money movements.
 */
export type AttemptStatus = 'created' | 'awaiting_authorization' | 'submitted' | 'pending' | 'confirmed' | 'failed' | 'cancelled';

export interface AttemptFailure {
  /** Ours (EXPIRED, REJECTED, …) or the network's (txTooLate, …). */
  code: string;
  /** Short, student-facing reason. */
  reason: string;
}

/** A payment attempt against one Paiflow deployment. Amounts are stroops strings, never floats. */
export interface PaymentAttempt {
  id: string;
  userId: string;
  flow: FlowName;
  deploymentId: string;
  /** Unique per user and flow: a retry with the same key never creates a second payment. */
  idempotencyKey: string;
  kind: 'deposit' | 'webhook';
  amountStroops: string;
  assetCode: string;
  /** Null for native XLM. */
  assetIssuer: string | null;
  /** PHP amount the student saw (checkout), in centavos. */
  amountCentavos?: number;
  merchantId?: string;
  reference?: string;
  /** Deposit flows: the signing account. */
  from?: string;
  status: AttemptStatus;
  txHash?: string;
  /** Deposit flows: the signed envelope, saved before it is ever submitted. */
  signedXdr?: string;
  expiresAt?: string;
  requestId?: string;
  /** Webhook flows: Paiflow's attempt id. */
  webhookAttemptId?: string;
  ledger?: number;
  failure?: AttemptFailure;
  /** Flow-specific details (split preview, allowance branch, verified credits). */
  meta?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
}

export interface AttemptStore {
  get(id: string): PaymentAttempt | undefined;
  findByKey(userId: string, flow: FlowName, idempotencyKey: string): PaymentAttempt | undefined;
  list(filter?: { userId?: string; flow?: FlowName }): PaymentAttempt[];
  put(attempt: PaymentAttempt): void;
}

const keyOf = (a: Pick<PaymentAttempt, 'userId' | 'flow' | 'idempotencyKey'>) => `${a.userId}\u0000${a.flow}\u0000${a.idempotencyKey}`;

export class MemoryAttemptStore implements AttemptStore {
  protected readonly byId = new Map<string, PaymentAttempt>();
  protected readonly byKey = new Map<string, string>();

  get(id: string) {
    const a = this.byId.get(id);
    return a && structuredClone(a);
  }

  findByKey(userId: string, flow: FlowName, idempotencyKey: string) {
    const id = this.byKey.get(keyOf({ userId, flow, idempotencyKey }));
    return id ? this.get(id) : undefined;
  }

  list(filter: { userId?: string; flow?: FlowName } = {}) {
    return [...this.byId.values()]
      .filter((a) => (!filter.userId || a.userId === filter.userId) && (!filter.flow || a.flow === filter.flow))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((a) => structuredClone(a));
  }

  put(attempt: PaymentAttempt) {
    const existing = this.byKey.get(keyOf(attempt));
    if (existing && existing !== attempt.id) {
      throw new Error(`Idempotency key already used by attempt ${existing}.`);
    }
    this.byId.set(attempt.id, structuredClone(attempt));
    this.byKey.set(keyOf(attempt), attempt.id);
  }
}

/** Write-through JSON file, so pending attempts survive a server restart. Demo scale only. */
export class FileAttemptStore extends MemoryAttemptStore {
  constructor(private readonly filePath: string) {
    super();
    if (existsSync(filePath)) {
      for (const a of JSON.parse(readFileSync(filePath, 'utf8')) as PaymentAttempt[]) {
        this.byId.set(a.id, a);
        this.byKey.set(keyOf(a), a.id);
      }
    }
  }

  override put(attempt: PaymentAttempt) {
    super.put(attempt);
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    writeFileSync(temp, JSON.stringify([...this.byId.values()], null, 2));
    renameSync(temp, this.filePath);
  }
}
