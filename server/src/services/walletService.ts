import { type Keypair, StrKey } from '@stellar/stellar-sdk';
import type { PaiflowRegistry } from '../integrations/paiflow/registry.js';
import type { PaiflowInputAsset } from '../integrations/paiflow/types.js';
import { formatCentavos } from './amounts.js';
import { EXPLORER_BASE } from './attemptView.js';
import { ServiceError } from './errors.js';
import type { HorizonApi, HorizonBalance } from './horizonClient.js';

export interface WalletView {
  network: 'testnet';
  publicKey: string;
  asset: { code: string; kind: 'native' | 'known' | 'custom' | 'unknown' };
  /** Seven-decimal string, or null when Horizon could not be read. Never invented. */
  balance: string | null;
  balanceError?: 'HORIZON_UNAVAILABLE' | 'ACCOUNT_NOT_FUNDED';
  /** PHP per unit of the input asset, two decimals ("7.50"): a fixed demo rate. */
  phpPerUnit: string;
  explorerAccountUrl: string;
  /** The checkout deployment: whether Hima can pay through it right now, and why not. */
  paiflow: { configured: boolean; ready: boolean; problems: string[]; deploymentId: string; triggerContract?: string; triggerContractUrl?: string };
  readAt: string;
}

export interface AccountView {
  address: string;
  exists: boolean;
  assetCode: 'XLM';
  balance: string | null;
  explorerAccountUrl: string;
}

interface WalletOptions {
  registry: PaiflowRegistry;
  horizon: HorizonApi;
  /** The student's paying wallet (server-held). */
  student?: Keypair;
  rateCentavos: number;
  now?: () => Date;
}

function assetInfo(asset: PaiflowInputAsset): WalletView['asset'] {
  if (!asset) return { code: 'XLM', kind: 'unknown' };
  if (asset.kind === 'native') return { code: 'XLM', kind: 'native' };
  if (asset.kind === 'known') return { code: asset.symbol, kind: 'known' };
  return { code: asset.code, kind: 'custom' };
}

function pickBalance(balances: HorizonBalance[], asset: WalletView['asset']): string {
  const match = asset.kind === 'native' || asset.kind === 'unknown'
    ? balances.find((b) => b.assetType === 'native')
    : balances.find((b) => b.code === asset.code);
  return match?.balance ?? '0.0000000';
}

/** Hima's testnet paying wallet and read-only lookups of other testnet accounts (a linked Freighter wallet). */
export class WalletService {
  constructor(private readonly options: WalletOptions) {}

  async wallet(): Promise<WalletView> {
    const student = this.options.student;
    if (!student) throw new ServiceError('STELLAR_NOT_CONFIGURED', 503, "Hima's testnet wallet isn't set up on the server yet.");
    const publicKey = student.publicKey();
    const flow = await this.options.registry.status('checkout');
    const asset = assetInfo(flow.inputAsset);
    let balance: string | null = null;
    let balanceError: WalletView['balanceError'];
    try {
      const balances = await this.options.horizon.balances(publicKey);
      if (balances) balance = pickBalance(balances, asset);
      else balanceError = 'ACCOUNT_NOT_FUNDED';
    } catch {
      balanceError = 'HORIZON_UNAVAILABLE';
    }
    const config = this.options.registry.config('checkout');
    const trigger = config.triggerContract;
    return {
      network: 'testnet',
      publicKey,
      asset,
      balance,
      ...(balanceError ? { balanceError } : {}),
      phpPerUnit: formatCentavos(this.options.rateCentavos),
      explorerAccountUrl: `${EXPLORER_BASE}/account/${publicKey}`,
      paiflow: {
        configured: flow.configured,
        ready: flow.ready,
        problems: flow.problems,
        deploymentId: config.deploymentId,
        ...(trigger ? { triggerContract: trigger, triggerContractUrl: `${EXPLORER_BASE}/contract/${trigger}` } : {}),
      },
      readAt: (this.options.now?.() ?? new Date()).toISOString(),
    };
  }

  async lookupAccount(address: string): Promise<AccountView> {
    const id = address.trim();
    if (!StrKey.isValidEd25519PublicKey(id)) {
      throw new ServiceError('INVALID_ADDRESS', 400, "That isn't a Stellar public address (G…).");
    }
    let balances: HorizonBalance[] | null;
    try {
      balances = await this.options.horizon.balances(id);
    } catch {
      throw new ServiceError('HORIZON_UNAVAILABLE', 503, "Couldn't reach the Stellar testnet. Try again.");
    }
    return {
      address: id,
      exists: balances !== null,
      assetCode: 'XLM',
      balance: balances ? (balances.find((b) => b.assetType === 'native')?.balance ?? '0.0000000') : null,
      explorerAccountUrl: `${EXPLORER_BASE}/account/${id}`,
    };
  }
}
