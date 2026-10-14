// One client per Paiflow deployment (https://beta.app.paiflow.xyz/api/v1/openapi.json).
// The pfk_ token and webhook secret stay on this server; they are never logged or returned.
import { PaiflowError } from './errors.js';
import type {
  FundingAction, FundingNode, FundingPrepared, FundingReconciled, PaiflowApi, PaiflowBalances, PaiflowCapabilities,
  PaiflowEvent, PaiflowInputAsset, PaiflowTransactionStatus, PaiflowTxError, PreparedExecute, SubmittedExecute, WebhookAttempt,
} from './types.js';

interface PaiflowClientOptions {
  /** Paiflow origin, e.g. https://beta.app.paiflow.xyz (an /api/v1 suffix is tolerated). */
  baseUrl: string;
  deploymentId: string;
  token: string;
  /** Webhook-triggered deployments only. */
  webhookSecret?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const TX_STATUSES = ['SUCCESS', 'FAILED', 'PENDING', 'UNKNOWN', 'REJECTED'] as const;
const FUNDING_ACTIONS: readonly FundingAction[] = ['schedule.fund', 'webhook.fund'];

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function txError(value: unknown): PaiflowTxError | undefined {
  const e = record(value);
  return e && typeof e.code === 'string' && typeof e.message === 'string' ? { code: e.code, message: e.message } : undefined;
}

function retryAfter(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

const bad = (what: string) => new PaiflowError('BAD_RESPONSE', 200, `Paiflow returned unreadable ${what}.`);

function txStatus(value: unknown, fallbackHash: string): PaiflowTransactionStatus {
  const d = record(value);
  if (!d || !TX_STATUSES.includes(String(d.status) as (typeof TX_STATUSES)[number])) throw bad('transaction status');
  return {
    txHash: String(d.txHash ?? fallbackHash).toLowerCase(),
    status: d.status as PaiflowTransactionStatus['status'],
    ledger: typeof d.ledger === 'number' ? d.ledger : undefined,
    error: txError(d.error),
  };
}

export class PaiflowClient implements PaiflowApi {
  private readonly origin: string;

  constructor(private readonly options: PaiflowClientOptions) {
    this.origin = options.baseUrl.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  }

  get configured(): boolean {
    return this.options.token.trim().length > 0 && this.options.deploymentId.trim().length > 0;
  }

  get deploymentId(): string {
    return this.options.deploymentId;
  }

  async capabilities(): Promise<PaiflowCapabilities> {
    const { data } = await this.deployment('GET', '/capabilities');
    const d = record(data);
    if (!d || typeof d.triggerType !== 'string' || (d.network !== 'testnet' && d.network !== 'mainnet')) throw bad('capabilities');
    return {
      deploymentId: String(d.deploymentId ?? this.options.deploymentId),
      network: d.network,
      triggerType: d.triggerType,
      inputAsset: (d.inputAsset ?? null) as PaiflowInputAsset,
      operations: (record(d.operations) ?? {}) as PaiflowCapabilities['operations'],
    };
  }

  async prepareExecute(from: string, amountStroops: string): Promise<PreparedExecute> {
    const { data, response } = await this.deployment('POST', '/execute', { from, amount: amountStroops });
    const d = record(data);
    if (!d || typeof d.xdr !== 'string' || typeof d.networkPassphrase !== 'string' || typeof d.expiresAt !== 'string'
      || (d.network !== 'testnet' && d.network !== 'mainnet')) {
      throw bad('payment envelope');
    }
    return {
      xdr: d.xdr,
      networkPassphrase: d.networkPassphrase,
      network: d.network,
      expiresAt: d.expiresAt,
      requestId: response.headers.get('x-history-request-id') ?? undefined,
    };
  }

  async submitExecute(signedXdr: string, options: { requestId?: string } = {}): Promise<SubmittedExecute> {
    // wait=false: return as soon as the network accepts it; Hima polls for the final status.
    const headers = options.requestId ? { 'x-preparation-request-id': options.requestId } : undefined;
    const { data } = await this.deployment('POST', '/execute/submit?wait=false', { signedXdr }, headers);
    const d = record(data);
    if (!d || typeof d.txHash !== 'string' || !['SUCCESS', 'PENDING', 'FAILED'].includes(String(d.status))) throw bad('submission result');
    return {
      txHash: d.txHash.toLowerCase(),
      status: d.status as SubmittedExecute['status'],
      ledger: typeof d.ledger === 'number' ? d.ledger : undefined,
      error: txError(d.error),
    };
  }

  async transactionStatus(txHash: string): Promise<PaiflowTransactionStatus | null> {
    try {
      const { data } = await this.deployment('GET', `/transactions/${encodeURIComponent(txHash)}`);
      return txStatus(data, txHash);
    } catch (error) {
      if (error instanceof PaiflowError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  async events(txHash: string): Promise<PaiflowEvent[]> {
    const { data } = await this.deployment('GET', `/events?txHash=${encodeURIComponent(txHash)}&limit=100`);
    const items = record(data)?.items;
    if (!Array.isArray(items)) throw bad('events');
    return items.flatMap((item) => {
      const e = record(item);
      return e && typeof e.kind === 'string' && typeof e.txHash === 'string'
        ? [{
          eventId: String(e.eventId ?? ''),
          kind: e.kind,
          topic: typeof e.topic === 'string' ? e.topic : null,
          ledger: Number(e.ledger ?? 0),
          txHash: e.txHash,
          occurredAt: String(e.occurredAt ?? ''),
          data: e.data ?? null,
        }]
        : [];
    });
  }

  async balances(): Promise<PaiflowBalances> {
    const { data } = await this.deployment('GET', '/balances');
    const d = record(data);
    if (!d || !Array.isArray(d.totals) || !Array.isArray(d.nodes)) throw bad('balances');
    const freshness = record(d.freshness);
    const str = (v: unknown) => (typeof v === 'string' ? v : null);
    return {
      totals: d.totals.flatMap((t) => {
        const r = record(t);
        return r && typeof r.tokenContract === 'string' ? [{ tokenContract: r.tokenContract, balanceStroops: str(r.balanceStroops) }] : [];
      }),
      nodes: d.nodes.flatMap((n) => {
        const r = record(n);
        return r && typeof r.nodeId === 'string'
          ? [{
            nodeId: r.nodeId,
            templateKind: String(r.templateKind ?? ''),
            contractAddress: str(r.contractAddress),
            tokenContract: str(r.tokenContract),
            balanceStroops: str(r.balanceStroops),
            stale: r.stale === true,
          }]
          : [];
      }),
      freshness: String(freshness?.status ?? 'unknown'),
      totalsComplete: freshness?.totalsComplete === true,
    };
  }

  async discoverFunding(): Promise<FundingNode[]> {
    const { data } = await this.deployment('GET', '/funding');
    const nodes = record(data)?.nodes;
    if (!Array.isArray(nodes)) throw bad('funding discovery');
    return nodes.flatMap((n) => {
      const r = record(n);
      return r && typeof r.nodeId === 'string' && typeof r.contractAddress === 'string' && typeof r.tokenContractAddress === 'string'
        && FUNDING_ACTIONS.includes(r.action as FundingAction)
        ? [{
          nodeId: r.nodeId,
          templateKind: String(r.templateKind ?? ''),
          contractAddress: r.contractAddress,
          action: r.action as FundingAction,
          tokenContractAddress: r.tokenContractAddress,
        }]
        : [];
    });
  }

  async prepareFunding(input: { nodeId?: string; fromAddress: string; tokenContractAddress: string; amountStroops: string }): Promise<FundingPrepared> {
    const { data } = await this.deployment('POST', '/funding', input);
    const d = record(data);
    if (!d || typeof d.intent !== 'string' || typeof d.xdr !== 'string' || typeof d.txHash !== 'string'
      || !FUNDING_ACTIONS.includes(d.action as FundingAction) || (d.network !== 'testnet' && d.network !== 'mainnet')) {
      throw bad('funding envelope');
    }
    return {
      intent: d.intent,
      txHash: d.txHash.toLowerCase(),
      expiresAt: String(d.expiresAt ?? ''),
      xdr: d.xdr,
      action: d.action as FundingAction,
      nodeId: String(d.nodeId ?? ''),
      fromAddress: String(d.fromAddress ?? ''),
      tokenContractAddress: String(d.tokenContractAddress ?? ''),
      amountStroops: String(d.amountStroops ?? ''),
      network: d.network,
      networkPassphrase: String(d.networkPassphrase ?? ''),
    };
  }

  async submitFunding(input: { action: FundingAction; intent: string; signedXdr: string }): Promise<PaiflowTransactionStatus> {
    const { data } = await this.deployment('POST', '/funding/submit', input);
    return txStatus(data, '');
  }

  async reconcileFunding(input: { action: FundingAction; intent: string }): Promise<FundingReconciled> {
    const { data } = await this.deployment('POST', '/funding/reconcile', input);
    const d = record(data);
    if (!d || typeof d.intent !== 'string' || typeof d.state !== 'string') throw bad('funding state');
    return {
      intent: d.intent,
      action: d.action as FundingAction,
      txHash: String(d.txHash ?? '').toLowerCase(),
      state: d.state as FundingReconciled['state'],
      expiresAt: String(d.expiresAt ?? ''),
    };
  }

  async webhook(body: { escrow: true; amount: string }, { idempotencyKey }: { idempotencyKey: string }): Promise<WebhookAttempt> {
    const secret = this.options.webhookSecret?.trim();
    if (!secret || !this.options.deploymentId.trim()) {
      throw new PaiflowError('NOT_CONFIGURED', undefined, 'This Paiflow webhook is not configured on this server.');
    }
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) {
      throw new PaiflowError('VALIDATION', undefined, 'Webhook idempotency keys use 1–128 letters, digits and . _ : -');
    }
    const url = `${this.origin}/api/webhooks/${encodeURIComponent(this.options.deploymentId)}`;
    const { data, response } = await this.request('POST', url, body, { 'x-webhook-secret': secret, 'Idempotency-Key': idempotencyKey });
    const d = record(data);
    if (!d || !TX_STATUSES.includes(String(d.status) as (typeof TX_STATUSES)[number])) throw bad('webhook result');
    return {
      attemptId: typeof d.attemptId === 'string' ? d.attemptId : undefined,
      txHash: typeof d.txHash === 'string' ? d.txHash.toLowerCase() : undefined,
      status: d.status as WebhookAttempt['status'],
      ledger: typeof d.ledger === 'number' ? d.ledger : undefined,
      error: txError(d.error),
      httpStatus: response.status,
    };
  }

  private deployment(method: 'GET' | 'POST', path: string, body?: unknown, headers?: Record<string, string>) {
    if (!this.configured) throw new PaiflowError('NOT_CONFIGURED', undefined, 'Paiflow is not configured on this server.');
    const url = `${this.origin}/api/v1/deployments/${encodeURIComponent(this.options.deploymentId)}${path}`;
    return this.request(method, url, body, { Authorization: `Bearer ${this.options.token}`, ...headers });
  }

  private async request(method: 'GET' | 'POST', url: string, body: unknown, headers: Record<string, string>) {
    const signal = AbortSignal.timeout(this.options.timeoutMs ?? 20_000);
    let response: Response;
    try {
      response = await (this.options.fetchImpl ?? fetch)(url, {
        method,
        signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Hima/1.0 (student-allowance-backend)',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      if (signal.aborted || (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))) {
        throw new PaiflowError('TIMEOUT', undefined, 'Paiflow took too long to answer.');
      }
      throw new PaiflowError('NETWORK', undefined, 'Paiflow could not be reached.');
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }

    if (!response.ok) {
      const e = record(record(payload)?.error);
      const code = typeof e?.code === 'string' ? e.code : response.status === 429 ? 'RATE_LIMITED' : `HTTP_${response.status}`;
      // Paiflow's own message (no secrets): kept for server-side diagnosis, never shown to students as-is.
      const message = typeof e?.message === 'string' ? e.message : `Paiflow answered ${response.status}.`;
      throw new PaiflowError(code, response.status, message, response.status === 429 ? retryAfter(response) : undefined);
    }
    const data = record(payload)?.data;
    if (data === undefined) throw new PaiflowError('BAD_RESPONSE', response.status, 'Paiflow returned an unreadable reply.');
    return { data, response };
  }
}
