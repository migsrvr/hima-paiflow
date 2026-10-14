# Hima × Paiflow: progress handoff

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

**Completed in Phase 1:**
- **`app/(tabs)/profile.tsx`**:
  - Imported `NETWORK_NAME` from `@/services/payments/network`.
  - Replaced `address` with `chain` from `budget.chain`.
  - Added "Stellar / Paiflow wallet" row opening `StellarWalletSheet`.
  - Added "Freighter (testnet)" row with `KeyRound` icon opening `FreighterLinkSheet`.
  - Dynamic connection badge (`Connected`, `Checking…`, `Offline`, `Not set up`).
  - Added `useChainSync()` hook on screen focus.
- **`app/dev/payment.tsx`**:
  - Imported `NETWORK_NAME` from `@/services/payments/network`.
  - Added Settled row to `14a-Result-Success` preview.
- **Verification**:
  - `npx tsc --noEmit`: 0 errors.
  - `npm test`: 12 test suites, 80 tests passing cleanly.
  - No AI / Groq files were touched.

## AI provider: switched from Kimi to Groq (DONE)
- `server/src/services/kimiService.ts` became `chatService.ts` (`ChatService`, `ChatServiceError`, `ChatClient`). It uses an OpenAI-compatible endpoint, defaulting to `https://api.groq.com/openai/v1/chat/completions`, with temperature 0.3 and JSON mode.
- Environment: `GROQ_API_KEY`, `GROQ_MODEL` (default `openai/gpt-oss-120b`; `llama-3.3-70b-versatile` isn't enabled for this key), `AI_TIMEOUT_MS`. The `KIMI_*` variables are gone.
- `/health` now returns `{status, ai, payments}`. `createApp({ ai, payments })`.
- Verified live: a grounded JSON answer came back. 33/33 server tests and 7 mobile AI tests pass.
- UI copy now says "Powered by Groq" (AssistantView, AIInsightCard) and "Suggestions come from Groq" (Profile). This is a deliberate deviation, because the design says Kimi.

## Backend logging and the web-preview CORS fix (DONE)
- **Symptom:** testing the AI on the Expo web preview showed no backend logs.
- **Root causes:**
  1. `CORS_ORIGINS` wasn't set, so the browser blocked `POST /ai/chat` after the preflight.
  2. The server logged no requests at all.
  3. `mobile/services/ai.ts` silently fell back to local answers.
- **Fixes:**
  - `server/src/app.ts` logs one line per request (method, path, status, time, origin; never bodies). It logs once per blocked browser origin with the fix to apply.
  - `server/src/services/chatService.ts` logs `[ai]` lines: answer latency, provider status and error code, rejected numbers, timeouts. The API key is never logged.
  - `server/src/server.ts` prints the AI model and the allowed browser origins at startup.
  - `server/.env` now has `CORS_ORIGINS=http://localhost:8081,http://127.0.0.1:8081`.
  - `mobile/services/ai.ts` uses `apiFetch`. In dev it `console.warn`s why it used the local answer, including a CORS hint on the web.
- **Environment notes:**
  - The backend and Expo run inside WSL (`tsx watch`, `expo start --web`), and Windows `localhost` forwards to them through `wslrelay`.
  - `server/node_modules` now has Linux esbuild, so run `npm test` and `npm run dev` from WSL. On Windows, use `npx tsc && node dist/server.js`.
  - A Codex session is also editing this repo.
- **Verified:** 34/34 server tests pass in WSL. From a real browser page on `localhost:8081`, the AI request returns 200 with a Groq answer, and the log shows `OPTIONS 204`, `[ai] Answered in ~1.3 s`, then `POST /ai/chat 200`.

## Batch D: AI grounding: NOT STARTED
- `mobile/services/ai.ts`:
  - Use `API_URL` from `services/api.ts`.
  - Add `walletBalanceXlm`, `safeToSpendXlm` and `phpPerXlm` to the Kimi context, computed with `approxAsset`/`toStroops` from `chain`.
  - Add a deterministic "how much XLM" intent to `answerFor`.
- `server/src/services/kimiService.ts`:
  - Add to the prompt that XLM figures are supplied testnet equivalents and that the model must never convert currencies.
  - Have `contextFigures` add XLM rows.
- Add tests on both sides.

## Verification & Execution Status
- **Phase 1 (Mobile UI & Wiring)**: **COMPLETE**
  - All 12/12 mobile Jest test suites passed (80/80 tests).
  - All 33/33 server tests passed.
  - `npx tsc --noEmit`: 0 errors.
  - Profile tab, Dev payment screen, StellarWalletSheet, and FreighterLinkSheet wired and verified.
- **Phase 2 (Paiflow Setup & Smoke Test)**: **COMPLETE & VERIFIED ON-CHAIN**
  - Configured native XLM flow with Paiflow deployment `37180696-65cb-4c0c-8c36-42bbeb42f9ae` and trigger contract `CCT6LD7D5EGS2KZP4CH5VUFOBCY5HW72UWKRROV6DA4LCNKDTADVRT2J`.
  - Executed `npm run paiflow:smoke`:
    - Deposit: `11.3333333 XLM` (₱85.00) from Student Wallet (`GCSMEZNXKX34EVBRE2EOX24GF4LTNK5KTYBQWGZT55PHA4MZ7YHRJXIG`).
    - Smart Contract split: 90% (10.20 XLM) + 10% (1.13 XLM) payout.
    - Transaction Hash: `dcafb475acce07ee294df7e8146ed51479f3178c2af367575166928528e9fa35`
    - Status: **Confirmed (ledger 5185517)**
    - Explorer link: `https://stellar.expert/explorer/testnet/tx/dcafb475acce07ee294df7e8146ed51479f3178c2af367575166928528e9fa35`
- **Phase 3 (AI Grounding with Dual Currency)**: In Progress
  - Pass `walletBalanceXlm` and `safeToSpendXlm` into Groq context from mobile to server so AI can answer XLM budgeting questions accurately without hallucinations.
- **Phase 4 (Physical Device Demo)**: Ready for run
  - Android phone connects to `npm run start:windows -- 192.168.1.38`.
  - Tap card `22:E9:4A:7A` → checkout `₱85.00 ≈ 11.33 XLM` → PIN `1234` → on-chain testnet receipt with `stellar.expert` link.


---

## Multi-flow integration (three deployments, one client)
Plan: `C:\Users\Miggy\.claude\plans\prancy-beaming-muffin.md`.

**Agreed decisions:**
- **Flow 1:** the student pays ₱85; 90% goes to the canteen and 10% is auto-saved.
- **Flow 2:** funded by a sponsor wallet via `execute`.
- **Flow 3:** the reward when a week's spending is at or under its Spending allocation.
- **Storage:** JSON-file store plus HMAC session tokens.

### Phase 1, shared layer: DONE
**Server:**
- `src/integrations/paiflow/` holds the shared layer:
  - `client.ts`: one client per deployment. New calls: webhook (`x-webhook-secret` plus `Idempotency-Key`), balances, funding.
  - `registry.ts`: per-flow config and readiness. It never falls back to another flow's deployment, and it flags a USDC deployment or the wrong trigger.
  - `types.ts`, `errors.ts`.
- **Services:**
  - `depositExecutor.ts`: the old `PaymentService` engine, generalized by flow and signer.
  - `attemptStore.ts`: `data/attempts.json`, unique per user, flow and key, with spec statuses.
  - `attemptView.ts`, `checkoutService.ts`, `walletService.ts`, `sessionService.ts`, `flowCatalog.ts`.
- **Wiring:** `compose.ts` is shared by the server and the scripts.
- **Routes:** everything is under `/api`, and `middleware/auth.ts` (`requireSession`) protects every user route.
  - Public: `POST /api/auth/session`, `GET /api/paiflow/flows`, `GET /api/merchants/resolve-tag/:uid`.
  - Session required: `POST /api/ai/chat`, `GET /api/wallet/stellar`, `GET /api/wallet/stellar/accounts/:addr`, `POST /api/checkout/payments`, `GET /api/payments/:id`.
- **Config:** `PAIFLOW_BASE_URL`, `PAIFLOW_{CHECKOUT,ALLOWANCE,REWARD}_{ID,TOKEN}`, the trigger contracts, `PAIFLOW_REWARD_WEBHOOK_SECRET`, `SESSION_SECRET`, and the sponsor, savings and emergency wallets. Legacy `PAIFLOW_DEPLOYMENT_ID`, `PAIFLOW_API_TOKEN` and `PAIFLOW_TRIGGER_CONTRACT` still work as **checkout only**, with a warning.
- **Scripts:** `stellar:setup` is extended (all wallets, `SESSION_SECRET`, Paiflow builder instructions), `paiflow:check` is new, and `paiflow:smoke` is ported.
- **Tests:** 50/50 pass, in WSL, because `server/node_modules` has Linux esbuild. Typecheck and build are clean.

**Mobile:**
- `services/api.ts` sends `Authorization: Bearer` and renews once on a 401. `setApiSession` is set by `stores/session.ts`.
- `services/auth.ts` gets the token from `POST /api/auth/session` at sign-in and renews old `demo-…` tokens.
- All calls use `/api/...`. The wallet store treats a deployment that isn't ready as "Not set up".
- Lint fixes: the sheet resets moved out of effects (`FreighterLinkSheet`, `AuthorizeSheet`), and an unused NFC import was removed.
- 13 suites / 83 tests pass (new `services/__tests__/api.test.ts`). `tsc` and lint are clean (lint runs in WSL).

**Live:**
- `server/.env` points checkout at XLM deployment **`37180696-65cb-4c0c-8c36-42bbeb42f9ae`** (legacy key names), and it is ready.
- A Phase 1 probe made a **real testnet checkout** for user `bea.reyes@example.com`: ₱85 = 11.3333333 XLM, tx `207a94233da6622e765d1973ff4e99b0ebb19f4222f66192ead6a16fd6a67d87`, confirmed in ledger 5185778.
- Horizon effects:
  - `GAHJPWGS…` received 10.1999999 XLM (90%)
  - `GAUN5DT4…` received 1.1333334 XLM (10%)
  - Paiflow rounds the first leg down, and the last leg takes the remainder.
- Those recipients are not the `.env` canteen and savings wallets. Before Phase 2 verification, either set `STELLAR_MERCHANT_PUBLIC_KEY` and `STELLAR_SAVINGS_PUBLIC_KEY` to them, or point the Split at the wallets setup printed.
- The attempt is recorded in `server/data/attempts.json` and would count as that user's spending.

**Restart the WSL server** (`npm run dev`) to load all of this. Then run `npm run stellar:setup` (it creates `SESSION_SECRET` and the new wallets) and `npm run paiflow:check`.

### Next phases
2. Checkout quote/pay with the 90/10 split, Horizon split verification, and the checkout and receipt lines.
3. Allowance: sponsor deposits, branch rule (strictly > 10 XLM), three-leg verification, distributions API.
4. Reward: keyed webhook, pool funding and balance, eligibility, claim and history.
5. Insights cards, web and device end-to-end checks, docs.

## USB backend connectivity debugging — 2026-10-14

- User selected USB cable to this PC as the preferred device connection.
- Inspected the local APK artifacts: the release Hermes bundle embeds `http://10.0.2.2:3001` and no LAN API address. Its merged manifest targets Android 36 without a cleartext allowance or network-security configuration. Those settings prevent physical-phone access to the local HTTP API. The debug APK has no embedded JS and permits cleartext; its URL comes from Metro. `server/.env` already uses `HOST=0.0.0.0`.
- Added `npm.cmd run start:usb:windows`: selects the USB transport with `adb -d`, reverses ports 3001/8081, checks the Windows backend's `/health`, and starts localhost Metro with API `http://127.0.0.1:3001`.
- Added `npm.cmd run usb:windows` to restore forwarding and check backend health without Metro for an embedded release APK.
- Added `--usb` to the Windows Android build helper. It selects the USB phone and uses the localhost API for native configuration and embedded JavaScript. The helper now runs non-clean Android prebuild first, since `run:android` otherwise skips plugin application when `android/` exists. Other release builds require an explicit API URL.
- Added `mobile/plugins/withLocalApi.cjs`, registered in `app.json`: permits cleartext only to the configured HTTP API hostname through Android network-security XML. HTTPS/no-override prebuild removes this plugin's previous manifest binding. No generated native source was edited by hand.
- Updated `mobile/WINDOWS_PHONE_SETUP.md` with the USB workflow, one-time release rebuild, reconnection steps, and diagnostic evidence.
- Checks: mobile TypeScript passes; Expo introspection confirms the network-security manifest binding; focused script checks pass for host restrictions, HTTPS/no-override cleanup, USB device selection, both port reversals, unavailable-device handling, build environment, and prebuild success/failure sequencing. Full lint was attempted but cannot load the missing Linux `unrs-resolver` native binding in this Windows dependency tree.
- Remaining verification: Windows build/install, actual device/host health, and app API calls. This sandbox blocks sockets and Windows ADB interop (`UtilBindVsockAnyPort: socket failed 1`); the existing APK artifacts have not been rebuilt or installed here. No live payments were submitted.

### USB build device-selection correction

- The user's Windows run confirmed that phone `3B162T00Y9A00000` was authorized and both USB port reversals succeeded. Prebuild completed, then Expo rejected the ADB serial supplied to `--device`.
- Confirmed in the installed Expo SDK 57 CLI: `resolveFromNameAsync` matches `device.name`, derived from `model:` in `adb devices -l`; it does not match the ADB serial.
- Corrected `scripts/android-windows.cjs` and `scripts/usb-windows.cjs` to resolve the model name for Expo while preserving the serial for forwarding and `ANDROID_SERIAL`. Handles Windows CRLF/tab output, missing-model fallback, disconnected devices, duplicate model names, and explicitly supplied `--device` arguments.
- Focused checks pass for model selection and build arguments, plus the existing USB forwarding/build checks. Actual Windows build/install still needs the same command rerun.

### Release network XML lint correction

- The next Windows run passed device selection and bundled JavaScript, but `lintVitalRelease` rejected the generated `<domain>` because `includeSubdomains` was omitted.
- Corrected `mobile/plugins/withLocalApi.cjs` to emit `<domain includeSubdomains="false">…</domain>`, preserving the exact-host HTTP policy and satisfying the reported Android lint requirement. The build helper's prebuild step regenerates the resource on rerun; no manual native XML edits or lint suppression are needed.
- Focused checks verify that the generated HTTP policies explicitly exclude subdomains and retain the configured host, alongside existing USB checks. Android release lint/build still requires a Windows rerun; this sandbox cannot execute the Windows Android toolchain.
- The broader TypeScript check on this rerun reports a separate current error in `mobile/stores/payment.ts:70`: its `PaymentState` implementation is missing required `loadQuote`. That file was not edited for this XML correction.
