import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { FlowName } from '../integrations/paiflow/types.js';
import { ServiceError } from './errors.js';

/** Only confirmed attempts count as completed money movements. */
export type AttemptStatus = 'created' | 'awaiting_authorization' | 'submitted' | 'pending' | 'confirmed' | 'failed' | 'cancelled';
export interface AttemptFailure { code: string; reason: string }
/** Amounts are stroops strings, never floats. Signed envelopes must remain server-side. */
export interface PaymentAttempt {
  id: string;
  userId: string;
  flow: FlowName;
  deploymentId: string;
  idempotencyKey: string;
  kind: 'deposit' | 'webhook';
  amountStroops: string;
  assetCode: string;
  assetIssuer: string | null;
  amountCentavos?: number;
  merchantId?: string;
  reference?: string;
  from?: string;
  status: AttemptStatus;
  txHash?: string;
  signedXdr?: string;
  expiresAt?: string;
  requestId?: string;
  webhookAttemptId?: string;
  ledger?: number;
  failure?: AttemptFailure;
  meta?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
}
export interface AttemptStore {
  get(id: string): Promise<PaymentAttempt | undefined>;
  findByKey(userId: string, flow: FlowName, idempotencyKey: string): Promise<PaymentAttempt | undefined>;
  list(filter?: { userId?: string; flow?: FlowName }): Promise<PaymentAttempt[]>;
  /** Atomically claims (user, flow, key); returns the existing record on a key collision. */
  create(attempt: PaymentAttempt): Promise<PaymentAttempt>;
  /** Updates an existing record. Identity and any signed envelope are immutable. */
  put(attempt: PaymentAttempt): Promise<void>;
  /** Serializes read/prepare/sign/persist/submit across store users. Reentrant. */
  withLock<T>(id: string, work: () => Promise<T>): Promise<T>;
  ready(): Promise<void>;
  close(): Promise<void>;
}
const text = z.string().min(1);
const timestamp = text.refine((v) => Number.isFinite(Date.parse(v)));
const attemptSchema = z.object({
  id: text, userId: text, flow: z.enum(['checkout', 'allowance', 'reward']), deploymentId: text,
  idempotencyKey: text, kind: z.enum(['deposit', 'webhook']), amountStroops: z.string().regex(/^\d+$/),
  assetCode: text, assetIssuer: z.string().nullable(), amountCentavos: z.number().int().nonnegative().optional(),
  merchantId: text.optional(), reference: text.optional(), from: text.optional(),
  status: z.enum(['created', 'awaiting_authorization', 'submitted', 'pending', 'confirmed', 'failed', 'cancelled']),
  txHash: text.optional(), signedXdr: text.optional(), expiresAt: timestamp.optional(), requestId: text.optional(),
  webhookAttemptId: text.optional(), ledger: z.number().int().positive().optional(),
  failure: z.object({ code: text, reason: text }).optional(), meta: z.record(z.unknown()).optional(),
  createdAt: timestamp, updatedAt: timestamp, confirmedAt: timestamp.optional(),
}).passthrough();
/** Validate an entire backup before import writes; retain extra fields and original timestamps. */
export function parseAttempts(value: unknown): PaymentAttempt[] {
  const result = z.array(attemptSchema).safeParse(value);
  if (!result.success) throw new Error('Invalid attempts data; no records imported.');
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const attempt of result.data) {
    const key = keyOf(attempt);
    if (ids.has(attempt.id) || keys.has(key)) throw new Error('Duplicate attempt identity in attempts data.');
    ids.add(attempt.id);
    keys.add(key);
  }
  return result.data as PaymentAttempt[];
}
export const keyOf = (a: Pick<PaymentAttempt, 'userId' | 'flow' | 'idempotencyKey'>) =>
  JSON.stringify([a.userId, a.flow, a.idempotencyKey]);
