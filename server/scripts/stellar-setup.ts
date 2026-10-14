// npm run stellar:setup
// Creates every testnet wallet Hima's three Paiflow flows need (only those missing), funds them with
// Friendbot, creates SESSION_SECRET, and prints what to configure in the Paiflow builder.
// Secrets are written to server/.env only and are never printed.
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Keypair } from '@stellar/stellar-sdk';
import { compose } from '../src/compose.js';
import { loadConfig, SERVER_ROOT } from '../src/config.js';
import { formatStroops } from '../src/services/amounts.js';
import type { HorizonClient } from '../src/services/horizonClient.js';

const ENV_FILE = resolve(SERVER_ROOT, '.env');
const EXPLORER = 'https://stellar.expert/explorer/testnet';

function existingKeys(): Set<string> {
  if (!existsSync(ENV_FILE)) return new Set();
  return new Set(readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)
    .map((line) => /^\s*([A-Z0-9_]+)\s*=\s*\S/.exec(line)?.[1])
    .filter((key): key is string => Boolean(key)));
}

async function fund(label: string, publicKey: string, horizon: HorizonClient) {
  const balances = await horizon.balances(publicKey);
  if (balances) {
    const xlm = balances.find((b) => b.assetType === 'native')?.balance ?? '0';
    console.log(`  ${label.padEnd(28)} already on testnet, ${xlm} XLM`);
    return;
  }
  const response = await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(publicKey)}`);
  await response.body?.cancel();
  console.log(`  ${label.padEnd(28)} ${response.ok ? 'funded by Friendbot (10,000 test XLM)' : `Friendbot answered ${response.status}; try again later`}`);
}

async function main() {
  const keys = existingKeys();
  const additions: Record<string, string> = {};
  const wallet = (secretName: string, publicName?: string) => {
    if (publicName ? keys.has(publicName) : keys.has(secretName)) return;
    const pair = Keypair.random();
    if (publicName) additions[publicName] = pair.publicKey();
    // Public-only wallets keep their secret too, so the demo accounts stay reachable. The server never uses it.
    additions[secretName] = pair.secret();
  };
  wallet('STELLAR_STUDENT_SECRET');
  wallet('STELLAR_SPONSOR_SECRET');
  wallet('STELLAR_MERCHANT_SECRET', 'STELLAR_MERCHANT_PUBLIC_KEY');
  wallet('STELLAR_SAVINGS_SECRET', 'STELLAR_SAVINGS_PUBLIC_KEY');
  wallet('STELLAR_EMERGENCY_SECRET', 'STELLAR_EMERGENCY_PUBLIC_KEY');
  if (!keys.has('SESSION_SECRET')) additions.SESSION_SECRET = randomBytes(32).toString('hex');

  if (Object.keys(additions).length) {
    const lines = Object.entries(additions).map(([key, value]) => `${key}=${value}`);
    appendFileSync(ENV_FILE, `\n# Added by npm run stellar:setup\n${lines.join('\n')}\n`);
    Object.assign(process.env, additions);
    console.log(`Wrote ${Object.keys(additions).join(', ')} to server/.env`);
  } else {
    console.log('server/.env already has every wallet and SESSION_SECRET.');
  }

  const config = loadConfig();
  const services = compose(config, { log: () => {} });
  const w = {
    student: services.student?.publicKey() as string,
    sponsor: services.sponsor?.publicKey() as string,
    merchant: config.stellar.merchantPublicKey,
    savings: config.stellar.savingsPublicKey,
    emergency: config.stellar.emergencyPublicKey,
  };

  console.log('\nTestnet wallets (recipients must exist before Paiflow can pay them)');
  await fund('Student (pays, = Spending)', w.student, services.horizon);
  await fund('Sponsor (funds Flow 2 and 3)', w.sponsor, services.horizon);
  await fund('Campus Canteen', w.merchant, services.horizon);
  await fund('Savings', w.savings, services.horizon);
  await fund('Emergency', w.emergency, services.horizon);

  const { catalog } = services;
  const legs = (list: { label: string; address: string | null; percent: number }[]) =>
    list.map((l) => `      ${String(l.percent).padStart(3)}% → ${l.label.padEnd(15)} ${l.address ?? '(missing)'}`).join('\n');
  console.log('\nBuild these in the Paiflow builder (input asset: XLM / native)');
  console.log(`  Flow 1, NFC checkout:     Receive → Split\n${legs(catalog.checkout.legs)}`);
  console.log(`  Flow 2, Smart allowance:  Receive → Condition amount > ${formatStroops(BigInt(catalog.allowance.thresholdStroops))} XLM`);
  console.log(`    TRUE  → Split\n${legs(catalog.allowance.whenAbove)}`);
  console.log(`    FALSE → Split\n${legs(catalog.allowance.otherwise)}`);
  console.log(`  Flow 3, Savings reward:   Webhook (HTTP callbacks on) → Pay ${formatStroops(BigInt(catalog.reward.amountStroops))} XLM → ${catalog.reward.recipient.address ?? '(missing)'}`);
  console.log('  Then add each flow\'s PAIFLOW_<FLOW>_ID and PAIFLOW_<FLOW>_TOKEN (and PAIFLOW_REWARD_WEBHOOK_SECRET) to server/.env');
  console.log('  yourself, and run npm run paiflow:check.');

  console.log('\nDeployments now');
  for (const s of await services.registry.statuses()) {
    console.log(`  ${s.flow.padEnd(10)} ${s.ready ? 'ready' : `not ready: ${s.problems.join(' ')}`}`);
  }
  console.log(`\nStudent wallet: ${EXPLORER}/account/${w.student}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Setup failed.');
  process.exitCode = 1;
});
