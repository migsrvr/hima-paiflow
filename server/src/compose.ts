import { randomBytes } from 'node:crypto';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import type { AppServices } from './app.js';
import type { ServerConfig } from './config.js';
import { PaiflowRegistry } from './integrations/paiflow/registry.js';
import { FileAttemptStore, type AttemptStore } from './services/attemptStore.js';
import { createPostgresPool, PostgresAttemptStore } from './services/postgresAttemptStore.js';
import { ChatService } from './services/chatService.js';
import { CheckoutService } from './services/checkoutService.js';
import { DepositExecutor } from './services/depositExecutor.js';
import { buildCatalog } from './services/flowCatalog.js';
import { HorizonClient } from './services/horizonClient.js';
import { PaymentVerifier } from './services/paymentVerification.js';
import { SessionService } from './services/sessionService.js';
import { WalletService } from './services/walletService.js';
import { horizonMerge, WalletTopUp } from './services/walletTopUp.js';

function keypair(secret: string, name: string): Keypair | undefined {
  if (!secret) return undefined;
  if (!StrKey.isValidEd25519SecretSeed(secret)) throw new Error(`${name} is not a valid Stellar secret key.`);
  return Keypair.fromSecret(secret);
}

export interface Composed extends AppServices {
  student?: Keypair;
  sponsor?: Keypair;
  horizon: HorizonClient;
  /** Refills the testnet paying wallet for the public demo; undefined without a student wallet. */
  topUp?: WalletTopUp;
  warnings: string[];
}

/** Builds every service from configuration. Shared by the server and the scripts, so both behave identically. */
export function compose(config: ServerConfig, options: { log?: (message: string) => void; attempts?: AttemptStore } = {}): Composed {
  const log = options.log ?? console.warn;
  const warnings = [...config.warnings];
  const student = keypair(config.stellar.studentSecret, 'STELLAR_STUDENT_SECRET');
  const sponsor = keypair(config.stellar.sponsorSecret, 'STELLAR_SPONSOR_SECRET');

  let secret = config.sessionSecret;
  if (!secret) {
    secret = randomBytes(32).toString('hex');
    warnings.push('SESSION_SECRET is unset: sign-ins reset when the server restarts. Run npm run stellar:setup to create one.');
  }

  const horizon = new HorizonClient({ baseUrl: config.stellar.horizonUrl });
  const registry = new PaiflowRegistry({ baseUrl: config.paiflow.baseUrl, timeoutMs: config.paiflow.timeoutMs, flows: config.paiflow.flows });
  const attempts = options.attempts ?? (config.storage.backend === 'postgres'
    ? new PostgresAttemptStore(createPostgresPool(config.storage.databaseUrl, config.storage.sslCa))
    : new FileAttemptStore(config.files.attempts));
  const executor = new DepositExecutor({ registry, horizon, store: attempts, log });
  const verifier = new PaymentVerifier({ horizon, log });
  const catalog = buildCatalog({
    merchant: config.stellar.merchantPublicKey || null,
    student: student?.publicKey() ?? null,
    savings: config.stellar.savingsPublicKey || null,
    emergency: config.stellar.emergencyPublicKey || null,
    rewardAmountStroops: config.reward.amountStroops,
    overrides: config.paiflow.recipients,
  });

  return {
    ai: new ChatService({ apiKey: config.apiKey, model: config.model, timeoutMs: config.timeoutMs }),
    sessions: new SessionService({ secret }),
    registry,
    catalog,
    attempts,
    executor,
    checkout: new CheckoutService({
      executor,
      registry,
      store: attempts,
      horizon,
      verifier,
      legs: catalog.checkout.legs,
      student,
      rateCentavos: config.payments.rateCentavos,
      maxPaymentCentavos: config.payments.maxPaymentCentavos,
      log,
    }),
    wallet: new WalletService({ registry, horizon, student, rateCentavos: config.payments.rateCentavos }),
    student,
    sponsor,
    horizon,
    topUp: student
      ? new WalletTopUp({ horizon, wallet: student.publicKey(), belowStroops: config.topUpBelowStroops, merge: horizonMerge(config.stellar.horizonUrl), log })
      : undefined,
    warnings,
  };
}
