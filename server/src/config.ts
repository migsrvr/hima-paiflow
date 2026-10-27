import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';
import type { FlowConfig } from './integrations/paiflow/registry.js';
import type { FlowName } from './integrations/paiflow/types.js';
import { decimalToStroops, parseCentavos } from './services/amounts.js';

// src/ and dist/ both sit immediately under server/, independent of process.cwd().
export const SERVER_ROOT = resolve(__dirname, '..');
dotenv.config({ path: resolve(SERVER_ROOT, '.env') });

const optionalMatch = (pattern: RegExp) => z.string().trim().refine((v) => v === '' || pattern.test(v)).default('');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PFK = /^pfk_[0-9a-f]{64}$/i;
const CONTRACT = /^C[A-Z2-7]{55}$/;
const SECRET_KEY = /^S[A-Z2-7]{55}$/;
const PUBLIC_KEY = /^G[A-Z2-7]{55}$/;
const flag = z.string().trim().toLowerCase().transform((v) => v === 'true' || v === '1' || v === 'yes').default('false');

const environmentSchema = z.object({
  RENDER: flag,
  STORAGE_BACKEND: z.enum(['file', 'postgres']).default('file'),
  DATABASE_URL: z.string().trim().default(''),
  DATABASE_SSL_CA: z.string().default(''),
  GROQ_API_KEY: z.string().trim().default(''),
  GROQ_MODEL: z.string().trim().min(1).default('openai/gpt-oss-120b'),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(60000),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  CORS_ORIGINS: z.string().default(''),
  // Signs session tokens issued at login. Generate with npm run stellar:setup.
  SESSION_SECRET: z.string().trim().refine((v) => v === '' || v.length >= 32).default(''),

  // Wallets. Secrets never leave this server.
  STELLAR_STUDENT_SECRET: optionalMatch(SECRET_KEY), // pays checkout; receives the allowance Spending share
  STELLAR_SPONSOR_SECRET: optionalMatch(SECRET_KEY), // funds the allowance flow and the reward pool
  STELLAR_MERCHANT_PUBLIC_KEY: optionalMatch(PUBLIC_KEY), // Campus Canteen
  STELLAR_SAVINGS_PUBLIC_KEY: optionalMatch(PUBLIC_KEY),
  STELLAR_EMERGENCY_PUBLIC_KEY: optionalMatch(PUBLIC_KEY),
  HORIZON_URL: z.string().trim().url().default('https://horizon-testnet.stellar.org'),

  // Paiflow: one deployment per flow, each with its own credentials.
  PAIFLOW_BASE_URL: z.string().trim().url().optional(),
  PAIFLOW_CHECKOUT_ID: optionalMatch(UUID),
  PAIFLOW_CHECKOUT_TOKEN: optionalMatch(PFK),
  PAIFLOW_CHECKOUT_TRIGGER_CONTRACT: optionalMatch(CONTRACT),
  PAIFLOW_ALLOWANCE_ID: optionalMatch(UUID),
  PAIFLOW_ALLOWANCE_TOKEN: optionalMatch(PFK),
  PAIFLOW_ALLOWANCE_TRIGGER_CONTRACT: optionalMatch(CONTRACT),
  PAIFLOW_REWARD_ID: optionalMatch(UUID),
  PAIFLOW_REWARD_TOKEN: optionalMatch(PFK),
  PAIFLOW_REWARD_WEBHOOK_SECRET: z.string().trim().default(''),
  PAIFLOW_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(20000),
  // The addresses each deployment actually pays, as role:G… pairs. They default to the wallets above;
  // set them when a flow was built with other recipients, so payouts are verified against the real ones.
  PAIFLOW_CHECKOUT_RECIPIENTS: z.string().trim().default(''), // merchant:G…,savings:G…
  PAIFLOW_ALLOWANCE_RECIPIENTS: z.string().trim().default(''), // spending:G…,savings:G…,emergency:G…
  PAIFLOW_REWARD_RECIPIENT: optionalMatch(PUBLIC_KEY),
  // Single-flow names from before: read as the checkout deployment only (deprecated).
  PAIFLOW_API_BASE: z.string().trim().url().optional(),
  PAIFLOW_DEPLOYMENT_ID: optionalMatch(UUID),
  PAIFLOW_API_TOKEN: optionalMatch(PFK),
  PAIFLOW_TRIGGER_CONTRACT: optionalMatch(CONTRACT),

  // Fixed demo rate: PHP per XLM (1 XLM = ₱7.50).
  PHP_PER_INPUT_UNIT: z.string().trim().refine((v) => parseCentavos(v) !== undefined).default('7.50'),
  PAYMENT_MAX_PHP: z.coerce.number().int().min(1).max(100000).default(5000),
  DATA_DIR: z.string().trim().default(''),

  // Flow 2 and 3 settings.
  ALLOWANCE_DEV_FUNDING: flag,
  REWARD_AMOUNT_XLM: z.string().trim().refine((v) => (decimalToStroops(v) ?? 0n) > 0n).default('5'),
  REWARD_ALLOW_OPEN_PERIOD: flag,
  REWARD_TZ_OFFSET_MINUTES: z.coerce.number().int().min(-720).max(840).default(480),

  // Public demo limits; 0 turns one off. Behind a proxy (Render), TRUST_PROXY makes them per client IP.
  TRUST_PROXY: z.string().trim().toLowerCase().default(''),
  RATE_SIGNIN_PER_IP_HOUR: z.coerce.number().int().min(0).default(10),
  RATE_AI_PER_USER_HOUR: z.coerce.number().int().min(0).default(20),
  RATE_AI_PER_IP_HOUR: z.coerce.number().int().min(0).default(40),
  RATE_PAYMENTS_PER_USER_DAY: z.coerce.number().int().min(0).default(5),
  RATE_PAYMENTS_PER_IP_DAY: z.coerce.number().int().min(0).default(10),
  RATE_PAYMENTS_PER_DAY: z.coerce.number().int().min(0).default(100),
  // Refill the testnet paying wallet with Friendbot XLM when it drops below this; 0 turns it off.
  DEMO_TOPUP_BELOW_XLM: z.string().trim().refine((v) => decimalToStroops(v) !== undefined).default('100'),
});

