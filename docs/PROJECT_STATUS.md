# Hima × Paiflow — project documentation and feature status

**Updated:** 14 October 2026  
**Scope:** implementation visible in this workspace, checked against the existing project handoffs and plans.

## 1. Current position

Hima's demo includes onboarding, schedule-based budgeting, dashboard and insights screens, AI advice, native NFC merchant recognition, and payment authorization. The Express backend and mobile payment plumbing for Paiflow have been implemented. Integration is still in progress: Profile uses the old wallet interface, the new wallet sheets are not connected there, XLM-aware AI answers are unfinished, and a real Paiflow checkout-to-receipt run still needs evidence.

The app is **not yet a completed production banking or payment product**. Login is simulated, budgets and preferences are stored locally, selected analytics use seeded examples, and the backend uses a shared demo signing wallet and a JSON payment store. Supabase/PostgreSQL appears in the original plan but is not implemented in the inspected source.

This document distinguishes four statuses:

- **Implemented:** present in the source for the current demo scope; this does not by itself mean device or live-service verification.
- **In progress:** supporting code exists, but integration or acceptance checks remain.
- **Awaiting verification/configuration:** implementation exists, but external setup or runtime evidence is outstanding.
- **Planned / not implemented:** specified in plans or represented by placeholder controls, without a complete implementation.

## 2. Completed work in the current demo

| Area | What has been implemented | Evidence and limits |
| --- | --- | --- |
| Product and visual design | Product/UX specification, approved HTML screen references, foundations, components, mascot assets, and payment state designs. | [Design index](../design/README.md), [UX specification](hima-ui-spec.md). Final screenshot comparison for the latest integration is outstanding. |
| Mobile foundation | Expo SDK 57, React Native, TypeScript, Expo Router, fonts, shared components, theme files, safe-area and keyboard support, and reduced-motion helpers. | `mobile/app/_layout.tsx`, `mobile/components/`, `mobile/theme/`, `mobile/hooks/`. Accessibility helpers exist; a full accessibility audit is not recorded. |
| Demo account flow | Login/sign-up service, validation UI, session storage/restore, logout, and session-gated navigation. | `mobile/services/auth.ts`, `mobile/stores/session.ts`, `mobile/app/(auth)/`. Credentials are not verified by a real identity provider. |
| Onboarding | Allowance amount/frequency, school days, optional class hours, expense estimates, savings and emergency reserves, budget preview, over-budget state, and confirmation. | `mobile/app/(onboarding)/`, `mobile/stores/onboarding.ts`. |
| Budget engine | Deterministic allowance, plan, spending, weekly summaries, and Safe-to-Spend calculations using centavo arithmetic. | `mobile/services/budget/` and its tests. This engine currently runs in the mobile app, not an authoritative backend ledger. |
| Budget persistence/editing | Locally persisted confirmed plans, profile entry points for editing allowance/schedule/expenses, and explicitly approved category adjustments. | `mobile/stores/plan.ts`, `mobile/hooks/useEditPlan.ts`. No cross-device database sync. |
| Home dashboard | PHP balance and Safe-to-Spend, plan/progress cards, recent activity, AI insight entry points, Tap to Pay, and a testnet asset-equivalent preview. | `mobile/app/(tabs)/home.tsx`, `mobile/hooks/useBudget.ts`. PHP deposits/activity include demo behavior. |
| Schedule | Week/day views, school/free-day plans, class-hour controls, and daily budget displays. | `mobile/app/(tabs)/schedule.tsx`, `mobile/components/schedule/`. |
| Insights | Week/month spending views, category breakdown, transactions, weekly trend chart, and suggestion cards. | `mobile/app/(tabs)/insights.tsx`. Previous-week history and recurring spending patterns are demo fixtures. |
| Hima AI | Chat interface, calculated figure rows, suggested prompts, local deterministic fallback answers, and approval-based plan changes. | `mobile/services/ai.ts`, `mobile/stores/assistant.ts`, `mobile/app/assistant/`. Pattern-based suggestions still use demo data. |
| AI backend/provider migration | Express chat endpoint, Groq integration, input/error handling, structured responses, and numeric grounding checks. UI attribution now says Groq. | `server/src/services/chatService.ts`, `server/src/routes/ai.ts`. A successful live Groq answer is recorded in the existing handoff. |
| Native NFC | Android tag reading, merchant classification, cancellation/timeout handling, and scanner state screens. Both registered demo IDs resolve to Campus Canteen. | `mobile/services/nfc/`, `mobile/services/payments/merchants.ts`. Prior handoff reports physical-card detection. Web and missing-native-module paths simulate scans. |
| Checkout | Merchant/amount review, category-plan impact, Safe-to-Spend/reserve impact, overspend warning, insufficient-balance blocking, and explicit confirmation. | `mobile/services/payments/checkout.ts`, `mobile/app/payment/checkout.tsx`. Budget eligibility is calculated locally. |
| Payment authorization | Native biometric request, in-app demo PIN, wrong-PIN feedback, and quick-approve demo control. | `mobile/services/biometric.ts`, `mobile/components/payment/AuthorizeSheet.tsx`. The fixed demo PIN is not production authentication. |
| Payment state UI | Authorization/submission/confirmation screens, confirmed/pending/failed results, transaction details, failure reasons, and explorer links. | `mobile/app/payment/`, `mobile/components/payment/`. Live settlement acceptance remains open. |
| Backend API foundation | Health/configuration probe, chat, demo merchant lookup, Stellar wallet lookup, payment create/status endpoints, request validation, and structured errors. | `server/src/app.ts`, `server/src/routes/`. No authenticated, per-user API boundary is implemented. |
| Paiflow server implementation | Typed Paiflow/Horizon clients, PHP-to-stroops conversion, envelope checks before signing, save-before-submit, idempotent payment creation, polling/reconciliation, and setup/smoke scripts. | `server/src/services/`, `server/scripts/`. Live settlement has not been established by the reviewed evidence. |
| Mobile payment plumbing | Shared API client, Paiflow processor, explicit mock processor, payment IDs and asset metadata, persisted chain state, pending reconciliation, and focus refresh. | `mobile/services/api.ts`, `mobile/services/payments/processor.ts`, `mobile/stores/payment.ts`, `mobile/stores/wallet.ts`, `mobile/hooks/useChainSync.ts`. |
| Currency display utilities | BigInt stroop conversion/formatting, approximate asset equivalents, and exact settlement amounts. Home, checkout, and result integration exists. | `mobile/utils/asset.ts`, `mobile/components/finance/SafeToSpendCard.tsx`, `mobile/components/payment/CheckoutView.tsx`, `mobile/app/payment/result.tsx`. Android bundle/device verification remains open. |
| Development setup | EAS profiles, Windows Metro launcher, Windows Android build helper, device/network troubleshooting guide, and component/payment/assistant preview routes. | `mobile/eas.json`, `mobile/scripts/`, [phone setup guide](../mobile/WINDOWS_PHONE_SETUP.md), `mobile/app/dev/`. Latest native build completion is not established here. |

