// Keeps the shared testnet paying wallet funded for the public demo. Friendbot funds a throwaway
// account with testnet XLM, which is then merged into the paying wallet. Testnet only; logs carry
// public keys and transaction hashes, never secrets.
import { BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { decimalToStroops } from './amounts.js';
import type { HorizonApi } from './horizonClient.js';

export interface TopUpOptions {
  horizon: HorizonApi;
  /** The paying wallet's public key. */
  wallet: string;
  /** Top up when the wallet's XLM drops below this. 0 turns automatic top-ups off. */
  belowStroops: bigint;
  /** At most one automatic attempt per interval (default one hour). */
  minIntervalMs?: number;
  /** Friendbot-funds a new account. Tests pass a fake. */
  fund?: (publicKey: string) => Promise<void>;
  /** Merges `source` into `destination`; returns the transaction hash. Tests pass a fake. */
  merge?: (source: Keypair, destination: string) => Promise<string>;
  now?: () => number;
  log?: (message: string) => void;
}

export type TopUpResult = { status: 'skipped'; reason: string } | { status: 'topped_up'; txHash: string };

export class WalletTopUp {
  private lastAttempt = -Infinity;
  private running: Promise<TopUpResult> | null = null;

  constructor(private readonly options: TopUpOptions) {}

  /** The wallet's XLM in stroops, or null when Horizon can't be read. */
  async balance(): Promise<bigint | null> {
    const balances = await this.options.horizon.balances(this.options.wallet).catch(() => null);
    const native = balances?.find((b) => b.assetType === 'native');
    return native ? (decimalToStroops(native.balance) ?? null) : null;
  }

  /** Tops up when the balance is low, at most once per interval. Never throws. */
  maybeTopUp(): Promise<TopUpResult> {
    if (this.options.belowStroops <= 0n) return Promise.resolve({ status: 'skipped', reason: 'off' });
    const now = (this.options.now ?? Date.now)();
    if (this.running) return this.running;
    if (now - this.lastAttempt < (this.options.minIntervalMs ?? 60 * 60 * 1000)) {
      return Promise.resolve({ status: 'skipped', reason: 'recent' });
    }
    this.lastAttempt = now;
    this.running = (async (): Promise<TopUpResult> => {
      const balance = await this.balance();
      if (balance === null) return { status: 'skipped', reason: 'balance unavailable' };
      if (balance >= this.options.belowStroops) return { status: 'skipped', reason: 'funded' };
      return this.topUp();
    })().catch((error: unknown) => {
      this.options.log?.(`[topup] Failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      return { status: 'skipped', reason: 'failed' } as const;
    }).finally(() => { this.running = null; });
    return this.running;
  }

  /** Funds a throwaway account with Friendbot and merges it into the wallet. */
  async topUp(): Promise<TopUpResult> {
    const temp = Keypair.random();
    await (this.options.fund ?? friendbot)(temp.publicKey());
    const txHash = await (this.options.merge ?? merge)(temp, this.options.wallet);
    this.options.log?.(`[topup] Merged ${temp.publicKey()} into ${this.options.wallet}: ${txHash}`);
    return { status: 'topped_up', txHash };
  }
}

async function friendbot(publicKey: string): Promise<void> {
  const response = await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(publicKey)}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Friendbot answered ${response.status}`);
}

/** Default merge through the public testnet Horizon. */
export function horizonMerge(horizonUrl: string) {
  return async (source: Keypair, destination: string): Promise<string> => {
    const server = new Horizon.Server(horizonUrl);
    const account = await server.loadAccount(source.publicKey());
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.accountMerge({ destination }))
      .setTimeout(60)
      .build();
    tx.sign(source);
    const result = await server.submitTransaction(tx);
    return result.hash;
  };
}

const merge = horizonMerge('https://horizon-testnet.stellar.org');
