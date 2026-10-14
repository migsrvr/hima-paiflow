// Types for the Paiflow developer API (https://beta.app.paiflow.xyz/api/v1/openapi.json).
// Only documented operations are modelled here.

/** Hima's three Paiflow deployments. Each has its own id, token and (for rewards) webhook secret. */
export type FlowName = 'checkout' | 'allowance' | 'reward';

export const FLOW_NAMES: readonly FlowName[] = ['checkout', 'allowance', 'reward'];

export type PaiflowNetwork = 'testnet' | 'mainnet';

export type PaiflowInputAsset =
  | null
  | { kind: 'native' }
  | { kind: 'known'; symbol: 'USDC' }
  | { kind: 'custom'; code: string; issuer: string };

export interface PaiflowCapability {
  status: 'supported' | 'conditional' | 'unsupported';
  authentication: string;
  requirements: string[];
  nodeIds: string[];
}

export interface PaiflowCapabilities {
  deploymentId: string;
  network: PaiflowNetwork;
  triggerType: string;
  inputAsset: PaiflowInputAsset;
  operations: Record<string, PaiflowCapability>;
}

export interface PreparedExecute {
  /** Unsigned base64 envelope: a single `deposit` call on the flow's trigger contract. */
  xdr: string;
  networkPassphrase: string;
  network: PaiflowNetwork;
  /** After this the network refuses the envelope. */
  expiresAt: string;
  /** x-history-request-id: sent back on submit for Paiflow's correlation only. */
  requestId?: string;
}

export interface PaiflowTxError {
  code: string;
  message: string;
}

export interface SubmittedExecute {
  txHash: string;
  status: 'SUCCESS' | 'PENDING' | 'FAILED';
  ledger?: number;
  error?: PaiflowTxError;
}

export interface PaiflowTransactionStatus {
  txHash: string;
  status: 'SUCCESS' | 'FAILED' | 'PENDING' | 'UNKNOWN' | 'REJECTED';
  ledger?: number;
  error?: PaiflowTxError;
}

export interface PaiflowEvent {
  eventId: string;
  kind: string;
  topic: string | null;
  ledger: number;
  txHash: string;
  occurredAt: string;
  data: unknown;
}

/** GET /balances: display reads of deployed contract funds, not proof of payment. */
export interface PaiflowBalances {
  totals: { tokenContract: string; balanceStroops: string | null }[];
  nodes: {
    nodeId: string;
    templateKind: string;
    contractAddress: string | null;
    tokenContract: string | null;
    balanceStroops: string | null;
    stale: boolean;
  }[];
  /** "fresh" when every supported node was read within the display window. */
  freshness: string;
  totalsComplete: boolean;
}

export type FundingAction = 'schedule.fund' | 'webhook.fund';

export interface FundingNode {
  nodeId: string;
  templateKind: string;
  contractAddress: string;
  action: FundingAction;
  tokenContractAddress: string;
}

export interface FundingPrepared {
  intent: string;
  txHash: string;
  expiresAt: string;
  xdr: string;
  action: FundingAction;
  nodeId: string;
  fromAddress: string;
  tokenContractAddress: string;
  amountStroops: string;
  network: PaiflowNetwork;
  networkPassphrase: string;
}

export interface FundingReconciled {
  intent: string;
  action: FundingAction;
  txHash: string;
  state: 'PREPARED' | 'SUBMITTING' | 'SUCCESS' | 'FAILED' | 'EXPIRED';
  expiresAt: string;
}

/** A keyed webhook release. `httpStatus` 202 means PENDING or UNKNOWN: replay the same key, never a new one. */
export interface WebhookAttempt {
  attemptId?: string;
  txHash?: string;
  status: 'SUCCESS' | 'FAILED' | 'PENDING' | 'UNKNOWN' | 'REJECTED';
  ledger?: number;
  error?: PaiflowTxError;
  httpStatus: number;
}

export interface PaiflowApi {
  readonly configured: boolean;
  readonly deploymentId: string;
  capabilities(): Promise<PaiflowCapabilities>;
  prepareExecute(from: string, amountStroops: string): Promise<PreparedExecute>;
  submitExecute(signedXdr: string, options?: { requestId?: string }): Promise<SubmittedExecute>;
  /** Null when Paiflow has no record of the hash (unattributed). */
  transactionStatus(txHash: string): Promise<PaiflowTransactionStatus | null>;
  events(txHash: string): Promise<PaiflowEvent[]>;
  balances(): Promise<PaiflowBalances>;
  discoverFunding(): Promise<FundingNode[]>;
  prepareFunding(input: { nodeId?: string; fromAddress: string; tokenContractAddress: string; amountStroops: string }): Promise<FundingPrepared>;
  submitFunding(input: { action: FundingAction; intent: string; signedXdr: string }): Promise<PaiflowTransactionStatus>;
  reconcileFunding(input: { action: FundingAction; intent: string }): Promise<FundingReconciled>;
  /** Webhook flows only. Always keyed: an unkeyed call could release another payout. */
  webhook(body: { escrow: true; amount: string }, options: { idempotencyKey: string }): Promise<WebhookAttempt>;
}