## 3. Features in progress

| Feature | Already done | Work remaining / completion condition |
| --- | --- | --- |
| Profile → Stellar / Paiflow wallet | Wallet lookup API, chain store, address helpers, and `StellarWalletSheet` component. | Replace Profile's removed `address` field and old network import; connect the sheet and render checking/connected/offline/not-set-up states from the store. |
| Profile → Freighter | Read-only Stellar account lookup, address validation, persisted link setting, and `FreighterLinkSheet` component. | Add the Profile row, open the sheet, and refresh linked balance on focus. Freighter is a read-only link in the agreed scope, not the payment signer. |
| Payment preview route | Existing screen-state previews and updated result components. | Fix the old network import in `mobile/app/dev/payment.tsx` and add the exact settled-asset row to its success preview. |
| End-to-end Paiflow settlement | Server orchestration, mobile processor, result UI, and smoke script. | Confirm deployment configuration and token, execute the real flow, verify recipient credit and transaction evidence, then test the complete app flow. |
| XLM-aware AI advice — Batch D | PHP advice and currency conversion utilities. | Share `API_URL`, supply calculated XLM equivalents and the configured demo rate, add an XLM question intent, update `chatService.ts` grounding, and test both sides. This batch is recorded as not started. |
| Integration quality checks | Existing unit/service tests and historical build checks. | Resolve current compilation/lint failures, verify Android export, compare updated screens with approved designs, and repeat checkout on a physical phone. |

### Live-payment dependencies

The last payment handoff records a missing `PAIFLOW_API_TOKEN`; this documentation review did not inspect secrets or recheck provider configuration. It also records funded testnet payer/merchant accounts. Treat both as historical observations until revalidated.

Before declaring settlement complete:

