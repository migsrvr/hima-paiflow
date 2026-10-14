import { PaiflowClient } from './client.js';
import { PaiflowError } from './errors.js';
import { FLOW_NAMES, type FlowName, type PaiflowApi, type PaiflowInputAsset } from './types.js';

/** One deployment's settings. The token and webhook secret never leave this server. */
export interface FlowConfig {
  deploymentId: string;
  token: string;
  /** Deposit flows: the trigger (Receive) contract every prepared envelope must call. */
  triggerContract?: string;
  /** Webhook flows: Paiflow's x-webhook-secret. */
  webhookSecret?: string;
}

/** What Hima expects each deployment to be. A mismatch makes the flow "not ready", never silently used. */
export const FLOW_EXPECTATIONS: Record<FlowName, { label: string; trigger: 'deposit' | 'webhook' }> = {
  checkout: { label: 'NFC checkout', trigger: 'deposit' },
  allowance: { label: 'Smart allowance', trigger: 'deposit' },
  reward: { label: 'AI savings reward', trigger: 'webhook' },
};

export interface FlowStatus {
  flow: FlowName;
  label: string;
  configured: boolean;
  deploymentId: string | null;
  expectedTrigger: 'deposit' | 'webhook';
  triggerType: string | null;
  inputAsset: PaiflowInputAsset;
  /** Ready means: configured, readable, the expected trigger, XLM input, and the operation Hima uses is supported. */
  ready: boolean;
  problems: string[];
  checkedAt: string | null;
}

interface RegistryOptions {
  baseUrl: string;
  timeoutMs?: number;
  flows: Record<FlowName, FlowConfig>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Tests inject clients directly. */
  clients?: Partial<Record<FlowName, PaiflowApi>>;
}

const STATUS_TTL_MS = 5 * 60_000;

const assetLabel = (asset: PaiflowInputAsset) =>
  !asset ? 'unknown' : asset.kind === 'native' ? 'XLM' : asset.kind === 'known' ? asset.symbol : asset.code;

export class PaiflowRegistry {
  private readonly clients: Record<FlowName, PaiflowApi>;
  private readonly cache = new Map<FlowName, { status: FlowStatus; at: number }>();

  constructor(private readonly options: RegistryOptions) {
    this.clients = Object.fromEntries(FLOW_NAMES.map((flow) => {
      const c = options.flows[flow];
      const client = options.clients?.[flow] ?? new PaiflowClient({
        baseUrl: options.baseUrl,
        deploymentId: c.deploymentId,
        token: c.token,
        webhookSecret: c.webhookSecret,
        timeoutMs: options.timeoutMs,
        fetchImpl: options.fetchImpl,
      });
      return [flow, client];
    })) as Record<FlowName, PaiflowApi>;
  }

  private now() {
    return this.options.now?.() ?? new Date();
  }

  /** Configured means this flow has its own deployment id and token (and webhook secret for webhook flows). */
  configured(flow: FlowName): boolean {
    const c = this.options.flows[flow];
    const base = Boolean(c.deploymentId && c.token);
    return FLOW_EXPECTATIONS[flow].trigger === 'webhook' ? base && Boolean(c.webhookSecret) : base;
  }

  config(flow: FlowName): FlowConfig {
    return this.options.flows[flow];
  }

  /** The flow's own client. Never another flow's: a missing deployment is an error, not a fallback. */
  client(flow: FlowName): PaiflowApi {
    if (!this.configured(flow)) {
      throw new PaiflowError('FLOW_NOT_CONFIGURED', undefined, `The ${FLOW_EXPECTATIONS[flow].label} Paiflow deployment is not configured.`);
    }
    return this.clients[flow];
  }

  /** Readiness from the deployment's recorded capabilities, cached for five minutes. */
  async status(flow: FlowName, { fresh = false } = {}): Promise<FlowStatus> {
    const cached = this.cache.get(flow);
    if (!fresh && cached && this.now().getTime() - cached.at < STATUS_TTL_MS) return cached.status;

    const expected = FLOW_EXPECTATIONS[flow];
    const c = this.options.flows[flow];
    const base: FlowStatus = {
      flow,
      label: expected.label,
      configured: this.configured(flow),
      deploymentId: c.deploymentId || null,
      expectedTrigger: expected.trigger,
      triggerType: null,
      inputAsset: null,
      ready: false,
      problems: [],
      checkedAt: null,
    };
    if (!base.configured) {
      const missing = [!c.deploymentId && 'deployment id', !c.token && 'API token', expected.trigger === 'webhook' && !c.webhookSecret && 'webhook secret']
        .filter(Boolean)
        .join(', ');
      return { ...base, problems: [`Not configured (missing ${missing}).`] };
    }

    let status: FlowStatus;
    try {
      const caps = await this.clients[flow].capabilities();
      const problems: string[] = [];
      if (caps.network !== 'testnet') problems.push(`Deployment is on ${caps.network}; Hima only pays on testnet.`);
      if (caps.triggerType !== expected.trigger) problems.push(`Deployment is ${caps.triggerType}-triggered; Hima expects ${expected.trigger}.`);
      if (expected.trigger === 'deposit') {
        if (caps.inputAsset?.kind !== 'native') {
          problems.push(`Input asset is ${assetLabel(caps.inputAsset)}; Hima prices these payments in XLM.`);
        }
        if (caps.operations.execute?.status !== 'supported') problems.push('Paiflow does not support execute for this deployment.');
      } else if (caps.operations.webhook?.status !== 'supported') {
        problems.push('Paiflow does not support webhook calls for this deployment (enable HTTP callbacks).');
      }
      status = { ...base, triggerType: caps.triggerType, inputAsset: caps.inputAsset, ready: problems.length === 0, problems, checkedAt: this.now().toISOString() };
    } catch (error) {
      const why = error instanceof PaiflowError ? `${error.code}${error.httpStatus ? ` (${error.httpStatus})` : ''}` : 'error';
      // Not cached: a transient outage shouldn't hide the deployment for five minutes.
      return { ...base, problems: [`Could not read capabilities: ${why}.`], checkedAt: this.now().toISOString() };
    }
    this.cache.set(flow, { status, at: this.now().getTime() });
    return status;
  }

  statuses(): Promise<FlowStatus[]> {
    return Promise.all(FLOW_NAMES.map((flow) => this.status(flow)));
  }
}