/** "merchant:GA…,savings:GB…" -> { merchant: 'GA…', savings: 'GB…' }. Throws (field name only) on anything else. */
function recipients(value: string, name: string, roles: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of value.split(',').map((p) => p.trim()).filter(Boolean)) {
    const [role, address] = pair.split(':').map((p) => p.trim());
    if (!roles.includes(role) || !PUBLIC_KEY.test(address ?? '')) throw new Error(`Invalid server configuration: ${name}`);
    out[role] = address;
  }
  return out;
}

export function loadConfig() {
  const parsed = environmentSchema.safeParse(process.env);
  if (!parsed.success) {
    // Report field names only; never log environment values, keys or secrets.
    throw new Error(`Invalid server configuration: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
  }
  const env = parsed.data;
  if (env.RENDER && env.STORAGE_BACKEND !== 'postgres') throw new Error('Render requires STORAGE_BACKEND=postgres.');
  if ((env.RENDER || env.STORAGE_BACKEND === 'postgres') && !env.SESSION_SECRET) {
    throw new Error('Hosted persistence requires a stable SESSION_SECRET (at least 32 characters).');
  }
  if (env.STORAGE_BACKEND === 'postgres' && !env.DATABASE_URL) throw new Error('Postgres storage requires DATABASE_URL.');
  const warnings: string[] = [];
  const checkoutRecipients = recipients(env.PAIFLOW_CHECKOUT_RECIPIENTS, 'PAIFLOW_CHECKOUT_RECIPIENTS', ['merchant', 'savings']);
  const allowanceRecipients = recipients(env.PAIFLOW_ALLOWANCE_RECIPIENTS, 'PAIFLOW_ALLOWANCE_RECIPIENTS', ['spending', 'savings', 'emergency']);

  // The old single-flow settings stay readable, but only ever as the checkout deployment.
  const legacy = (current: string, old: string, newName: string, oldName: string) => {
    if (current || !old) return current;
    warnings.push(`${oldName} is deprecated; rename it to ${newName} in server/.env.`);
    return old;
  };
  const flows: Record<FlowName, FlowConfig> = {
    checkout: {
      deploymentId: legacy(env.PAIFLOW_CHECKOUT_ID, env.PAIFLOW_DEPLOYMENT_ID, 'PAIFLOW_CHECKOUT_ID', 'PAIFLOW_DEPLOYMENT_ID'),
      token: legacy(env.PAIFLOW_CHECKOUT_TOKEN, env.PAIFLOW_API_TOKEN, 'PAIFLOW_CHECKOUT_TOKEN', 'PAIFLOW_API_TOKEN'),
      triggerContract: legacy(env.PAIFLOW_CHECKOUT_TRIGGER_CONTRACT, env.PAIFLOW_TRIGGER_CONTRACT,
        'PAIFLOW_CHECKOUT_TRIGGER_CONTRACT', 'PAIFLOW_TRIGGER_CONTRACT') || undefined,
    },
    allowance: {
      deploymentId: env.PAIFLOW_ALLOWANCE_ID,
      token: env.PAIFLOW_ALLOWANCE_TOKEN,
      triggerContract: env.PAIFLOW_ALLOWANCE_TRIGGER_CONTRACT || undefined,
    },
    reward: {
      deploymentId: env.PAIFLOW_REWARD_ID,
      token: env.PAIFLOW_REWARD_TOKEN,
      webhookSecret: env.PAIFLOW_REWARD_WEBHOOK_SECRET || undefined,
    },
  };
  let baseUrl = env.PAIFLOW_BASE_URL;
  if (!baseUrl && env.PAIFLOW_API_BASE) {
    warnings.push('PAIFLOW_API_BASE is deprecated; set PAIFLOW_BASE_URL to the Paiflow origin instead.');
    baseUrl = env.PAIFLOW_API_BASE;
  }
  const dataDir = env.DATA_DIR || resolve(SERVER_ROOT, 'data');

  return {
    storage: { backend: env.STORAGE_BACKEND, databaseUrl: env.DATABASE_URL, sslCa: env.DATABASE_SSL_CA || undefined },
    hosted: env.RENDER,
    apiKey: env.GROQ_API_KEY,
    model: env.GROQ_MODEL,
    timeoutMs: env.AI_TIMEOUT_MS,
    port: env.PORT,
    host: env.HOST,
    corsOrigins: env.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
    sessionSecret: env.SESSION_SECRET,
    stellar: {
      studentSecret: env.STELLAR_STUDENT_SECRET,
      sponsorSecret: env.STELLAR_SPONSOR_SECRET,
      merchantPublicKey: env.STELLAR_MERCHANT_PUBLIC_KEY,
      savingsPublicKey: env.STELLAR_SAVINGS_PUBLIC_KEY,
      emergencyPublicKey: env.STELLAR_EMERGENCY_PUBLIC_KEY,
      horizonUrl: env.HORIZON_URL,
    },
    paiflow: {
      baseUrl: (baseUrl ?? 'https://beta.app.paiflow.xyz').replace(/\/+$/, '').replace(/\/api\/v1$/, ''),
      timeoutMs: env.PAIFLOW_TIMEOUT_MS,
      flows,
      recipients: {
        checkout: checkoutRecipients,
        allowance: allowanceRecipients,
        reward: env.PAIFLOW_REWARD_RECIPIENT || undefined,
      },
    },
    payments: {
      rateCentavos: parseCentavos(env.PHP_PER_INPUT_UNIT) as number,
      maxPaymentCentavos: env.PAYMENT_MAX_PHP * 100,
    },
    // Render sits one proxy in front of the app; without TRUST_PROXY every visitor shares one IP.
    trustProxy: env.TRUST_PROXY === '' ? (env.RENDER ? 1 : false) : /^\d+$/.test(env.TRUST_PROXY) ? Number(env.TRUST_PROXY) : env.TRUST_PROXY === 'true',
    limits: {
      signInPerIpHour: env.RATE_SIGNIN_PER_IP_HOUR,
      aiPerUserHour: env.RATE_AI_PER_USER_HOUR,
      aiPerIpHour: env.RATE_AI_PER_IP_HOUR,
      paymentsPerUserDay: env.RATE_PAYMENTS_PER_USER_DAY,
      paymentsPerIpDay: env.RATE_PAYMENTS_PER_IP_DAY,
      paymentsPerDay: env.RATE_PAYMENTS_PER_DAY,
    },
    topUpBelowStroops: decimalToStroops(env.DEMO_TOPUP_BELOW_XLM) as bigint,
    allowance: { devFunding: env.ALLOWANCE_DEV_FUNDING },
    reward: {
      amountStroops: decimalToStroops(env.REWARD_AMOUNT_XLM) as bigint,
      allowOpenPeriod: env.REWARD_ALLOW_OPEN_PERIOD,
      tzOffsetMinutes: env.REWARD_TZ_OFFSET_MINUTES,
    },
    files: {
      attempts: resolve(dataDir, 'attempts.json'),
      rewards: resolve(dataDir, 'rewards.json'),
    },
    warnings,
  };
}

export type ServerConfig = ReturnType<typeof loadConfig>;