1. Configure the Paiflow token in `server/.env` and confirm the intended deployment and trigger contract.
2. Confirm that the deployment accepts native XLM and its Split sends 100% to Campus Canteen; update the configured deployment ID if redeployment changes it.
3. Run the existing setup/capability check and payment smoke script, verifying the actual contract invocation and merchant credit.
4. Finish the mobile integration, then verify successful, failed, and interrupted/pending payments, including restart reconciliation and no duplicate charge.
5. Archive the transaction hash, explorer evidence, deployment evidence, and device screenshots required for the demo/hackathon.

These are remaining tasks; no external configuration changes or testnet payment submissions were performed for this documentation update.

## 4. Planned or incomplete beyond the current demo

| Capability | Current state |
| --- | --- |
| Real authentication and account security | Simulated login/sign-up accepts inputs without server credential verification. Supabase Auth, password recovery/change, and authenticated API requests remain unimplemented. |
| Database-backed persistence | No Supabase/PostgreSQL migrations, user-scoped access policies, or cross-device plan/profile/ledger synchronization found. Mobile data is local; server payment records use a JSON file. |
| Authoritative backend budget validation | Budget calculations and checkout checks live in mobile services. The chat server formats supplied context; it does not independently verify the student's ledger or recompute their budget. |
| Personal wallet ownership | The payment server signs using a configured Hima demo wallet. Per-user wallet provisioning/signing is not implemented. |
| Real historical insights | Charts and observations partly use `DEMO_WEEKLY_HISTORY` and `DEMO_PATTERNS`. Deriving recurring patterns from accumulated real spending remains future work. |
| Editable profile and password | Profile controls currently show “isn't available in this demo yet” alerts. |
| Notification delivery | In-app notification derivation and preference switches exist. Push delivery and scheduled daily summaries are not implemented. |
| App lock on launch/resume | A persisted switch exists. No launch/resume lock enforcement was found; payment authorization is implemented separately. |
| Multiple live merchants | Demo NFC registry and payment flow target Campus Canteen. General merchant onboarding and routing are not complete. |
| Production deployment/release | No completed production rollout, real-money rail, store release, or production acceptance evidence is established by this workspace review. |

## 5. How the implemented parts fit together

```text
Android app (Expo / React Native / TypeScript)
  ├─ Demo session + local preferences and plans
  ├─ Local budget engine → Home / Schedule / Insights
  ├─ AI chat → Express API → Groq
  └─ NFC merchant → checkout → explicit biometric/demo-PIN approval
                                  ↓
                           Express payment API
                                  ↓
                    Paiflow Receive → Split deployment
                                  ↓
                   Stellar testnet → Campus Canteen
                                  ↓
               status reconciliation → receipt + local ledger
```

The current architecture differs from the original plan's authenticated API, PostgreSQL persistence, and backend budget engine. Those remain planned work, not completed infrastructure.

### Budget and money rules

- **Safe-to-Spend = PHP wallet ledger balance − remaining planned expenses − protected reserves.** The displayed value is clamped to zero; shortfall is tracked separately.
- Budget calculations use integer centavos internally. PHP-to-XLM settlement conversion uses integer centavos/stroops.
- Home's PHP balance is an app ledger, including demo allowance deposits; it is not a PHP bank account or the on-chain XLM balance.
- The agreed demo rate is **₱7.50 per XLM**, configured on the server. It is a fixed demo equivalence, not a market exchange-rate claim. At that rate, ₱85 maps to 11.3333333 XLM.
- Pending outgoing payments reserve local funds; failed payments do not count against the local balance. Reconciliation updates the existing transaction record.
- AI suggestions require explicit approval before changing the plan. Some recommendation evidence currently comes from demo fixtures.

### Payment rules

- NFC identifies a demo merchant; tapping does not itself authorize a charge.
- Payments are designed to go through the configured Paiflow Receive → Split deployment. Horizon is used for read-only balance/transaction lookup.
- Before signing, the server verifies the expected deposit call, contract, amount, source, testnet network, fee bound, and expiry.
- The server saves the signed envelope before submission and reuses it for retries/status recovery.
- Success is shown only after the processor reports confirmation. A timeout/unresolved response stays pending and can be checked again.
- Mock payments require explicit `EXPO_PUBLIC_PAYMENTS=mock`; they are not an automatic fallback when the real payment service is unavailable.

### Backend endpoints currently implemented

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Service liveness and AI/payment configuration flags; not proof that providers are reachable. |
| POST | `/ai/chat` | Budget advice using supplied context. |
| GET | `/merchants/resolve-tag/:uid` | Demo merchant lookup. |
| GET | `/wallet/stellar` | Configured testnet wallet, asset balance, demo rate, and deployment details. |
| GET | `/wallet/stellar/accounts/:address` | Read-only linked-wallet account lookup. |
| POST | `/payments` | Create or retrieve an idempotent payment attempt. |
| GET | `/payments/:paymentId` | Reconcile/read payment status. |

