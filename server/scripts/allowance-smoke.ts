// npm run allowance:smoke [amountXlm]
// Executes a live allowance disbursement through Flow 2 on Paiflow.
import { compose } from '../src/compose.js';
import { loadConfig } from '../src/config.js';
import { decimalToStroops } from '../src/services/amounts.js';
import { attemptView } from '../src/services/attemptView.js';
import { isFinal } from '../src/services/depositExecutor.js';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const SMOKE_USER = 'smoke-allowance@hima.local';

async function main() {
  const config = loadConfig();
  const services = compose(config, { log: (msg) => console.log(`  [service] ${msg}`) });
  try {
  const status = await services.registry.status('allowance', { fresh: true });
  if (!status.ready) {
    console.error(`The allowance deployment isn't ready: ${status.problems.join(' ')}`);
    process.exitCode = 1;
    return;
  }
  const sponsor = services.sponsor;
  if (!sponsor) {
    console.error('STELLAR_SPONSOR_SECRET is not configured in server/.env');
    process.exitCode = 1;
    return;
  }

  const amountXlm = process.argv[2] ?? '20';
  const stroops = decimalToStroops(amountXlm);
  if (!stroops) {
    console.error('Invalid amount in XLM');
    process.exitCode = 1;
    return;
  }

  const stamp = Date.now();
  console.log(`Disbursing smart allowance of ${amountXlm} XLM through Paiflow (Flow 2)…`);
  const attempt = await services.executor.start({
    flow: 'allowance',
    userId: SMOKE_USER,
    idempotencyKey: `allowance-smoke-${stamp}`,
    signer: sponsor,
    amountStroops: stroops,
    reference: `ALW-${String(stamp).slice(-6)}`,
  });

  const view = attemptView(attempt);
  console.log(`  submitted ${view.assetAmount} ${view.assetCode}, tx ${view.txHash}`);

  let current = await services.attempts.get(attempt.id);
  const deadline = Date.now() + 90_000;
  while (current && !isFinal(current) && Date.now() < deadline) {
    await wait(2500);
    current = await services.executor.refresh(current);
  }
  if (!current) return;
  const final = attemptView(current);
  console.log(`  status: ${final.state}${final.ledger ? ` (ledger ${final.ledger})` : ''}${final.failure ? `: ${final.failure.reason} [${final.failure.code}]` : ''}`);
  if (final.explorerUrl) console.log(`  ${final.explorerUrl}`);

  if (final.status === 'confirmed' && final.txHash) {
    for (let i = 0; i < 8; i++) {
      const events = await services.registry.client('allowance').events(final.txHash).catch(() => []);
      if (events.length) {
        console.log('  flow events:');
        for (const e of events) console.log(`    ${e.kind}${e.topic ? ` (${e.topic})` : ''} ${JSON.stringify(e.data)}`);
        return;
      }
      await wait(5000);
    }
    console.log('  no flow events recorded yet; check the explorer link.');
  } else {
    process.exitCode = final.status === 'pending' ? 2 : 1;
  }
  } finally {
    await services.attempts.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : 'Allowance smoke test failed.');
  process.exitCode = 1;
});
