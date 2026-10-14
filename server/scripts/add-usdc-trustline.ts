import { Horizon, Keypair, Operation, Asset, Networks, TransactionBuilder } from '@stellar/stellar-sdk';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
const server = new Horizon.Server(config.stellar.horizonUrl);
const student = Keypair.fromSecret(config.stellar.studentSecret);
const canteenSecret = process.env.STELLAR_MERCHANT_SECRET;
const usdc = new Asset('USDC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');

async function addTrustline(keypair: Keypair, label: string) {
  const account = await server.loadAccount(keypair.publicKey());
  const hasTrustline = account.balances.some(
    (b) => b.asset_type === 'credit_alphanum4' && b.asset_code === 'USDC'
  );
  if (hasTrustline) {
    console.log(`[trustline] ${label} already has USDC trustline.`);
    return;
  }
  console.log(`[trustline] Adding USDC trustline for ${label} (${keypair.publicKey()})...`);
  const tx = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.changeTrust({ asset: usdc }))
    .setTimeout(30)
    .build();

  tx.sign(keypair);
  const res = await server.submitTransaction(tx);
  console.log(`[trustline] ${label} USDC trustline established! Tx: ${res.hash}`);
}

async function fundUsdc(source: Keypair) {
  const account = await server.loadAccount(source.publicKey());
  const usdcBal = account.balances.find((b) => b.asset_type === 'credit_alphanum4' && b.asset_code === 'USDC')?.balance ?? '0';
  console.log(`[balance] Current USDC balance: ${usdcBal}`);
  if (parseFloat(usdcBal) >= 50) {
    console.log('[balance] Sufficient USDC balance already available.');
    return;
  }

  console.log('[swap] Swapping 50 XLM for testnet USDC via DEX path payment...');
  try {
    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.pathPaymentStrictSend({
          sendAsset: Asset.native(),
          sendAmount: '50',
          destination: source.publicKey(),
          destAsset: usdc,
          destMin: '0.01',
        })
      )
      .setTimeout(30)
      .build();

    tx.sign(source);
    const res = await server.submitTransaction(tx);
    console.log(`[swap] Path payment succeeded! Tx: ${res.hash}`);
  } catch (err: any) {
    console.log(`[swap] DEX swap did not fill (${err?.response?.data?.extras?.result_codes?.operations || err.message}).`);
    console.log('[swap] Note: On Stellar Testnet, Friendbot only mints native XLM.');
  }
}

async function main() {
  console.log('--- Setting up USDC Trustlines on Stellar Testnet ---');
  await addTrustline(student, 'Hima Student Wallet');
  if (canteenSecret) {
    const canteen = Keypair.fromSecret(canteenSecret);
    await addTrustline(canteen, 'Campus Canteen Merchant');
  }
  await fundUsdc(student);
  console.log('--- Done ---');
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exitCode = 1;
});
