x # Hima × Paiflow: progress handoff

The approved plan is in `C:\Users\Miggy\.claude\plans\prancy-beaming-muffin.md`. This file records where that plan stands: what is built, what is unfinished, and what to do next.

## Decisions (agreed with the user)
| Topic | Decision |
|---|---|
| Payment rail | The user's live **Paiflow deployment** `d3496d67-891b-46c8-bedb-55fe0bef5f0f`, a deposit-triggered **Receive** (`CAKRU64K24K4RDHU2VVPDL4CCGEQCV5SQE3AEPM63WTSQWHIABHPREGQ`) → **Split** flow. There is no direct Horizon transfer. |
| Flow action | Split pays **100% to Campus Canteen**. The deposit and payout happen in **one transaction**, so one tx hash is the whole payment. |
| "Confirmed" | Only when Paiflow (or Horizon after expiry) reports SUCCESS. The app shows Pending after 60 s without an answer. |
| Home wallet balance | Stays Hima's **₱ ledger**. The on-chain XLM balance appears only in Profile → Wallet. |
| XLM display | Home hero "≈ 344.00 XLM", checkout "≈ 11.33 XLM", receipt "Settled 11.3333333 XLM", plus Profile. These are noted as design deviations. |
| Rate | Fixed demo rate `PHP_PER_INPUT_UNIT=7.50` (₱ per XLM), set on the server only. Conversion uses integer centavos→stroops math. |
| Freighter | Read-only link. The user pastes a G… address, the server validates it, and the app shows its testnet balance. |
| Labels | Network: "Stellar Testnet (Paiflow)". Profile: "Stellar / Paiflow wallet". |
| Mock processor | Used only with `EXPO_PUBLIC_PAYMENTS=mock` (web preview). It is never a fallback. |

Paiflow API facts come from the public spec `https://beta.app.paiflow.xyz/api/v1/openapi.json`:
- All responses are wrapped as `{data}`.
- `POST /deployments/{id}/execute {from, amount(stroops string)}` returns `{xdr, networkPassphrase, network, expiresAt}`. The envelope is valid for 180 s.
- `POST …/execute/submit?wait=false {signedXdr}` returns `SUCCESS|PENDING|FAILED`. It is idempotent on the envelope hash, so resubmitting is also how to check status. An envelope that expired before it was sent comes back `FAILED txTooLate`.
- `GET …/transactions/{hash}` returns `SUCCESS|FAILED|PENDING|UNKNOWN|REJECTED`, or 404 if Paiflow has no record of that hash.
- `GET …/capabilities` reports `inputAsset`. `GET …/events?txHash=` lists the flow's events.
- Auth is `Bearer pfk_<64 hex>`.

---

## Batch A: server (`server/`): DONE
**Checks:** 33/33 tests pass; `npm run typecheck` and `npm run build` are OK.

**New files:**
- `src/services/amounts.ts`: integer centavos↔stroops conversion (₱85 → `11.3333333`).
- `src/services/paiflowClient.ts`: a typed client with injectable fetch. It maps errors, reads Retry-After, and returns `null` for a 404 status.
- `src/services/horizonClient.ts`: account balances and transaction lookups (read-only).
- `src/services/paymentStore.ts`: an in-memory map that writes through to `data/payments.json` (gitignored).
- `src/services/paymentService.ts`:
  - `create()` is idempotent per `paymentId` and single-flight.
  - It **verifies the envelope before signing**: one `deposit` call on the trigger contract, the exact amount, source = Hima wallet, testnet only, fee ≤ 10 XLM, expiry ≤ 10 min.
  - It **saves the signed envelope before submitting**.
  - `status()` maps the outcome:
    - SUCCESS → confirmed
    - FAILED or REJECTED → failed (not charged)
    - PENDING → pending
    - UNKNOWN, or no Paiflow record → resubmit the same envelope; after expiry + 30 s, ask Horizon (404 means failed with code EXPIRED)
  - Status reads are throttled to one per 2 s.
  - `wallet()` never invents a balance: it returns `balance:null` plus `balanceError`.
  - `lookupAccount()` serves the Freighter lookup.
- `src/routes/payments.ts`: `POST /payments`, `GET /payments/:paymentId`.
- `src/routes/wallet.ts`: `GET /wallet/stellar`, `GET /wallet/stellar/accounts/:address`.
- `scripts/stellar-setup.ts` (`npm run stellar:setup`): creates and funds the accounts with Friendbot, writes them to `.env`, and prints capabilities.
- `scripts/paiflow-smoke.ts` (`npm run paiflow:smoke [amount]`): makes one live payment and prints the explorer link and events.
- Tests: `tests/amounts.test.ts`, `paiflowClient.test.ts`, `paymentService.test.ts`, and an extended `app.test.ts`.

