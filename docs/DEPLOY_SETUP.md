# Deploy setup: what we need for the live portfolio demo

This checklist covers going live. The full walkthrough is in `docs/HOSTED_DEMO.md`, section "Public portfolio demo".

```
Visitor ──► Showcase page (Vercel) ──iframe──► Hima web app (Vercel) ──► Hima API (Render) ──► Neon Postgres
                    └──► APK download (GitHub Releases)          └──► Paiflow + Stellar testnet + Groq
UptimeRobot ──► pings the API's /health every 10 minutes so the free server stays awake
```

## Ground rules for secrets
- Secrets never go in chat, in `EXPO_PUBLIC_*` variables, or in committed files.
  - Secrets: the Neon URL, session secret, Groq key, Stellar secret keys, Paiflow tokens and the webhook secret.
- **You** run every login command, typing `! <command>` in Claude Code. A browser window opens and the CLI keeps its own token.
- **You** paste the secret values into Render's environment editor.
- Claude only runs commands that print public keys, URLs, IDs and status.

## 1. Accounts (all free)

| Service | What it hosts | Status |
| --- | --- | --- |
| GitHub | Source code and the APK in Releases | Remote `migsrvr/hima-paiflow` is set |
| Neon | Postgres for payments and attempts | Exists, `server/.env` already has a `DATABASE_URL` |
| Render | The Hima API (`render.yaml` Blueprint) | To do |
| Vercel | The web app and the showcase page | To do |
| UptimeRobot (or cron-job.org) | Keeps Render awake | To do, no CLI, about 2 minutes in the dashboard |

## 2. CLIs to install

Installed on 2026-10-27:
- Vercel CLI 65.4.0 and neonctl 8.12.2 (npm global).
- GitHub CLI 2.103.3 (winget).
- Render CLI v2.31.0, checked against its SHA-256 and placed in `%LOCALAPPDATA%\Programs\render` on the user PATH. Open a new terminal for the PATH change to apply.

| CLI | Install (Windows) | Login (you run it) | What Claude does with it |
| --- | --- | --- | --- |
| Vercel `vercel` | `npm i -g vercel` | `! vercel login` | Deploys `mobile/dist-web` and `showcase/` with `--prebuilt`/static, sets the project names, reads deploy URLs and logs |
| Render `render` | Download `render-oss/cli` from GitHub Releases (Windows zip) and put it on PATH | `! render login` | Validates `render.yaml`, triggers deploys, reads logs and service status |
| GitHub `gh` | `winget install --id GitHub.cli` | `! gh auth login` | Pushes the repo, creates a Release with the demo APK and its SHA-256 |
| Neon `neonctl` (optional) | `npm i -g neonctl` | `! neonctl auth` | Checks the project and branch exist. Never prints the connection string. |
| Android `adb` + emulator (optional) | Android Studio and its SDK Platform-Tools | none | Installs the demo APK on an emulator for the final check |

## 3. Render environment values

The Blueprint sets these values itself:
- `NODE_ENV`, `HOST`, `STORAGE_BACKEND=postgres` and `PAIFLOW_BASE_URL`.
- The six `RATE_*` limits and `DEMO_TOPUP_BELOW_XLM`.

**You paste these** when Render asks during Blueprint creation:

| Key | Where it comes from | Note |
| --- | --- | --- |
| `DATABASE_URL` | Neon dashboard, Connect | Direct URL, pooling **off** |
| `SESSION_SECRET` | Any random string of 64+ characters | |
| `GROQ_API_KEY` | console.groq.com | |
| `STELLAR_STUDENT_SECRET` | Your testnet student wallet | Starts with `S` |
| `STELLAR_SPONSOR_SECRET` | Optional, used for the reward flow | Can be left empty for now |
| `STELLAR_MERCHANT_PUBLIC_KEY`, `STELLAR_SAVINGS_PUBLIC_KEY`, `STELLAR_EMERGENCY_PUBLIC_KEY` | Your testnet accounts | Public, starts with `G` |
| `PAIFLOW_CHECKOUT_ID`, `PAIFLOW_CHECKOUT_TOKEN`, `PAIFLOW_CHECKOUT_TRIGGER_CONTRACT`, `PAIFLOW_CHECKOUT_RECIPIENTS` | The **working XLM checkout** deployment (`37180696…`) | ⚠ Not the old `d3496d67…` one now in `server/.env`, which Paiflow rejects with 401 |
| `PAIFLOW_ALLOWANCE_*`, `PAIFLOW_REWARD_*` | Paused flows | Leave empty |
| `CORS_ORIGINS` | The Vercel web app URL, for example `https://hima-demo.vercel.app` | Not secret. Set it after step 5. |

