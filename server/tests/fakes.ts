// Test doubles shared by the server tests. No network: Paiflow and Horizon are fakes.
import { Account, type Keypair, nativeToScVal, Networks, Operation, type Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import { PaiflowRegistry, type FlowConfig } from '../src/integrations/paiflow/registry.js';
import type { AttemptStore } from '../src/services/attemptStore.js';
import { CheckoutService } from '../src/services/checkoutService.js';
import type { DepositExecutor } from '../src/services/depositExecutor.js';
import { buildCatalog, type RecipientLeg } from '../src/services/flowCatalog.js';
import { PaymentVerifier } from '../src/services/paymentVerification.js';
import type {
  FlowName, FundingNode, PaiflowApi, PaiflowBalances, PaiflowCapabilities, PaiflowInputAsset, PaiflowTransactionStatus,
  PreparedExecute, SubmittedExecute, WebhookAttempt,
} from '../src/integrations/paiflow/types.js';
import type { HorizonApi, HorizonBalance, HorizonCredit, HorizonTransaction } from '../src/services/horizonClient.js';

export const CHECKOUT_TRIGGER = 'CAKRU64K24K4RDHU2VVPDL4CCGEQCV5SQE3AEPM63WTSQWHIABHPREGQ';
export const IDS: Record<FlowName, string> = {
  checkout: 'd3496d67-891b-46c8-bedb-55fe0bef5f0f',
  allowance: '6b1f0c52-3d4e-4a8b-9c7d-2e5f8a1b3c4d',
  reward: '0c9d7a3e-5b1f-4e2a-8d6c-7f4b3a2e1d0c',
};
export const TOKENS: Record<FlowName, string> = {
  checkout: `pfk_${'a'.repeat(64)}`,
  allowance: `pfk_${'b'.repeat(64)}`,
  reward: `pfk_${'c'.repeat(64)}`,
};

/** An unsigned deposit shaped like the one Paiflow prepares. */
export function envelope(source: string, amount: bigint, o: { contract?: string; fn?: string; fee?: string; extraOp?: boolean } = {}) {
  const builder = new TransactionBuilder(new Account(source, '100'), { fee: o.fee ?? '250000', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.invokeContractFunction({
      contract: o.contract ?? CHECKOUT_TRIGGER,
      function: o.fn ?? 'deposit',
      args: [nativeToScVal(source, { type: 'address' }), nativeToScVal(amount, { type: 'i128' })],
    }));
  if (o.extraOp) builder.addOperation(Operation.bumpSequence({ bumpTo: '999' }));
  return builder.setTimeout(180).build().toXDR();
}

export const hashOf = (signedXdr: string) =>
  Buffer.from((TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET) as Transaction).hash()).toString('hex');

export class Clock {
  t = Date.now();
  now = () => new Date(this.t);
  advance(ms: number) { this.t += ms; }
}

export class FakePaiflow implements PaiflowApi {
  configured = true;
  triggerType = 'deposit';
  inputAsset: PaiflowInputAsset = { kind: 'native' };
  operations: PaiflowCapabilities['operations'] = {
    execute: { status: 'supported', authentication: 'deployment_token', requirements: [], nodeIds: [] },
  };
  capabilityReads = 0;
  prepares: Array<{ from: string; amount: string }> = [];
  submits: string[] = [];
  statusReads = 0;
  webhooks: Array<{ body: unknown; idempotencyKey: string }> = [];

  constructor(private readonly clock: Clock, readonly deploymentId: string = IDS.checkout) {}

  onCapabilities = async (): Promise<PaiflowCapabilities> => ({
    deploymentId: this.deploymentId, network: 'testnet', triggerType: this.triggerType, inputAsset: this.inputAsset, operations: this.operations,
  });
  onPrepare = async (from: string, amount: string): Promise<PreparedExecute> => ({
    xdr: envelope(from, BigInt(amount)),
    networkPassphrase: Networks.TESTNET,
    network: 'testnet',
    expiresAt: new Date(this.clock.t + 180_000).toISOString(),
    requestId: 'req-1',
  });
  onSubmit = async (signedXdr: string): Promise<SubmittedExecute> => ({ txHash: hashOf(signedXdr), status: 'PENDING' });
  onStatus = async (_hash: string): Promise<PaiflowTransactionStatus | null> => null;
  onWebhook = async (): Promise<WebhookAttempt> => ({ status: 'PENDING', httpStatus: 202 });

  async capabilities() {
    this.capabilityReads++;
    return this.onCapabilities();
  }
  async prepareExecute(from: string, amount: string) {
    this.prepares.push({ from, amount });
    return this.onPrepare(from, amount);
  }
  async submitExecute(signedXdr: string) {
    this.submits.push(signedXdr);
    return this.onSubmit(signedXdr);
  }
  async transactionStatus(hash: string) {
    this.statusReads++;
    return this.onStatus(hash);
  }
  async events() { return []; }
  async balances(): Promise<PaiflowBalances> {
    return { totals: [], nodes: [], freshness: 'fresh', totalsComplete: true };
  }
  async discoverFunding(): Promise<FundingNode[]> { return []; }
  async prepareFunding(): Promise<never> { throw new Error('not used'); }
  async submitFunding(): Promise<never> { throw new Error('not used'); }
  async reconcileFunding(): Promise<never> { throw new Error('not used'); }
  async webhook(body: { escrow: true; amount: string }, options: { idempotencyKey: string }) {
    this.webhooks.push({ body, idempotencyKey: options.idempotencyKey });
    return this.onWebhook();
  }
}

export class FakeHorizon implements HorizonApi {
  accounts = new Map<string, HorizonBalance[]>();
  transactions = new Map<string, HorizonTransaction>();
  /** txHash -> the accounts it credited. */
  effects = new Map<string, HorizonCredit[]>();
  down = false;
  async balances(id: string) {
    if (this.down) throw new Error('down');
    return this.accounts.get(id) ?? null;
  }
  async transaction(hash: string) {
    if (this.down) throw new Error('down');
    return this.transactions.get(hash) ?? null;
  }
  async credits(hash: string) {
    if (this.down) throw new Error('down');
    return this.effects.get(hash) ?? null;
  }
  /** Credits in XLM decimal strings, as Horizon reports them. */
  credit(hash: string, ...pairs: Array<[string, string]>) {
    this.effects.set(hash, pairs.map(([account, amount]) => ({ account, amount, assetType: 'native' })));
  }
}

export const CANTEEN = 'GAHJPWGSD6KIJMB2ER5RIY7FCKUK7RGJALPVWQ4ZILKVVROW42G7G3E3';
export const SAVINGS = 'GAUN5DT4EYJJHFPTG73IP4IHYVVP4EHFFODHY5IKFMD3EOHI5F36AXNA';

/** A checkout service over fakes, with the 90/10 Split pointed at CANTEEN and SAVINGS unless overridden. */
export function checkoutFor(o: {
  clock: Clock;
  registry: PaiflowRegistry;
  horizon: FakeHorizon;
  store: AttemptStore;
  executor: DepositExecutor;
  student?: Keypair;
  legs?: RecipientLeg[];
}) {
  const legs = o.legs ?? buildCatalog({ merchant: CANTEEN, student: null, savings: SAVINGS, emergency: null, rewardAmountStroops: 1n }).checkout.legs;
  return new CheckoutService({
    executor: o.executor, registry: o.registry, store: o.store, horizon: o.horizon,
    verifier: new PaymentVerifier({ horizon: o.horizon, now: o.clock.now }),
    legs, student: o.student, rateCentavos: 750, maxPaymentCentavos: 500_000, now: o.clock.now,
  });
}

/** A registry whose deployments are fakes. Flows without a client are unconfigured. */
export function fakeRegistry(clock: Clock, clients: Partial<Record<FlowName, FakePaiflow>>, overrides: Partial<Record<FlowName, Partial<FlowConfig>>> = {}) {
  const flow = (name: FlowName): FlowConfig => (clients[name]
    ? {
      deploymentId: IDS[name],
      token: TOKENS[name],
      ...(name === 'checkout' ? { triggerContract: CHECKOUT_TRIGGER } : {}),
      ...(name === 'reward' ? { webhookSecret: 'whsec-test' } : {}),
      ...overrides[name],
    }
    : { deploymentId: '', token: '', ...overrides[name] });
  return new PaiflowRegistry({
    baseUrl: 'https://beta.app.paiflow.xyz',
    flows: { checkout: flow('checkout'), allowance: flow('allowance'), reward: flow('reward') },
    clients,
    now: clock.now,
  });
}
