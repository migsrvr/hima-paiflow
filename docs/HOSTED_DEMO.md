# Downloadable APK with the hosted demo API

Hima can run on a tester's phone without your PC or USB. The APK contains the public HTTPS API address; Render runs Express and Neon stores payment attempts. The phone still needs internet. This remains the existing mock-login, shared-wallet Stellar **testnet demo**.

The repository contains the deployment and build setup. A live release requires your Render/Neon accounts, the actual backend URL, a Windows APK build, and device verification. Do not distribute an APK that still points at localhost.

## 1. Create the free database

Create a **Free** Neon project. In **Connect**, select the branch, database and owner role, then turn **Connection pooling OFF**. Copy the direct PostgreSQL connection string into a private password manager and use it as `DATABASE_URL`. The hostname must not have the `-pooler` suffix. Keep the SSL options from the connection string; the backend verifies TLS certificates and enables supported channel binding. [Neon connection details](https://neon.com/docs/connect/connect-from-any-app)

Hima's payment processor holds session-level advisory locks while saving and submitting a transaction. Neon's pooled endpoints use transaction pooling and do not support these locks. The server rejects known pooled Neon URLs even though they use PostgreSQL's usual port 5432. Its own `pg` pool reuses up to five direct connections. [Neon pooling limitations](https://neon.com/docs/connect/connection-pooling)

The backend uses PostgreSQL directly. Neon database credentials, wallet seeds and provider tokens stay on the server. The migration creates server-only tables; the phone accesses them through the existing Express API. No Neon API key or additional mobile database SDK is needed for this setup.

## 2. Configure Render Free

The root `render.yaml` defines one Free web service with root directory `server`, Node 22, build `npm ci --include=dev && npm run build`, and start `npm run db:migrate && npm start`. Deploy the repository's updated code through a Render Blueprint, connecting the existing GitHub repository `migsrvr/hima-paiflow`.

Configuration uses:

| Setting | Value |
| --- | --- |
| `STORAGE_BACKEND` | `postgres` |
| `DATABASE_URL` | Neon direct PostgreSQL connection string; Connection pooling OFF; server only |
| `SESSION_SECRET` | A stable secret of at least 32 characters; preserve the existing value to retain current sessions |
| `HOST` | `0.0.0.0` |
| `PORT` | Render supplies this; do not copy the local port override |
| `GROQ_API_KEY`, `GROQ_MODEL` | Existing Groq settings |
| Stellar and Paiflow variables | Existing testnet wallets, flow IDs, tokens, trigger contracts and recipient overrides |

Use the updated `server/.env.example` as the complete variable reference. The local legacy checkout variables must be entered using their new `PAIFLOW_CHECKOUT_*` names in the Blueprint. Leave optional unused flow settings empty. Copy values privately into Render's environment editor; never commit `.env` or paste credentials into public logs.

Hosted mode requires PostgreSQL and a stable session secret. It does not fall back to files if the database goes offline. `/health` remains a liveness/configuration probe; `/ready` answers 200 with `{"status":"ready"}` only when storage is reachable. Render uses `/ready` for deployment health.

The Blueprint disables automatic deploys. Deploy updates manually after checks pass. Keep the same service and HTTPS address so installed APKs continue working after backend updates.

Render Free services sleep after 15 idle minutes, can take about a minute to wake, and lose local files on sleep/restart. Neon Free also scales its compute to zero while idle; its database storage persists. Hima's readiness handling covers wake-up delays. Stay on the free plans and within their usage allowances; do not enable paid add-ons. [Render Free limits](https://render.com/docs/free), [Neon Free plan](https://neon.com/pricing), [Neon scale to zero](https://neon.com/docs/introduction/scale-to-zero)

## 3. Preserve existing payment records

Before moving the same testnet wallets to the hosted API, stop the local server and keep it stopped during cutover. Back up `server/data/attempts.json` outside the generated Android folders. Existing submitted/pending attempts must retain their IDs, idempotency keys, and signed envelopes.

In a terminal with Node 22 and the server dependencies installed, set `STORAGE_BACKEND=postgres` and the private `DATABASE_URL` for that process, then run from `server`:

```powershell
npm.cmd run build
npm.cmd run db:migrate
npm.cmd run db:import -- C:\private-backups\attempts.json
```

Import is repeatable and preserves record identity. Conflicting existing records must be resolved rather than overwritten. Keep the backup private; it can contain signed transaction envelopes and user identifiers. Do not submit test payments as part of migration.

After deployment, open `https://YOUR-SERVICE.onrender.com/ready`. Confirm the flow configuration with the existing `/api/paiflow/flows` endpoint. Retain a manual database export before future migrations; free-tier automatic backups are not assumed.

Local USB development continues to use file storage when `STORAGE_BACKEND` is unset or `file`. Local and hosted databases are separate; avoid running both against the same payment state during cutover.

## 4. Build the downloadable APK on Windows

Use Windows PowerShell, the existing Windows Node dependencies, Java 17, and Android SDK. No connected phone is required:

```powershell
cd C:\Users\Miggy\Documents\Paiflow\mobile
$env:EXPO_PUBLIC_API_URL = 'https://YOUR-SERVICE.onrender.com'
npm.cmd run apk:windows
```

Replace the URL with the real deployed origin. The command rejects HTTP, IP addresses, localhost, emulator addresses and example placeholders. It applies Expo configuration and assembles the release APK directly, without ADB device selection or USB forwarding.

Outputs in `mobile/dist`:

```text
hima-demo-v1.0.1-<versionCode>.apk
hima-demo-v1.0.1-<versionCode>.apk.sha256
hima-demo-v1.0.1-<versionCode>.apk.json
```

The build inspects the packaged bundle for the selected API URL and known local server-secret values. It rejects the local HTTP policy and verifies the output's version code. The JSON file records the public URL, version and checksum; it contains no server credentials.

The launcher keeps the existing demo signing key in ignored `mobile/.credentials/hima-demo.keystore` and restores it after prebuild. Back up that directory privately before changing PCs or deleting the workspace. Existing installations can update only with the same signing identity.

Successful builds increment Android's version code using ignored `mobile/.release/version-code.json`. When building on another PC, restore that state or set `HIMA_APK_VERSION_CODE` to an integer greater than the last distributed release. Changing the visible version name in `app.json` is a separate intentional release edit.

Changing the API URL invalidates Gradle's JavaScript bundle task through a config plugin. The helper also checks the actual packaged bundle before exporting, so cached outputs cannot silently ship the USB backend address.

Upload the APK and checksum to Google Drive and enable download access for your testers. Testers allow APK installation from their browser/file manager and install the downloaded file. Future updates use another versioned APK signed with the preserved key. No app-store publishing or automatic updates are configured.

For the previous local workflow, continue using `npm.cmd run android:windows -- --usb --variant release` and `npm.cmd run usb:windows`. Do not pass `--usb` to a hosted APK build: it selects the local backend.

## 5. Verify before sharing

1. Run server typecheck, tests, build, and the PostgreSQL integration tests with `HIMA_TEST_DATABASE_URL` pointing to a disposable test database. Do not point tests at the live demo database.
2. Run mobile typecheck, lint, Jest tests, and `npm.cmd run test:release`.
3. Install the hosted APK on a second phone, unplug USB, stop your local server, and use mobile data or another Wi-Fi network.
4. Verify login, wallet lookup and AI. After Render has slept, confirm the connection banner disappears when it wakes. If unavailable, verify Retry works and local budgeting remains usable.
5. Make one controlled testnet checkout. Interrupt the response, restart the API, and reconcile the same payment. Verify the attempt survives and no second charge is created for the same idempotency key.
6. Install an updated APK over the previous version and verify local plans/session data remain available.

Readiness probes retry only the safe `/ready` GET. They never replay a payment submission. Existing one-time session renewal on 401 remains separate. Pending payment outcomes remain unknown until reconciled; successful receipts still require on-chain confirmation.

## Updating later

- **Backend code:** run checks, push the server changes to GitHub, and trigger a manual Render deployment. The installed APK keeps using the same service URL.
- **App code:** rebuild with `npm.cmd run apk:windows`, then upload and share the new APK.
- **Database schema:** back up first, deploy the compatible migration, and verify `/ready` before sharing an app that depends on it.

The root repository currently records `mobile` as a separate Git repository entry. Preserve that arrangement; changes inside `mobile` must be saved in that repository as well. It does not affect Render's `server` root or a local Windows APK build. Never include generated native directories, signing material, local payment records or environment files in an upload.

## Public portfolio demo (web app + APK)

Anyone can try Hima from a browser: the Expo web build runs on Vercel, inside a phone frame on `showcase/index.html`, against the same Render API. Payments are real Stellar **testnet** transactions.

### Demo mode (`EXPO_PUBLIC_DEMO=1`)
Set only for the hosted web build and the demo APK. It changes three things:
- **Simulated tap.** With no NFC hardware (browsers, emulators, phones without NFC), Tap to Pay simulates a tap of the registered student ID, and the scan screen says so. Phones with working NFC still read real tags.
- **PIN on the web.** The web has no biometrics, so the authorize sheet falls back to the in-app PIN `1234`. Fingerprint stays refused.
- **Nothing about payments changes.** They go through the server and Paiflow, and show as confirmed only after the ledger confirms them. Pending and failed payments still show no mascot.

### Server protection for public visitors
- **Rate limits** (`server/src/middleware/rateLimit.ts`): a request over a limit gets `429 RATE_LIMITED` with a friendly message, and the app shows it as a failed payment where nothing was charged.

  | What | Default | Setting |
  | --- | --- | --- |
  | Sign-ins | 10 per IP per hour | `RATE_SIGNIN_PER_IP_HOUR` |
  | AI questions | 20 per user and 40 per IP per hour | `RATE_AI_PER_USER_HOUR`, `RATE_AI_PER_IP_HOUR` |
  | Payments | 5 per user, 10 per IP, 100 overall per day | `RATE_PAYMENTS_PER_USER_DAY`, `RATE_PAYMENTS_PER_IP_DAY`, `RATE_PAYMENTS_PER_DAY` |

  - The per-user and overall payment quotas are counted from the database, so restarts don't reset them.
  - Retrying a payment that was already sent always passes.
  - On Render, the client IP comes from the proxy (`RENDER=true` trusts one hop; override with `TRUST_PROXY`).
- **Wallet top-up** (`walletTopUp.ts`):
  - When the shared testnet paying wallet drops below `DEMO_TOPUP_BELOW_XLM` (100), the server checks after each payment, at most once an hour.
  - It has Friendbot fund a throwaway account and merges that account into the wallet, adding about 10,000 testnet XLM.
  - `npm run wallet:topup` does the same by hand.
  - Logs show public keys and the transaction hash only.
- `GET /api/demo/status` reports the active limits and the wallet's whole XLM balance. It never includes addresses or secrets.

### 1. Backend
Deploy Render + Neon as in sections 1–3. In Render's environment editor:
- set `CORS_ORIGINS` to the web app's origin (step 2), for example `https://hima-demo.vercel.app`.
- The Blueprint's limit and top-up defaults can stay.

**Keep it awake.** Render Free sleeps after 15 idle minutes, and the first visit then waits about a minute. Point a free uptime monitor (UptimeRobot, or cron-job.org) at `https://YOUR-SERVICE.onrender.com/health` every 10 minutes. One always-on service fits within Render's 750 free instance-hours a month.

### 2. Web app on Vercel
```powershell
cd C:\Users\Miggy\Documents\Paiflow\mobile
$env:EXPO_PUBLIC_API_URL = 'https://YOUR-SERVICE.onrender.com'
npm.cmd run web:demo
npx vercel login
npx vercel deploy dist-web --prod
```
`web:demo` does the following:
- Rejects local, IP or HTTP backends.
- Turns demo mode on and never ships mock payments.
- Checks that the bundle contains the backend URL and none of the server's secret values.
- Adds the single-page-app rewrite (`vercel.json`) to `dist-web/`.

Deploying the prebuilt folder avoids building `mobile` (a separate Git repository) on Vercel. Then add the deployment's origin to `CORS_ORIGINS` on Render and redeploy the API.

### 3. Demo APK
Build as in section 4 with demo mode on, so emulators and phones without NFC can still pay:
```powershell
$env:EXPO_PUBLIC_API_URL = 'https://YOUR-SERVICE.onrender.com'
$env:EXPO_PUBLIC_DEMO = '1'
npm.cmd run apk:windows
```
Upload the APK and its `.sha256` to a GitHub Release.

### 4. Showcase page
1. Edit the four constants at the bottom of `showcase/index.html`: `APP_URL`, `APK_URL`, `APK_SHA256` and `REPO_URL`.
2. Deploy the folder with `npx vercel deploy showcase --prod`, or copy it into your portfolio.
3. On desktop it shows the live app in a 360×780 phone frame. On phones it links straight to the app.

### Verify before sharing
1. In an incognito window, sign up with a new email, build a plan, and Tap to Pay.
2. Approve with PIN 1234. **Payment confirmed** should appear with the stellar.expert link, plus the Canteen received and Auto-saved rows.
3. Ask Hima AI one question.
4. Make payments until the daily limit message appears.
5. Check `/api/demo/status` and the Render logs for `[topup]` lines.