See [backend documentation](../server/README.md) for request shapes, error responses, and setup commands.

## 6. Verification and evidence

### Previously recorded checks

The [payment handoff](../PAIFLOW_PROGRESS.md) records:

- 33 server tests passing, plus server typecheck and build.
- 14 new mobile asset/payment-processor tests passing.
- Seven mobile AI tests passing and a successful live Groq response.
- Funded Stellar testnet accounts and working wallet/account lookups; payment creation returned a configuration error while the token was missing.

The older [Stellar implementation spec](../STELLAR_PAIFLOW_IMPLEMENTATION.md) reports a physical Android run with NFC detection, AI chat, and PIN authorization before the latest integration changes. That report does not establish that the current code compiles or that Paiflow settlement works end to end.

### Checks performed for this documentation update

| Check | Result on 14 October 2026 |
| --- | --- |
| Documentation links | All 20 relative links across the root README and this report resolve. |
| Server `npm run typecheck` | Passed; no TypeScript diagnostics. |
| Server `npm test` | Blocked before test assertions: installed esbuild binary targets Windows, while this session runs Linux/WSL. All five test files failed to load. The earlier 33-test pass is historical evidence, not a fresh pass. |
| Mobile `npm run typecheck` | Failed with three diagnostics: removed `NETWORK_NAME` import in Profile and the payment preview, plus removed `BudgetContext.address` use in Profile. |
| Mobile `npm run lint` | Started but produced no diagnostics or completion after several minutes; interrupted. Current lint status is unverified. An earlier setup checkpoint reports an `AuthorizeSheet.tsx` hook lint error. |
| Mobile `npm test -- --runInBand` | Stopped by a 45-second timeout without test results. No fresh mobile test pass is claimed. |

This update reviews implementation status and does not change application behavior. No dependencies were installed to work around the platform mismatch.

### Outstanding acceptance evidence

- Current Android bundle export and device run after the wallet integration.
- Screenshot comparison at the approved 360-wide baseline for Home, checkout, receipt, PIN, and Profile; include the intended Groq and XLM-display deviations.
- Real Paiflow payout through the intended deployment, verified recipient credit, transaction hash, and explorer receipt.
- End-to-end interruption/restart recovery and duplicate-submission behavior.
- Current Windows phone connectivity and build readiness where needed; historical LAN addresses and local toolchain observations are not permanent configuration facts.

## 7. Recommended next work

1. Complete Profile wallet/Freighter wiring and the payment preview fixes; resolve the current typecheck/lint blockers.
2. Validate Paiflow token, input asset, recipient, and deployment; capture one confirmed settlement with evidence.
3. Finish Batch D so AI answers can reference deterministic XLM equivalents.
4. Complete Android export, visual comparison, and physical-device payment/recovery acceptance.
5. If moving beyond the demo, implement real identity, authenticated APIs, database persistence, authoritative server-side budget validation, and per-user wallet ownership.

## 8. Documentation map and update rules

| Document | Role |
| --- | --- |
| This file | Consolidated feature inventory and completion status. |
| [PAIFLOW_PROGRESS.md](../PAIFLOW_PROGRESS.md) | Detailed payment integration handoff and agreed decisions. |
| [hima-ui-spec.md](hima-ui-spec.md) | Product behavior and UX requirements. |
| [Design README](../design/README.md) | Approved screen references and visual decisions. |
| [Server README](../server/README.md) | Backend setup and API contract. |
| [Windows/phone setup](../mobile/WINDOWS_PHONE_SETUP.md) | Development-device and host setup history. |
| [Original implementation plan](../mobile/HIMA_IMPLEMENTATION_PLAN.md) | Intended MVP architecture and task breakdown. |
| [Stellar implementation spec](../STELLAR_PAIFLOW_IMPLEMENTATION.md) | Historical proposal/context; provider and architecture descriptions may have been superseded. |

Older documents reference Kimi and `kimiService.ts`; the implemented provider is now **Groq**, in `chatService.ts`. The original plan also describes infrastructure that has not been built. Use source evidence and dated verification when updating status, and keep visual/behavior requirements in their existing source documents.

For each future checkpoint, record the date, feature, changed paths, checks/results, and remaining acceptance work. Mark a live integration complete only when its external behavior has been verified; keep credentials and private keys out of these documents.