export function assertUpdate(existing: PaymentAttempt, next: PaymentAttempt) {
  if (existing.id !== next.id || keyOf(existing) !== keyOf(next) || existing.createdAt !== next.createdAt
    || existing.deploymentId !== next.deploymentId || existing.amountStroops !== next.amountStroops
    || existing.kind !== next.kind || existing.assetCode !== next.assetCode || existing.assetIssuer !== next.assetIssuer
    || existing.amountCentavos !== next.amountCentavos || existing.merchantId !== next.merchantId
    || existing.reference !== next.reference || existing.from !== next.from) {
    throw new ServiceError('ATTEMPT_CONFLICT', 409, 'Payment attempt identity cannot be changed.');
  }
  if (existing.signedXdr && (next.signedXdr !== existing.signedXdr || next.txHash !== existing.txHash)) {
    throw new ServiceError('ATTEMPT_CONFLICT', 409, 'A signed payment cannot be replaced.');
  }
  if ((['confirmed', 'failed', 'cancelled'].includes(existing.status) && existing.status !== next.status)
    || (existing.signedXdr && ['created', 'awaiting_authorization', 'cancelled'].includes(next.status))) {
    throw new ServiceError('ATTEMPT_CONFLICT', 409, 'Payment attempt state cannot be reversed.');
  }
}
export class MemoryAttemptStore implements AttemptStore {
  protected readonly byId = new Map<string, PaymentAttempt>();
  private readonly byKey = new Map<string, string>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly held = new AsyncLocalStorage<ReadonlySet<string>>();
  async get(id: string) {
    const a = this.byId.get(id);
    return a && structuredClone(a);
  }
  async findByKey(userId: string, flow: FlowName, idempotencyKey: string) {
    const id = this.byKey.get(keyOf({ userId, flow, idempotencyKey }));
    return id ? this.get(id) : undefined;
  }
  async list(filter: { userId?: string; flow?: FlowName } = {}) {
    return [...this.byId.values()]
      .filter((a) => (filter.userId === undefined || a.userId === filter.userId) && (filter.flow === undefined || a.flow === filter.flow))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((a) => structuredClone(a));
  }
  async create(attempt: PaymentAttempt): Promise<PaymentAttempt> {
    // No await between claim and durable write: atomic within this local process.
    const existingId = this.byKey.get(keyOf(attempt));
    if (existingId) return structuredClone(this.byId.get(existingId)!);
    if (this.byId.has(attempt.id)) throw new ServiceError('ATTEMPT_CONFLICT', 409, 'Payment attempt id is already used.');
    this.commit(attempt);
    return structuredClone(attempt);
  }
  async put(attempt: PaymentAttempt) {
    await this.withLock(attempt.id, async () => {
      const existing = this.byId.get(attempt.id);
      if (!existing) throw new ServiceError('ATTEMPT_CONFLICT', 409, 'Payment attempt does not exist.');
      assertUpdate(existing, attempt);
      this.commit(attempt);
    });
  }
  protected commit(attempt: PaymentAttempt) {
    this.persist([...this.byId.values()].filter((a) => a.id !== attempt.id).concat([attempt]));
    this.load(attempt);
  }
  protected load(attempt: PaymentAttempt) {
    this.byId.set(attempt.id, structuredClone(attempt));
    this.byKey.set(keyOf(attempt), attempt.id);
  }
  protected persist(_attempts: PaymentAttempt[]) {}
  async withLock<T>(id: string, work: () => Promise<T>): Promise<T> {
    const held = this.held.getStore();
    if (held?.has(id)) return work();
    const prior = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(id, next);
    await prior;
    try { return await this.held.run(new Set([...(held ?? []), id]), work); }
    finally {
      release();
      if (this.locks.get(id) === next) this.locks.delete(id);
    }
  }
  async ready() {}
  async close() {}
}
/** Local, single-process development only. Never used as a database outage fallback. */
export class FileAttemptStore extends MemoryAttemptStore {
  constructor(private readonly filePath: string) {
    super();
    if (existsSync(filePath)) {
      for (const a of parseAttempts(JSON.parse(readFileSync(filePath, 'utf8')))) this.load(a);
    }
  }
  protected override persist(attempts: PaymentAttempt[]) {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    writeFileSync(temp, JSON.stringify(attempts, null, 2), { mode: 0o600 });
    renameSync(temp, this.filePath);
  }
}