**Changed files:**
- `config.ts`: new env vars.
- `app.ts`: `/health` now includes `payments`; added `PaymentServiceError` handling.
- `server.ts`: logs which settings are missing.
- `package.json`: engines ≥22.12; added `@stellar/stellar-sdk@^17.2.1`; new scripts `typecheck`, `stellar:setup`, `paiflow:smoke`.
- `tsconfig.check.json`, `.gitignore` (`data/`), `.env.example`, `README.md` (Payments section).

**Live state:**
- `stellar:setup` ran and both accounts are funded with 10,000 test XLM:
  - Hima wallet (pays): `GB23VZX5GSWBAOJ6H7L27JDWP3UXIFD2WB5MTKUS6DMNMTXGCZD6KU7E`
  - Campus Canteen (receives): `GABKWTD3MBOECRLCAWBRHSIYYCFXS2BIHASGIUZXZWLGDWADNO4H2X3O`
- `server/.env` now holds the Stellar keys, deployment id and trigger contract. **`PAIFLOW_API_TOKEN` is still missing.**
- Probed live on port 3101:
  - `/wallet/stellar` returns the real 10,000 XLM balance.
  - The Freighter lookup works.
  - `POST /payments` returns 503 `PAYMENTS_NOT_CONFIGURED` until the token is added.

**Notes and gotchas:**
- stellar-sdk v17 API differences:
  - `op.func.type === 'hostFunctionTypeInvokeContract'`
  - `op.func.invokeContract.{contractAddress,functionName,args}` (properties, not methods)
  - `tx.hash()` returns a `Uint8Array`
  - signatures are `{hint, signature}`
- An **old Hima server inside WSL** (`wslrelay.exe`) holds `127.0.0.1:3001`. The new server binds `0.0.0.0:3001`, but localhost on the PC reaches the old one. Stop the WSL server, or test on another `PORT`.
- The Kimi key was removed from `STELLAR_PAIFLOW_IMPLEMENTATION.md`. It now lives only in `server/.env`. **Rotate it.**

---

## Batch B: mobile plumbing (`mobile/`): DONE (logic + tests)
**Checks:** 14 new jest tests pass (`utils/__tests__/asset.test.ts`, `services/payments/__tests__/processor.test.ts`). The full suite and `tsc` have not been re-run yet.

**New files:**
- `services/api.ts`: `API_URL` (`EXPO_PUBLIC_API_URL`, falling back to 10.0.2.2/localhost:3001), `apiFetch`, and `ApiError` (`kind: 'unreachable' | 'http'`).
- `services/payments/network.ts`: `NETWORK_NAME`, plus `explorerTxUrl`, `explorerAccountUrl` and `explorerContractUrl` for stellar.expert testnet.
- `services/payments/accounts.ts`: `lookupStellarAccount`, `looksLikeStellarAddress`, `shortAccount` (6+4 characters).
- `utils/asset.ts`: `toStroops`, `parseStroops`, `parseRateCentavos`, `formatAsset` (2 dp, or `exact` for 7 dp, `approx` for "≈ "), `formatStroopsDecimal`, `approxAsset`, `exactAsset`. It uses BigInt.
- `hooks/useChainSync.ts`: on focus, `refreshChain()` and `reconcilePending(activeSessionId)`, throttled to once per 15 s.

**Rewritten files:**
- `services/payments/processor.ts`: a `PaymentProcessor` interface.
  - `createPaiflowProcessor({fetchImpl, sleep, now})` POSTs `/payments`, then polls `GET /payments/:id` at 2,2,3,4,5,6 s until 60 s pass, then reports pending.
  - If submit fails, it looks up the status: 404 means failed with the server's reason; unreachable means pending.
  - `mockProcessor` stays (with the `hima.dev.payment` overrides). `PAYMENTS_MODE` selects between them. `shortHash` handles Stellar hashes ("94be…278d").
- `stores/payment.ts`: sends paymentId, merchantId, amount and reference. It stores `assetAmount`, `assetCode` and `ledger`, and uses the real failure reason.
- `stores/wallet.ts`:
  - Removed the fake address. Added `chain: ChainWallet|null` (persisted) and `connection: 'checking'|'connected'|'notSetUp'|'offline'`.
  - Added `refreshChain()` and `reconcilePending(skipId)`.
  - `markSubmitted` and `markConfirmed` accept asset and ledger details.
  - Persist v2 migration drops `address` and the fake demo hashes.
- `hooks/useBudget.ts`: `address` is replaced by `chain`.
- `types/finance.ts`: `Transaction` gains `assetAmount`, `assetCode` and `ledger`.
- `services/mock/config.ts`: now only `DEMO_SEED_ACTIVITY`.
- `services/mock/demoData.ts`: the seeded week no longer has hashes, and `DEMO_WALLET_ADDRESS` is removed.

