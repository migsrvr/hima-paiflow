// npm run paiflow:check
// Read-only readiness report for Hima's three Paiflow deployments: trigger, input asset,
// supported operations, balances and funding nodes. Never prints tokens or secrets.
import { compose } from '../src/compose.js';
import { loadConfig } from '../src/config.js';
import { PaiflowError } from '../src/integrations/paiflow/errors.js';
import { FLOW_NAMES } from '../src/integrations/paiflow/types.js';
import { formatStroops } from '../src/services/amounts.js';

const why = (error: unknown) => (error instanceof PaiflowError ? `${error.code}${error.httpStatus ? ` (${error.httpStatus})` : ''}` : 'error');

async function main() {
  const config = loadConfig();
  const { registry } = compose(config, { log: () => {} });
  for (const warning of config.warnings) console.log(`[config] ${warning}`);

  let allReady = true;
  for (const flow of FLOW_NAMES) {
    const s = await registry.status(flow, { fresh: true });
    allReady &&= s.ready;
    console.log(`\n${s.label} (${flow})`);
    console.log(`  deployment   ${s.deploymentId ?? '—'}`);
    console.log(`  status       ${s.ready ? 'READY' : 'NOT READY'}`);
    for (const problem of s.problems) console.log(`  problem      ${problem}`);
    if (s.triggerType) console.log(`  trigger      ${s.triggerType} (Hima expects ${s.expectedTrigger})`);
    if (!s.configured) continue;

    const client = registry.client(flow);
    try {
      const b = await client.balances();
      const totals = b.totals.map((t) => `${t.balanceStroops === null ? 'unreadable' : formatStroops(BigInt(t.balanceStroops))} (${t.tokenContract.slice(0, 6)}…)`);
      console.log(`  balances     ${totals.join(', ') || 'none'}${b.totalsComplete ? '' : ' (incomplete)'} [${b.freshness}]`);
    } catch (error) {
      console.log(`  balances     unavailable: ${why(error)}`);
    }
    if (s.expectedTrigger === 'webhook') {
      try {
        const nodes = await client.discoverFunding();
        console.log(`  funding      ${nodes.map((n) => `${n.nodeId} (${n.action})`).join(', ') || 'no fundable nodes'}`);
      } catch (error) {
        console.log(`  funding      unavailable: ${why(error)}`);
      }
    }
  }
  console.log(allReady ? '\nAll three flows are ready.' : '\nSome flows are not ready yet.');
  process.exitCode = allReady ? 0 : 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Check failed.');
  process.exitCode = 1;
});
