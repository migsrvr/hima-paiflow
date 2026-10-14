import { Horizon, TransactionBuilder, Asset, Networks, Operation } from '@stellar/stellar-sdk';

const server = new Horizon.Server('https://horizon-testnet.stellar.org');
const recipient = 'GBIRFIVLH6OJXRL7ZTFEYL66NZAGAVEAFGAGRSXB6625QZXAWDFFWGEY';

async function main() {
  const account = await server.loadAccount(recipient);
  const usdc = new Asset('USDC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
  const tx = new TransactionBuilder(account, { fee: '10000', networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset: usdc }))
    .setTimeout(0)
    .build();
  const xdr = tx.toXDR();
  console.log('Unsigned XDR:\n', xdr);
  console.log('\nStellar Laboratory 1-Click Link:');
  console.log(`https://laboratory.stellar.org/#txsigner?xdr=${encodeURIComponent(xdr)}&network=test`);
}

main().catch(console.error);
