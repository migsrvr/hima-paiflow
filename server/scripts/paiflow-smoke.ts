// npm run paiflow:smoke [amountPhp]
// One live checkout through the Flow 1 deployment, using the same services the app uses.
// Prints the outcome, the explorer link and the flow's events.
import { compose } from '../src/compose.js';
import { loadConfig } from '../src/config.js';
import { MemoryAttemptStore } from '../src/services/attemptStore.js';
import { attemptView } from '../src/services/attemptView.js';
import { isFinal } from '../src/services/depositExecutor.js';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const SMOKE_USER = 'smoke-test@hima.local';

async function main() {
  const config = loadConfig();
  const services = compose(config, { attempts: new MemoryAttemptStore(), log: (message: string) => console.log(`  [service] ${message}`) });
  const status = await services.registry.status('checkout', { fresh: true });
  if (!status.ready) {
    console.error(`The checkout deployment isn't ready: ${status.problems.join(' ')}`);
    process.exitCode = 1;
    return;
  }

  const amount = Number(process.argv[2] ?? 85);
  const stamp = Date.now();
  console.log(`Paying ₱${amount.toFixed(2)} to Campus Canteen through Paiflow…`);
  const view = await services.checkout.pay(SMOKE_USER, {
    paymentId: `smoke-${stamp}`, merchantId: 'campus-canteen', amount, reference: `HM-SMOKE-${String(stamp).slice(-6)}`,
  });
  console.log(`  submitted ${view.assetAmount} ${view.assetCode}, tx ${view.txHash}`);

  let attempt = services.attempts.get(view.id);
  const deadline = Date.now() + 90_000;
  while (attempt && !isFinal(attempt) && Date.now() < deadline) {
    await wait(2500);
    attempt = await services.executor.refresh(attempt);
  }
  if (!attempt) return;
  const final = attemptView(attempt);
  console.log(`  status: ${final.state}${final.ledger ? ` (ledger ${final.ledger})` : ''}${final.failure ? `: ${final.failure.reason} [${final.failure.code}]` : ''}`);
  if (final.explorerUrl) console.log(`  ${final.explorerUrl}`);

  if (final.status === 'confirmed' && final.txHash) {
    // Paiflow records events 10–20 s after the ledger closes.
    for (let i = 0; i < 8; i++) {
      const events = await services.registry.client('checkout').events(final.txHash).catch(() => []);
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
}

main().catch((error) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : 'Smoke test failed.');
  process.exitCode = 1;
});
