# Hima: Stellar Testnet (XLM / Paiflow) & Freighter Integration Spec

> **Target Agent**: Claude Code  
> **Project Root**: `/mnt/c/Users/Miggy/Documents/Paiflow`  
> **Status**: Mobile app (`mobile/`) is 100% running on Android physical device with verified Kimi AI chat, native NFC card detection, and in-app PIN authorization.  
> **Current Objective**: Implement on-chain Stellar Testnet (XLM / Paiflow) settlement, Freighter wallet configuration, and PHP-to-XLM dual currency display.

---

## 1. Project Credentials & Environment Configurations

Keep these credentials intact across `server/` and `mobile/`:

### Kimi AI API
* **API Key**: stored only in `server/.env` as `KIMI_API_KEY`. It was removed from this file; rotate it, because it was shared here in plain text.
* **Endpoint**: `https://api.kimi.com/coding/v1/chat/completions`
* **Active Model**: `kimi-k1.5` (or `kimi-latest`)
* **Environment File**: `server/.env` (`KIMI_API_KEY=…`; never in source, docs or `EXPO_PUBLIC_*`)
* *Note: Do NOT use standard Moonshot endpoints (`api.moonshot.cn`), only `https://api.kimi.com/coding/v1/chat/completions` works with this coding key.*

### Hardware NFC & Physical Card
* **User's Physical Uni ID Card**: `22:E9:4A:7A` (Normalized: `22E94A7A`)
* **Preserved Demo Tag**: `04A1B2C34F2A` (Do NOT remove; both resolve to `Campus Canteen`)
* **Location in Code**: `mobile/services/payments/merchants.ts`
* **Receipt Display Mask**: `•••• 4A7A`

### In-App Authorization PIN & Security
* **Default In-App PIN**: `1234`
* **Fallback Behavior**: If native biometric / fingerprint prompt is cancelled or unavailable, gracefully switches to the 4-digit PIN pad (`● ● ○ ○`) with the **"Quick approve (1234)"** button.

### Expo & EAS Configuration
* **EAS Owner Account**: `migsrvr`
* **EAS Project**: `@migsrvr/hima`
* **EAS Project ID**: `63f64b2f-9f78-4627-9b0f-7bf370191617`
* **EAS Profiles** (`mobile/eas.json`): Both `preview` and `development` output installable `.apk` builds.

### Host Network Diagnostics
* **Native Windows Host IP**: `192.168.1.38`
* **Backend Port**: `3001` (`http://192.168.1.38:3001`)
* **Metro Port**: `8081` (`http://192.168.1.38:8081`)
* **Windows Launcher Script**: `mobile/scripts/start-windows.cjs` (triggered via `npm run start:windows -- 192.168.1.38`)

---

## 2. Stellar Testnet & Paiflow Architecture

### What is Paiflow & How Freighter Fits In:
* **Paiflow (`https://paiflow.xyz`)**: A visual workflow automation builder by Artisam Labs on the Stellar/Soroban ecosystem.
* **Freighter Wallet**: The official Stellar self-custody browser extension.
  * Used on the **Paiflow Web Builder (`paiflow.xyz`)** on PC to connect, deploy smart contracts, and fund testnet sandbox sessions.
  * In the **Hima Mobile App**, users do **not** run the browser extension. Instead, Hima manages a native Stellar Testnet keypair (`GB...`) and allows the student to inspect or link their Freighter public key (`G...`) in `Profile → Wallet`.

### Stellar Testnet Endpoints:
* **Horizon Server**: `https://horizon-testnet.stellar.org`
* **Friendbot (Free Faucet)**: `https://friendbot.stellar.org/?addr={PUBLIC_KEY}` (credits 10,000 test XLM)
* **Block Explorer**: `https://stellar.expert/explorer/testnet/tx/{TX_HASH}`
* **Passphrase**: `Test SDF Network ; September 2015`

### Currency & Budget Equivalence Model:
* **Student Mindset (PHP / ₱)**: All budgeting logic (Safe-to-Spend, Weekly/Daily allowance, meal prices, category caps) stays in **Philippine Pesos (₱)** to adhere 100% to the approved Hima UI design.
* **On-Chain Settlement (XLM / Testnet)**:
  * **Configurable Conversion Rate**: `1 XLM ≈ ₱7.50` (or `1 test unit ≈ ₱58.00` if treating as dollar/USDC parity).
  * Example Meal: `₱85.00` Campus Canteen meal settles on Stellar Testnet as `11.3333333 XLM`.
  * Example Allowance: `₱1,500.00` / week = `200.00 XLM`.

---

## 3. Implementation Plan for Claude Code

### Step 1: Install `@stellar/stellar-sdk` in `server/`

In `server/package.json`, add `@stellar/stellar-sdk`:
```bash
cd server
npm install @stellar/stellar-sdk
```

Create `server/src/services/stellarService.ts`:
```typescript
import { Horizon, Keypair, Operation, Asset, Networks, TransactionBuilder } from '@stellar/stellar-sdk';

const HORIZON_URL = 'https://horizon-testnet.stellar.org';
const server = new Horizon.Server(HORIZON_URL);

// Conversion Rate: 1 XLM = 7.50 PHP (configurable)
export const PHP_PER_XLM = 7.50;

export function phpToXlm(php: number): number {
  return Number((php / PHP_PER_XLM).toFixed(7));
}

// Fixed or generated demo keypairs
// Student Account
export const STUDENT_KEYPAIR = Keypair.fromSecret(
  process.env.STELLAR_STUDENT_SECRET || 'SDJ...<generate or store in server/.env>'
);

// Campus Canteen Merchant Account
export const MERCHANT_KEYPAIR = Keypair.fromSecret(
  process.env.STELLAR_MERCHANT_SECRET || 'SC...<generate or store in server/.env>'
);

export async function ensureFunded(publicKey: string): Promise<boolean> {
  try {
    await server.loadAccount(publicKey);
    return true;
  } catch {
    // Fund with Friendbot
    const res = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`);
    return res.ok;
  }
}