---

## Batch C: mobile UI: PARTLY DONE
**Done:**
- `components/finance/SafeToSpendCard.tsx`: `walletAssetPreview` line (white, Inter 500 12, tabular).
- `app/(tabs)/home.tsx`: `useChainSync()` plus `approxAsset(walletBalance, chain)`.
- `components/payment/CheckoutView.tsx`: `assetPreview` line under the amount (blueText, Inter 600 13). `app/payment/checkout.tsx` passes it in.
- `app/payment/result.tsx`: "Settled" row (exact asset amount), `NETWORK_NAME` from `network.ts`, and the real failure reason.
- `components/payment/ResultView.tsx`: removed "in time" from the 14c failure message, because failures now include refusals.
- `components/payment/AuthorizeSheet.tsx`: a typed PIN must equal `DEMO_PIN` (1234), and a wrong one shows "Wrong PIN. Try again." and clears. Quick approve is kept. Keys and dots now have a11y labels.
- `services/biometric.ts`: exports `DEMO_PIN` and `isDemoPin`.
- `components/ui/HimaBottomSheet.tsx`: optional `avoidKeyboard` prop (keyboard-controller `KeyboardAvoidingView`).
- `components/ui/icons.ts`: added `KeyRound`.
- `stores/settings.ts`: `freighter: FreighterLink|null` and `setFreighter`.
- New `components/finance/StellarWalletSheet.tsx`: full key with copy, balance, demo rate, deployment, network, Stellar.Expert, and Paiflow contract link.
- New `components/finance/FreighterLinkSheet.tsx`: paste, validate on the server, save, update or remove.

**Still to do:**
1. **`app/(tabs)/profile.tsx`** (currently fails `tsc`, because it still uses `address` and the old `NETWORK_NAME` import). Changes needed:
   - Import `NETWORK_NAME` from `@/services/payments/network`.
   - Wallet row: label "Stellar / Paiflow wallet", detail `shortAccount(chain.publicKey)` (or "Checking…"/"Not connected"), and `onPress` opens `StellarWalletSheet`.
   - New row "Freighter (testnet)" with the `KeyRound` icon, detail = short address · `freighterBalanceLabel` or "Not linked", opening `FreighterLinkSheet`.
   - The Connection badge follows `useWalletStore(s => s.connection)`. Each state is icon + label + color:

     | State | Badge |
     |---|---|
     | connected | synced "Connected" (Check) |
     | checking | pending "Checking…" |
     | offline | pending "Offline" (CloudOff) |
     | notSetUp | overPlan "Not set up" |

   - Call `useChainSync()`, and refresh the linked Freighter balance on focus.
2. **`app/dev/payment.tsx`** (currently fails `tsc`): import `NETWORK_NAME` from `network.ts`, and add a Settled row to the 14a preview.
3. Run `npx tsc --noEmit`, `npx expo lint`, `npx jest`, and `npx expo export --platform android` (this confirms BigInt works in the bundle).
4. Take web screenshots of 07 Home, 12a, 14a, 13a PIN and 15 Profile and compare them with `design/screens/*.html`, using the scratchpad `shots-tool`. List the deviations.

## Batch D: AI grounding: NOT STARTED
- `mobile/services/ai.ts`:
  - Use `API_URL` from `services/api.ts`.
  - Add `walletBalanceXlm`, `safeToSpendXlm` and `phpPerXlm` to the Kimi context, computed with `approxAsset`/`toStroops` from `chain`.
  - Add a deterministic "how much XLM" intent to `answerFor`.
- `server/src/services/kimiService.ts`:
  - Add to the prompt that XLM figures are supplied testnet equivalents and that the model must never convert currencies.
  - Have `contextFigures` add XLM rows.
- Add tests on both sides.