## Status (2026-10-27)
- **Render:** `hima-demo-api` (`srv-dbg5k9afngtc738orkfg`) is at https://hima-demo-api.onrender.com.
  - It lives in project Hima-Paiflow, Production environment, region Ohio (next to Neon us-east-2).
  - It was created with the Render CLI rather than the Blueprint, using the same settings as `render.yaml`. Its secrets were copied from `server/.env` without being printed, and it has a fresh `SESSION_SECRET`.
  - Auto-deploy is off. Deploy with `render deploys create srv-dbg5k9afngtc738orkfg`.
- **Vercel:** two projects.
  - Web app: project `hima-demo`, at https://hima-demo.vercel.app.
  - Showcase page: project `hima-showcase`, at https://hima-showcase.vercel.app.
  - Redeploy the app:
    ```
    $env:EXPO_PUBLIC_API_URL='https://hima-demo-api.onrender.com'; npm.cmd run web:demo
    cd dist-web; vercel link --yes --project hima-demo; vercel deploy --prod --yes
    ```
  - `CORS_ORIGINS` on Render is `https://hima-demo.vercel.app`, with no trailing `/` or `.`.
- **Live check (2026-10-27):** passed except the AI.
  - Passed: sign-up, onboarding, demo tap, PIN, and a real testnet payment confirmed in about 8 s with the canteen and auto-save rows. The 6th payment of the day returns 429.
  - Failed: Groq rejects the AI key (401), so `GROQ_API_KEY` must be replaced locally and on Render.
- **Keep-awake pinger:** daytime only, so Hima doesn't use up the workspace's shared 750 free hours. The workspace has 3 other free services.
  - Use cron-job.org: `GET https://hima-demo-api.onrender.com/health` every 10 minutes, 08:00–24:00 Asia/Manila, about 500 hours a month.

## 4. Order of work

| # | Step | Who |
|---|---|---|
| 1 | Install the CLIs in section 2 | Claude |
| 2 | Log in: `! vercel login`, `! render login`, `! gh auth login` | **You** |
| 3 | Push the repo to GitHub (Render's Blueprint deploys from it). The `mobile/` gitlink needs sorting first, see the note below. | Claude, with your OK |
| 4 | Render dashboard → New → Blueprint → pick the repo → paste the secrets from section 3 | **You** |
| 5 | Wait for the deploy, then check `/ready`. Build the web app (`npm.cmd run web:demo`) against the Render URL and deploy it to Vercel. | Claude |
| 6 | Set `CORS_ORIGINS` on Render to the Vercel URL and redeploy | You or Claude (not a secret) |
| 7 | UptimeRobot: an HTTP monitor on `https://<render>/health` every 5–10 minutes | **You** |
| 8 | Build the demo APK (`EXPO_PUBLIC_DEMO=1`) and publish it as a GitHub Release with its SHA-256 | Claude |
| 9 | Fill in the four constants in `showcase/index.html` and deploy it to Vercel | Claude |
| 10 | Live end-to-end test: sign up, plan, demo tap, PIN 1234, confirmed testnet payment, AI answer, 6th payment refused. Then test the APK on an emulator. | Claude |

## Open issues
- **`mobile/` is a separate git repo inside this one** (a gitlink). On GitHub it shows as an empty, unclickable folder, and Render doesn't need it because Render only builds `server/`. For the portfolio's "Source on GitHub" link to show the app code, either:
  - push `mobile` as its own repo and turn the folder into a submodule, or
  - fold it into this repo.

  Decide before step 3.
- **Paiflow checkout settings:** `server/.env` currently points at deployment `d3496d67…`, which Paiflow rejects with 401. Restore the `37180696…` settings locally too, so local runs match Render.
- **Render Free:** 750 instance hours a month, enough for one service that's always on. Its filesystem is temporary, which is fine because all state lives in Neon.