export async function submitStellarPayment(amountPhp: number, memoText: string = 'Hima NFC Payment') {
  const xlmAmount = phpToXlm(amountPhp).toFixed(7);
  const sourceKeypair = STUDENT_KEYPAIR;
  const destinationPublicKey = MERCHANT_KEYPAIR.publicKey();

  await ensureFunded(sourceKeypair.publicKey());
  await ensureFunded(destinationPublicKey);

  const sourceAccount = await server.loadAccount(sourceKeypair.publicKey());
  
  const tx = new TransactionBuilder(sourceAccount, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: destinationPublicKey,
        asset: Asset.native(),
        amount: xlmAmount,
      })
    )
    .addMemo({ type: 'text', value: memoText.slice(0, 28) })
    .setTimeout(30)
    .build();

  tx.sign(sourceKeypair);

  const response = await server.submitTransaction(tx);
  return {
    txHash: response.hash,
    ledger: response.ledger,
    xlmAmount: Number(xlmAmount),
    amountPhp,
    explorerUrl: `https://stellar.expert/explorer/testnet/tx/${response.hash}`,
  };
}

export async function getStellarBalance(publicKey: string = STUDENT_KEYPAIR.publicKey()) {
  try {
    const acc = await server.loadAccount(publicKey);
    const nativeBal = acc.balances.find((b) => b.asset_type === 'native');
    const xlm = nativeBal ? parseFloat(nativeBal.balance) : 0;
    return {
      publicKey,
      xlm,
      phpEquivalent: xlm * PHP_PER_XLM,
    };
  } catch (err) {
    return {
      publicKey,
      xlm: 10000,
      phpEquivalent: 75000,
    };
  }
}
```

Add endpoints in `server/src/server.ts`:
* `GET /wallet/stellar` → returns `{ publicKey, xlm, phpEquivalent }`
* `POST /payments/submit-stellar` → takes `{ amount: number, merchantId: string }`, runs `submitStellarPayment`, and returns `{ txHash, xlmAmount, explorerUrl }`.

---

### Step 2: Currency Utilities in `mobile/`

Create `mobile/utils/currency.ts`:
```typescript
export const PHP_PER_XLM = 7.50;

export function phpToXlm(php: number): number {
  return Number((php / PHP_PER_XLM).toFixed(2));
}

export function xlmToPhp(xlm: number): number {
  return Number((xlm * PHP_PER_XLM).toFixed(2));
}

export function formatXlm(xlm: number): string {
  return `${xlm.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} XLM`;
}

export function formatDual(php: number): string {
  const xlm = phpToXlm(php);
  return `₱${php.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · ${formatXlm(xlm)}`;
}
```

---

### Step 3: Update Network & Explorer URLs in `mobile/`

In `mobile/services/mock/config.ts`:
```typescript
export const DEMO_SEED_ACTIVITY = true;
export const EXPLORER_TX_URL = 'https://stellar.expert/explorer/testnet/tx/';
export const NETWORK_NAME = 'Stellar Testnet (Paiflow)';
```

In `mobile/services/payments/processor.ts`:
* Wire `paymentProcessor.submit()` to call `POST /payments/submit-stellar` on `EXPO_PUBLIC_API_URL` (or fallback to simulated 64-character hash if offline).
* Ensure `explorerUrl(txHash)` generates:
  `https://stellar.expert/explorer/testnet/tx/${txHash}`.

---

### Step 4: UI Updates (Dual Currency & Profile)

1. **`mobile/components/finance/WalletBalanceCard.tsx`**:
   * Underneath the Peso balance, show the XLM equivalent:
     ```tsx
     <Text style={styles.subtext}>{`≈ ${formatXlm(phpToXlm(balance))}`}</Text>
     ```
2. **`mobile/app/(tabs)/profile.tsx`**:
   * In the `WALLET` section:
     - Set label: `Stellar / Paiflow wallet`.
     - Display the Stellar public key (`G...`).
     - Provide an option to view on [Stellar.Expert](https://stellar.expert/explorer/testnet).
     - Allow the user to paste their own **Freighter Testnet public address** to synchronize balances.
3. **`mobile/components/payment/ResultView.tsx` (14a Success Receipt)**:
   * Display both currencies: `₱85.00 (11.33 XLM)`.
   * Display `Network: Stellar Testnet (Paiflow)`.
   * Tapping **View on explorer** opens the live `stellar.expert` transaction receipt in the phone's browser.
4. **`mobile/services/ai.ts` & `server/src/services/kimiService.ts`**:
   * Ground Kimi AI with the Stellar wallet details so when asked about XLM or crypto allowance, it answers using exact converted figures.

---

## 4. Verification & Testing

1. **Server Unit Tests**:
   ```bash
   cd server && npm test
   ```
2. **Mobile Unit Tests & Typecheck**:
   ```bash
   cd mobile && npm test
   npx tsc --noEmit
   ```
3. **End-to-End Demo Verification**:
   * Run server: `cd server && npm run dev`
   * Run mobile on Windows: `cd mobile && npm run start:windows -- 192.168.1.38`
   * Tap physical Uni ID (`22:E9:4A:7A`).
   * Checkout shows `₱85.00 (≈ 11.33 XLM)`.
   * Authorize with PIN `1234`.
   * Click **View on explorer** on the success receipt and verify that the on-chain transaction loads on `stellar.expert`.
