# Hima × Paiflow

**Hima is a student allowance app.** It turns a weekly allowance and class schedule into one daily number, **Safe-to-Spend**. It answers budget questions with AI that only quotes the student's own figures. Students pay at campus merchants by tapping an NFC card, and the payment settles on the **Stellar testnet** through a **Paiflow** flow that automatically saves 10% of every purchase.

Android-first. Built with React Native + Expo (TypeScript) and an Express + TypeScript API.

| | Link |
| --- | --- |
| Live demo (phone frame and walkthrough) | https://hima-showcase.vercel.app |
| Web app on its own | https://hima-demo.vercel.app |
| Android APK (demo build) | [Release demo-v1.0.1](https://github.com/migsrvr/hima-paiflow/releases/tag/demo-v1.0.1), SHA-256 `21f50169…d12d248` |
| API | https://hima-demo-api.onrender.com (`/health`, `/ready`) |
| Source | This repo (API, docs, design) and [`hima-mobile`](https://github.com/migsrvr/hima-mobile) (the app, linked here as the `mobile/` submodule) |

> Testnet only: no real money moves. On the free hosting tier the API may need about a minute to wake up on the first visit.

## Try it (about 2 minutes)
1. **Sign up** with any email and password. Accounts are demo-only.
2. **Build your plan:** allowance, school days, expected expenses, savings and emergency reserve. Home then shows your Safe-to-Spend.
3. **Tap to Pay:**
   - With no NFC (a browser, emulator or phone without NFC), the app simulates tapping the registered student ID at *Campus Canteen*, and says so on screen.
   - Review the checkout and approve with the PIN **1234**.
   - The receipt appears only after the ledger confirms the payment. It shows the XLM settled, what the canteen received (90%) and what was auto-saved (10%).
4. **Ask Hima AI**, for example "Can I afford a ₱150 lunch today?" The answer shows the calculated figures it used.

## The problem and the idea
Students get a fixed allowance but spend daily, and the gap between "money in my wallet" and "money I can actually spend today" is where they overspend. Hima answers that gap directly:

**Safe-to-Spend = wallet balance − remaining planned expenses this period − protected reserves (savings + emergency)**

The plan follows the student's real week: school days cost more (food, transport) than free days. Every payment is checked against the plan before the student approves it. On-chain, each campus purchase pays the merchant and moves 10% into the student's savings in a single transaction.

## Features
- **Onboarding to a weekly plan.** Allowance amount and frequency, school days and class hours, expense estimates, savings and emergency reserves, an over-budget warning with suggested fixes, and confirmation.
- **Home.** Safe-to-Spend, today's plan by category, progress, recent activity, and the testnet XLM balance of the paying wallet.
- **Schedule.** Week and day views with school and free-day budgets.
- **Insights.** Week and month spending, category breakdown, trend chart and suggestions.
- **Hima AI** (Groq). Answers grounded in the student's numbers, with suggested plan changes that apply only after explicit approval.
- **NFC tap-to-pay** (Android).
  - It reads the card's tag ID only and identifies the merchant.
  - The tap never pays by itself.
  - The scan screen covers the ready, reading, unknown-tag, NFC-off, no-NFC and timeout states.
- **Checkout.**
  - Shows the plan impact and Safe-to-Spend impact, warns before overspending, and blocks a payment the balance can't cover.
  - Shows the 90/10 split in PHP and XLM.
- **Authorization.** Fingerprint, or the in-app PIN.
- **Payment states.** Processing, confirmed, pending and failed. Pending and failed screens never show success. The receipt links to stellar.expert.
- **Profile.** Edit the plan; open the Stellar wallet sheet; link a Freighter address read-only.

## Architecture
```
 Android app / web build (Expo, React Native, TypeScript)
   ├─ local budget engine (centavo math) ──► Home · Schedule · Insights · Checkout checks
   ├─ Hima AI chat ───────────────────────┐
   └─ NFC tag → merchant → checkout → PIN/biometric
                                          ▼
                 Hima API (Express + TypeScript, Render)
   ├─ /api/ai/chat ──► Groq (numbers checked against supplied context)
   ├─ /api/checkout/quote → /payments ──► Paiflow deployment: Receive XLM → Split 90/10
   │        prepare → verify envelope → save → sign → submit → reconcile      │
   ├─ payment attempts ──► Neon Postgres (advisory locks, idempotency keys)   ▼
   └─ payout verification ◄── Horizon (testnet) ◄──────────── Stellar testnet ledger
```

### How a payment works
1. **Quote.** PHP is converted to stroops with integer math at a fixed demo rate of **₱7.50 = 1 XLM**, so ₱85 = 11.3333333 XLM. The quote also prices the split: canteen 10.1999999 XLM, savings 1.1333334 XLM.
2. **Prepare and verify.** Paiflow prepares the deposit transaction. Before signing, the server checks it:
   - a single `deposit` call on the expected trigger contract;
   - for exactly that amount, from the expected wallet;
   - on testnet, with a bounded fee and expiry.
3. **Save, then submit.** The signed envelope is stored **before** it is submitted. Retries and restarts resubmit the same envelope, so a payment can never be charged twice. Hosted instances serialize each attempt with a Postgres advisory lock.
4. **Confirm.** The app shows **Payment confirmed** only once the ledger confirms. A timeout stays *pending* and is reconciled later; it never becomes a guess.
5. **Verify the payout.** The server reads the transaction's credits on Horizon and checks that every leg of the split was paid. The result is `verified`, `mismatch` or `unavailable`.

## Engineering highlights
- **Money is never floating point.** Budgets use integer centavos and chain amounts use BigInt stroops. Split rounding is deterministic: each leg rounds down and the last takes the remainder.
- **Idempotent, crash-safe payments.** This comes from the save-before-submit and same-envelope recovery above, plus per-user idempotency keys and database-backed attempt state with a transactional migration and import.
- **AI that can't invent numbers.** The model receives the student's computed context. The server discards model-made calculations and rejects replies containing numbers that aren't in the question or context. The app also has deterministic fallback answers.
- **Public-demo hardening.**
  - Rate limits: sign-in 10 per IP per hour; AI 20 per user and 40 per IP per hour; payments 5 per user, 10 per IP and 100 overall per day. The payment quota is counted from the database, so it survives restarts.
  - A retry of an already-sent payment is never blocked.
  - The shared testnet wallet tops itself up: Friendbot funds a throwaway account, which is merged into the wallet.
- **Secrets stay server-side.** Build scripts fail if any server secret ends up in the web bundle or the APK. Logs carry codes, never bodies or keys.
- **Pixel-faithful design port.** 32 approved HTML screen designs in `design/screens/` were ported 1:1 to React Native at a 360dp baseline. One shared theme in `mobile/theme/` holds the tokens, and status is always shown as icon + label + color.
- **Demo mode** (`EXPO_PUBLIC_DEMO=1`, hosted builds only). It simulates the NFC tap where there's no NFC hardware and uses the PIN on the web. Payment behavior is unchanged.

## Tech stack
| Layer | Technology |
| --- | --- |
| App | Expo SDK 57, React Native 0.86, React 19, TypeScript, Expo Router, Zustand, react-native-nfc-manager, expo-local-authentication, lucide-react-native, Plus Jakarta Sans + Inter |
| API | Node 22, Express 4, TypeScript, Zod, `@stellar/stellar-sdk` 17, `pg` |
| Payments | Paiflow (Receive → Split deployment) on Stellar testnet, Horizon for reads |
| AI | Groq, OpenAI-compatible API (`openai/gpt-oss-120b`) |
| Data | Neon Postgres (hosted), JSON file store (local) |
| Hosting | Render (API, Ohio), Vercel (web app and showcase), GitHub Releases (APK) |
| Testing | Node test runner (API), Jest + React Native Testing Library (app), Playwright (end-to-end browser checks) |

## Verified results
- **Live checkouts on the testnet** through Paiflow deployment `37180696…`, with every split leg verified on Horizon. Ledgers include 5185778 and 5186930.
- **Hosted end-to-end run on 27 Oct 2026** against https://hima-demo.vercel.app at 360 px width:
  - sign-up → onboarding → Home → simulated tap → checkout → PIN;
  - **payment confirmed on the testnet in about 8 s**, with a receipt showing the canteen and auto-save legs;
  - the 6th payment by the same user that day was refused by the rate limit, as designed.
- **Tests:**
  - API: 79 passing (1 optional local-Postgres test skipped), plus typecheck.
  - App: 113 tests in 19 suites, plus typecheck and lint.

## Scope and limitations (honest status)
This is a **functional testnet demo**, not a production payment product.
- **Sign-in is a demo.** Any email gets an HMAC-signed session; there's no identity provider or password check.
- **Plans live on the device.** Budgets, plans and preferences are stored locally with no cross-device sync. The budget engine runs in the app, not on the server.
- **One shared wallet pays.** The server signs with a demo testnet wallet; there are no per-user wallets.
- **Some Insights data is sample data.** Weekly history and recurring patterns use fixtures.
- **Two Paiflow flows are designed but paused.** Flow 2, a smart allowance (Receive → condition → 70/20/10 or 85/10/5 split), and Flow 3, an AI savings reward (webhook → pay to savings), aren't implemented. Flow 1 checkout is live.
- **The AI needs a valid Groq key on the server.** Without one, the app answers with its built-in deterministic replies.
- **The demo APK is signed with a demo key.** It's for sideloading, not the Play Store.

## Repository layout
```
mobile/     Expo app (git submodule → hima-mobile): app/ routes, components/, services/, stores/, theme/
server/     Express API: src/routes, src/services (checkout, deposit executor, verification, AI), src/integrations/paiflow, tests/
design/     Approved UI: screens/*.html (visual spec), Foundations, Components, overview.html
docs/       Product spec, deployment guides, status
showcase/   Static portfolio page (phone frame + walkthrough), deployed to Vercel
render.yaml Render service definition for the API
```
Clone with the app included: `git clone --recurse-submodules https://github.com/migsrvr/hima-paiflow`

## Run it locally
```sh
# API (Node 22)
cd server && npm install && cp .env.example .env   # fill in keys yourself; never commit .env
npm run build && npm start                          # http://127.0.0.1:3001

# App
cd mobile && npm install
npx expo start                                      # Android dev build, or press w for web
```
Each setup is covered in its own guide:
- [server/README.md](server/README.md): wallets, Paiflow setup, Postgres.
- [mobile/WINDOWS_PHONE_SETUP.md](mobile/WINDOWS_PHONE_SETUP.md): Android phone and emulator.
- [docs/HOSTED_DEMO.md](docs/HOSTED_DEMO.md): Render, Neon, the web demo and the APK builds.

## Documentation
| Document | What it covers |
| --- | --- |
| [docs/hima-ui-spec.md](docs/hima-ui-spec.md) | Product and UX spec: screens, flows, rules |
| [design/README.md](design/README.md) | Approved design: screen index, tokens, sample-data math |
| [server/README.md](server/README.md) | API endpoints, payment pipeline, storage, errors |
| [docs/HOSTED_DEMO.md](docs/HOSTED_DEMO.md) | Hosting, demo mode, rate limits, web and APK builds |
| [docs/DEPLOY_SETUP.md](docs/DEPLOY_SETUP.md) | The live deployment: services, URLs, settings checklist |
| [PAIFLOW_PROGRESS.md](PAIFLOW_PROGRESS.md) | Payment integration log and decisions |
| [docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md) | Feature inventory as of 14 Oct 2026. It predates the verified payments and the hosted demo, so this README supersedes it. |

Older planning documents mention Kimi; the AI provider is **Groq** (`server/src/services/chatService.ts`).
