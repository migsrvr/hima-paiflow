# Hima backend

Standalone Express + TypeScript service. Requires Node.js 22.12 or later (`@stellar/stellar-sdk` 17).

```sh
cd server
npm install
cp .env.example .env
# Set GROQ_API_KEY in .env.
npm run build
npm start
```

`npm run dev` watches TypeScript files. `npm test` runs the service and HTTP contract tests without making external AI, Paiflow or Horizon calls or binding a port. `npm run typecheck` also checks the tests and scripts. If `node_modules` was installed from WSL, run `npm test` and `npm run dev` there (esbuild is platform-specific); `npx tsc && node dist/server.js` works from either side. Environment configuration loads from `server/.env` regardless of the working directory. The key is never stored in source files; `.env`, dependencies, and build output are ignored.

The default address is `http://127.0.0.1:3001`. Set `HOST=0.0.0.0` to allow a physical device or Android emulator to connect; an Android emulator can use `http://10.0.2.2:3001`. Native clients do not need CORS. For browser clients, set `CORS_ORIGINS` to a comma-separated list of allowed origins.

## Endpoints

Everything except `/health` is under `/api`. Routes marked **session** need `Authorization: Bearer <token>` from `POST /api/auth/session`. Another user's records answer 404.

| Method | Path | Auth | Behavior |
| --- | --- | --- | --- |
| GET | `/health` | | `{ "status": "ok", "ai": true, "payments": true }`. These are configuration checks, not provider availability. |
| POST | `/api/auth/session` | | `{ "email" }` → `{ token, expiresAt, userId }`. This is the demo's mock sign-in. Tokens are HMAC-signed with `SESSION_SECRET` and last 7 days. |
| GET | `/api/paiflow/flows` | | Readiness of the three deployments: trigger, input asset, problems, and the recipients Hima expects. Never tokens or secrets. |
| GET | `/api/merchants/resolve-tag/:uid` | | Resolves the registered Campus Canteen demo tags. |
| POST | `/api/ai/chat` | session | `{ "question", "context" }` → `{ "text", "calculated", "suggestion" }`. |
| GET | `/api/wallet/stellar` | session | The testnet paying wallet: public key, live balance (`null` with `balanceError` when Horizon can't be read, never invented), the demo rate `phpPerUnit`, and the checkout deployment's readiness. |
| GET | `/api/wallet/stellar/accounts/:address` | session | Read-only lookup of a G… address (a linked Freighter wallet). |
| POST | `/api/checkout/quote` | session | `{ "paymentId", "merchantId", "amount" (PHP), "reference" }` → prices the payment and its 90/10 split (PHP and XLM) and checks the paying wallet's balance. It returns `quoteId`, `split`, `autoSaved` and `quoteExpiresAt`. Nothing is prepared or signed. Unpaid quotes lapse to `cancelled` after 5 minutes. |
| POST | `/api/checkout/payments` | session | `{ "quoteId" }` pays that quote. A full quote body quotes and pays in one step. Idempotent per user on `paymentId`: a repeat never pays twice. |
| GET | `/api/payments/:id` | session | Any of the user's attempts, by Hima id or the app's payment id. Returns `status` (pending / confirmed / failed / cancelled), the full lifecycle `state`, `txHash`, `ledger`, the exact `assetAmount` and `explorerUrl`. |

## Payments (Paiflow on Stellar testnet)

Hima drives three Paiflow deployments through one shared client (`src/integrations/paiflow/`):

| Flow | Deployment | Hima service |
| --- | --- | --- |
| 1, NFC checkout | Receive (XLM) → Split 90% canteen / 10% savings | `checkoutService.ts` |
| 2, Smart allowance | Receive (XLM) → Condition amount > 10 XLM → Split 70/20/10 or 85/10/5 | `allowanceService.ts` (Phase 3) |
| 3, AI savings reward | Webhook → Pay → savings | `rewardService.ts` (Phase 4) |

Each flow has its own `PAIFLOW_<FLOW>_ID` and `PAIFLOW_<FLOW>_TOKEN`; the reward flow also has a webhook secret. The registry (`registry.ts`) never lets one flow use another flow's deployment. It marks a flow **not ready** when it is unconfigured, unreadable, has the wrong trigger, has a non-XLM input asset, or lacks the operation Hima uses, and payments on a not-ready flow are refused before anything is prepared. The old single-flow names (`PAIFLOW_DEPLOYMENT_ID`, `PAIFLOW_API_TOKEN`, `PAIFLOW_TRIGGER_CONTRACT`) still work as the checkout deployment, with a deprecation warning.

1. `npm run stellar:setup` creates any missing wallets and `SESSION_SECRET`, funds the wallets with Friendbot, and prints what to build in the Paiflow builder.
2. Add each flow's id and token (and `PAIFLOW_REWARD_WEBHOOK_SECRET`) to `.env` yourself. Tokens are shown once in Paiflow.
3. `npm run paiflow:check` prints each deployment's readiness, balances and funding nodes.
4. `npm run paiflow:smoke [amountPhp]` makes one live checkout and prints its status, explorer link and events.

How a deposit flow runs (`src/services/depositExecutor.ts`, shared by checkout and allowance):

- **Amount.** PHP converts to stroops with integer math at `PHP_PER_INPUT_UNIT` (₱85 = 11.3333333 XLM).
- **Prepare and verify.** Paiflow prepares the deposit. Before signing, Hima checks it is a single `deposit` call on the flow's trigger contract, for exactly that amount, from the expected signer (student for checkout, sponsor for allowance), on testnet, with a bounded fee and expiry.
- **Save, then submit.** The signed envelope is saved to `data/attempts.json` *before* submission, so retries and restarts reuse that envelope and Paiflow never sends it twice.
- **Status.** `SUCCESS` → `confirmed`. `FAILED` / `REJECTED` → `failed` (not charged). `PENDING` / `UNKNOWN` / no answer → `pending`, resubmitted with the same envelope. After the window closes, Horizon decides.
- **Secrets.** Wallet secrets, tokens and the webhook secret live only in `.env`. Logs carry codes, never secrets or bodies.

**Payout verification** (`paymentVerification.ts`): once a payment is confirmed, Hima reads the transaction's `account_credited` effects on Horizon and compares them with the flow's expected legs:
- **Expected legs:** from `flowCatalog.ts`, using the addresses in `PAIFLOW_<FLOW>_RECIPIENTS` or the wallets.
- **Rounding:** each leg but the last rounds down and the last takes the remainder (`splitByPercents`), with 1 stroop of tolerance per leg.
- **Statuses:**
  - `verified`: every leg was paid its share.
  - `mismatch`: a configured recipient wasn't paid what the flow should pay. It is logged and shown on the receipt.
  - `unavailable`: Horizon couldn't be read yet; retried every 10 s.

A leg with no configured address is matched by amount, and the result says so.

Live checkouts through deployment `37180696…`, both verified:
- Ledger 5185778: the first one.
- Ledger 5186930 (tx `f65b28ed…`): quote → pay → verify.

Each paid ₱85 = 11.3333333 XLM → 10.1999999 XLM to the canteen and 1.1333334 XLM to savings.

### Budget context and live verification

```sh
TOKEN=$(curl -s http://127.0.0.1:3001/api/auth/session -H 'Content-Type: application/json' --data '{"email":"bea.reyes@example.com"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl --fail-with-body http://127.0.0.1:3001/api/ai/chat \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data '{"question":"Can I buy lunch for PHP 150?","context":{"currency":"PHP","allowance":1500,"frequency":"weekly","universityDays":["Mon","Wed","Fri"],"safeToSpend":420,"spendingSoFar":280,"emergencyReserves":200}}'
```

`question` must contain 1–2000 characters after trimming. `context` is optional JSON and is forwarded intact to the model. Requests are limited to 32 KB. Without context, the assistant should ask for missing budget information.

The `calculated` array contains server-formatted context figures for `allowance` (or `allowance.amount`), `safeToSpend`, `spendingSoFar` (or `spentThisPeriod`), and `emergencyReserves` (or `emergencyReserve`). Only finite numeric values are included. The default currency is PHP; a three-letter `currency` field selects another currency. These fields are snapshots of the supplied context, not independently verified ledger balances. This standalone service does not persist a ledger or recompute the budget.

The model is prompted to ground advice in the supplied allowance, frequency, university days, Safe-to-Spend, spending, and reserves. The server ignores model-generated calculations and rejects replies with numeric values absent from the supplied question and context. It cannot verify the meaning or accuracy of arbitrary prose. `suggestion` is advisory text or null; no route changes plans or executes payments.

The service calls Groq's OpenAI-compatible endpoint `https://api.groq.com/openai/v1/chat/completions` with `GROQ_MODEL` (default `openai/gpt-oss-120b`; `llama-3.3-70b-versatile` is not enabled for this key), temperature 0.3, JSON mode, a truthful Hima client identifier, and a configurable 60-second timeout (`AI_TIMEOUT_MS`, 1000–120000). It reads `choices[0].message.content` and accepts plain text or JSON with `text` and optional `suggestion` strings, including fenced JSON. List the models a key can use with `GET https://api.groq.com/openai/v1/models`.

### Demo NFC tags

`22:E9:4A:7A`, `22E94A7A`, and lowercase equivalents normalize to the same tag. `04A1B2C34F2A` is also registered. Both return:

```json
{"id":"campus-canteen","name":"Campus Canteen","category":"food","icon":"utensils","verified":true}
```

Malformed hex or invalid byte grouping returns 400; valid unregistered UIDs return 404. The resolver only recognizes demo merchants; it does not write NFC tags or authorize payments.

### Errors

Errors use `{ "error": { "code": "...", "message": "..." } }`. Request errors return 400, oversized bodies 413, and non-JSON chat requests 415. Missing configuration and provider throttling return 503, timeouts 504, and provider failures or unreadable/ungrounded replies 502. Provider bodies and keys are never forwarded to the client.

## Verification checkpoint — 2026-10-13

Groq verified live on 2026-10-14: a budget question returned a grounded JSON answer through `ChatService`. Tests mock the provider and make no network calls.
