// npm run wallet:topup
// Refills the testnet paying wallet: Friendbot funds a throwaway account, which is merged into the
// wallet. The server does the same automatically when the balance drops below DEMO_TOPUP_BELOW_XLM.
// Prints public keys and the transaction hash only.
import { compose } from '../src/compose.js';
import { loadConfig } from '../src/config.js';
import { formatStroops } from '../src/services/amounts.js';

async function main() {
  const config = loadConfig();
  const { topUp, student } = compose(config, { log: console.log });
  if (!topUp || !student) throw new Error('STELLAR_STUDENT_SECRET is unset. Run npm run stellar:setup first.');
  const show = (stroops: bigint | null) => (stroops === null ? 'unreadable' : `${formatStroops(stroops)} XLM`);

  console.log(`Wallet   ${student.publicKey()}`);
  console.log(`Before   ${show(await topUp.balance())}`);
  const result = await topUp.topUp();
  if (result.status === 'topped_up') console.log(`Merge tx https://stellar.expert/explorer/testnet/tx/${result.txHash}`);
  console.log(`After    ${show(await topUp.balance())}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Top-up failed.');
  process.exitCode = 1;
});
