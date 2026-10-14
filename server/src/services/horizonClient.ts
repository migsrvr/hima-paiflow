// Read-only Horizon calls: account balances (wallet, Freighter lookups), a transaction lookup
// used as the final word once a payment envelope has expired, and a transaction's effects, which
// show who a Paiflow Split actually paid.

export interface HorizonBalance {
  assetType: string;
  /** Undefined for the native asset (XLM). */
  code?: string;
  issuer?: string;
  /** Decimal string with up to seven places, as Horizon reports it. */
  balance: string;
}

export interface HorizonTransaction {
  hash: string;
  successful: boolean;
  ledger: number;
  createdAt: string;
}

/** One `account_credited` effect: an account (G…) received `amount` of an asset in the transaction. */
export interface HorizonCredit {
  account: string;
  /** Decimal string with up to seven places. */
  amount: string;
  assetType: string;
  code?: string;
  issuer?: string;
}

export interface HorizonApi {
  /** Null when the account does not exist (never funded). */
  balances(accountId: string): Promise<HorizonBalance[] | null>;
  /** Null when Horizon has no such transaction. */
  transaction(hash: string): Promise<HorizonTransaction | null>;
  /** Accounts the transaction credited. Null when Horizon has no such transaction (yet). */
  credits(hash: string): Promise<HorizonCredit[] | null>;
}

export class HorizonError extends Error {
  constructor(public readonly code: 'NETWORK' | 'TIMEOUT' | 'BAD_RESPONSE', message: string) {
    super(message);
    this.name = 'HorizonError';
  }
}

interface HorizonOptions {
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export class HorizonClient implements HorizonApi {
  private readonly options: HorizonOptions;

  constructor(options: HorizonOptions) {
    this.options = { ...options, baseUrl: options.baseUrl.replace(/\/+$/, '') };
  }

  async balances(accountId: string): Promise<HorizonBalance[] | null> {
    const body = await this.get(`/accounts/${encodeURIComponent(accountId)}`);
    if (body === null) return null;
    const list = record(body)?.balances;
    if (!Array.isArray(list)) throw new HorizonError('BAD_RESPONSE', 'Horizon returned an unreadable account.');
    return list.flatMap((item) => {
      const b = record(item);
      return b && typeof b.asset_type === 'string' && typeof b.balance === 'string'
        ? [{
          assetType: b.asset_type,
          code: typeof b.asset_code === 'string' ? b.asset_code : undefined,
          issuer: typeof b.asset_issuer === 'string' ? b.asset_issuer : undefined,
          balance: b.balance,
        }]
        : [];
    });
  }

  async transaction(hash: string): Promise<HorizonTransaction | null> {
    const body = await this.get(`/transactions/${encodeURIComponent(hash)}`);
    if (body === null) return null;
    const t = record(body);
    if (!t || typeof t.hash !== 'string' || typeof t.successful !== 'boolean') {
      throw new HorizonError('BAD_RESPONSE', 'Horizon returned an unreadable transaction.');
    }
    return { hash: t.hash, successful: t.successful, ledger: Number(t.ledger ?? 0), createdAt: String(t.created_at ?? '') };
  }

  async credits(hash: string): Promise<HorizonCredit[] | null> {
    const body = await this.get(`/transactions/${encodeURIComponent(hash)}/effects?limit=200&order=asc`);
    if (body === null) return null;
    const records = record(record(body)?._embedded)?.records;
    if (!Array.isArray(records)) throw new HorizonError('BAD_RESPONSE', 'Horizon returned unreadable effects.');
    return records.flatMap((item) => {
      const e = record(item);
      return e && e.type === 'account_credited' && typeof e.account === 'string' && typeof e.amount === 'string'
        ? [{
          account: e.account,
          amount: e.amount,
          assetType: String(e.asset_type ?? ''),
          code: typeof e.asset_code === 'string' ? e.asset_code : undefined,
          issuer: typeof e.asset_issuer === 'string' ? e.asset_issuer : undefined,
        }]
        : [];
    });
  }

  private async get(path: string): Promise<unknown | null> {
    const signal = AbortSignal.timeout(this.options.timeoutMs ?? 10_000);
    let response: Response;
    try {
      response = await (this.options.fetchImpl ?? fetch)(`${this.options.baseUrl}${path}`, {
        signal,
        headers: { Accept: 'application/json' },
      });
    } catch (error) {
      if (signal.aborted || (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))) {
        throw new HorizonError('TIMEOUT', 'Horizon took too long to answer.');
      }
      throw new HorizonError('NETWORK', 'Horizon could not be reached.');
    }
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new HorizonError('NETWORK', `Horizon answered ${response.status}.`);
    }
    try {
      return await response.json();
    } catch {
      throw new HorizonError('BAD_RESPONSE', 'Horizon returned unreadable JSON.');
    }
  }
}