## Verification still to do
- **Live:** once the user adds the token, run `npm run stellar:setup` again (it checks `inputAsset`; if that isn't native XLM, stop and ask), then `npm run paiflow:smoke`. Confirm the transaction invokes `CAKRU6…` and credits the canteen. The envelope's amount-argument check has only been tested against locally built envelopes, so this is its first real test.
- **Web end-to-end:** start the server with `PORT=3101 CORS_ORIGINS=http://localhost:8081`, and Expo web with `EXPO_PUBLIC_API_URL=http://127.0.0.1:3101`. Then:
  - Pay ₱85 and check the wallet goes from 2,580 to 2,495, with a real hash and the Settled row.
  - Stop the server mid-payment and check the payment shows Pending, then that Check status resolves it with no mascot.
  - Without a token, a local fake-Paiflow stub can stand in, as long as it is labelled simulated.
- **Device (user):** `npm run start:windows -- 192.168.1.38`, tap the ID, checkout shows ₱85.00 ≈ 11.33 XLM, enter PIN 1234, check the receipt, and use View on explorer. No new native modules were added, so the existing dev APK still works.

## User to-dos
1. Add `PAIFLOW_API_TOKEN=pfk_…` to `server/.env` yourself, not in chat. Paiflow shows a token only once; if it's lost, create a new one.
2. In Paiflow, set the Split node to send 100% to the canteen address `GABKWTD3MBOECRLCAWBRHSIYYCFXS2BIHASGIUZXZWLGDWADNO4H2X3O`, and redeploy if asked. A redeploy changes the deployment id, which must then be updated in `.env`.
3. Rotate the Kimi API key.
4. Stop the old WSL Hima server on port 3001.

## Hosted downloadable demo implementation — 15 October 2026

User decisions: small demo tester group, free hosting only, accept occasional wake-up delay, build APKs on the Windows PC and upload them manually. Hosting remains Render Free + Supabase Free; no paid services or production-auth changes are authorized.

- Server: async file/PostgreSQL payment stores, atomic idempotency claims, session advisory locks, autocommitted signed-envelope storage before submission, restart recovery and changed-deployment protection. Public `/ready` checks storage; hosted configuration requires PostgreSQL and a stable session secret. Database errors never fall back to temporary files.
- Added transactional schema migration and all-or-nothing import of the existing JSON records. Exact reimports skip; any identity/content conflict aborts. Existing local `.env` and attempt records were preserved. Example credentials were blanked. Live smoke scripts now use the configured durable store and close it in `finally`; they were not executed.
- Root `render.yaml` defines a single Free Node 22 service, server build/start commands, readiness health check, and private environment prompts. Automatic deploys are off. No account resources have been created.
- Mobile: shared bounded `/ready` probes on launch/foreground and before API operations, accessible nonblocking connecting/unavailable Retry banner, immediate local demo login, and serialized session persistence. Requests and polling remain bound to the initiating account across wake delays, lost responses and renewal. Readiness never replays payment POSTs; unknown payment outcomes remain pending.
- Windows `npm.cmd run apk:windows` produces a versioned APK, SHA-256 file and public release metadata without a connected phone. Hosted builds require a public HTTPS origin, preserve the demo signing key, increment version codes, track the API URL as a Gradle bundle input, and inspect the packaged bundle/policy/version before exporting. Local USB builds remain available.
- Added deployment, migration, backup, distribution and update instructions in [docs/HOSTED_DEMO.md](docs/HOSTED_DEMO.md). The existing nested mobile Git arrangement was preserved.

Verification: server build/typecheck passed; server tests 73 passed and one real-PostgreSQL integration test explicitly skipped without a test database. Mobile full Jest run passed all 18 suites/107 tests; final affected API/payment and session persistence tests also run after review fixes. Six APK/configuration checks passed, including exact-host HTTP XML, signing preservation, version increments and stale-bundle rejection. Mobile typecheck/lint passed using a Linux resolver binding isolated under `/tmp`, preserving the Windows dependency tree. Render YAML parses and Expo introspection confirms the HTTPS policy and version override. Independent review reproduced and verified fixes for both session races; no remaining actionable findings were reported.

Remaining: Render and Supabase integrations are available but not connected. Actual database/TLS verification, payment-history import, hosted deployment, controlled testnet acceptance and creation/installation of the final hosted APK remain outstanding. This sandbox cannot execute Windows tools (`UtilBindVsockAnyPort: socket failed 1`) and has no live PostgreSQL. No live payments were submitted or APK uploaded. Connect the hosting accounts and follow the release guide to finish those external steps.

### Database provider changed to Neon — 15 October 2026

- User selected Neon instead of Supabase. Current hosting choice is **Render Free + Neon Free**; the earlier Supabase selection above is superseded.
- Updated the release guide, server setup, environment example and Render Blueprint comment to require Neon's **direct** PostgreSQL connection, with Connection pooling OFF. No new database SDK or Neon API key is required by the app.
- Payment processing retains its session-level advisory locks and persisted-envelope recovery. Neon uses transaction pooling on its `-pooler` endpoints, including port 5432; the pool factory now rejects these known hostnames. TLS certificate verification stays enabled, with supported SCRAM channel binding enabled in `pg`.
- Schema and payment import remain standard PostgreSQL and need no provider-specific migration. Existing local credentials and payment records were not changed.
- Verification: eight affected storage tests passed, including Neon direct/pooler URL checks; server typecheck and build passed; whitespace check passed. Live Neon connectivity/migration remains unverified.
- Neon integration is available but not connected. Create a Free Neon project, turn pooling OFF in Connect, and set its private connection string as Render's `DATABASE_URL`, or connect Neon here to continue account setup. Render deployment and final Windows APK build remain outstanding.
