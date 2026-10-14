# Hima design reference

The approved UI for the Hima app. Every screen here is plain HTML with inline styles, so exact colors, sizes, spacing, copy and states can be read straight from the source. Open `overview.html` in a browser to see everything laid out; click a screen's title to open it alone.

- Claude Design canvas: https://claude.ai/artifact/Q61QthEHXmKnw1k2uotArq
- Figma (imported copy, plain frames): https://www.figma.com/design/2HC1qe8gfY1tikhGjuPge1
- Product and UX spec: `../docs/hima-ui-spec.md`

Frames are 360 px wide (Android baseline). Tall frames show the full scroll height. No Android status bar is drawn; content starts below it.

## Screens

| File | Spec screen | Notes |
|---|---|---|
| `screens/Foundations.html` | §3 | Colors, type, shape, icons, mascot usage |
| `screens/Components.html` | §6 | Buttons, inputs, badges, money, progress, rows, cards, sheet, dialog, empty state, tab bar |
| `screens/01-Splash.html` | 01 | |
| `screens/02-Login.html`, `02b-Login-Error.html` | 02 | Normal and validation-error states |
| `screens/03-Allowance.html` | 03 | Onboarding step 1 of 4 |
| `screens/04-Schedule-Setup.html` | 04 | Step 2 of 4 |
| `screens/05-Expenses.html` | 05 | Step 3 of 4 |
| `screens/06-Budget.html`, `06b-Budget-Over.html` | 06 | Plan, and plan over allowance with quick fixes |
| `screens/07-Home.html` | 07 | Dashboard |
| `screens/08-Schedule.html` | 08 | Schedule tab |
| `screens/09-Insights.html` | 09 | Insights tab |
| `screens/10-Hima-AI.html`, `10b-AI-Offline.html` | 10 | Chat with recommendation card; AI unavailable fallback |
| `screens/11a`–`11g-NFC-*.html` | 11 | Ready, Scanning, Recognized, Unknown, Unsupported, NFC off, Timeout |
| `screens/12a-Checkout.html`, `12b-Checkout-Over.html`, `12c-Checkout-Blocked.html` | 12 | Within budget, over Safe-to-Spend, not enough funds |
| `screens/13a`–`13c-Processing-*.html` | 13 | Awaiting authorization, Submitting, Awaiting confirmation |
| `screens/14a`–`14c-Result-*.html` | 14 | Confirmed, Pending, Failed (spec's "Payment Pending/Failed" statuses live here) |
| `screens/15-Profile.html` | 15 | |

## Design decisions beyond the spec

- **Filled blue buttons use Deep Sky Blue `#1678B5`.** White on `#39A9E8` is 2.6:1 and fails contrast; `#39A9E8` is for accents, icons, progress, focus rings.
- **Yellow buttons only start or confirm a payment** (Tap to Pay, Confirm & Pay, Use fingerprint). Everything else is blue.
- **Added contrast tokens** (text on tints): blue text `#10659A`, safe text `#11624F`, warning text `#8F5B00`, danger text `#A8323A`; tints: safe `#E6F4F0`, yellow `#FFF4D6`, danger `#FBEAEB`, AI `#F3F0FB`. `#D18A16` is never used for text (2.9:1).
- **Fonts:** Plus Jakarta Sans for headings, labels, buttons and money; Inter for body, supporting text and metadata. Money always uses tabular figures and a true minus sign (−).
- **Status = icon + label + color**, never color alone.
- **Icons:** Lucide (use `lucide-react-native`).
- **AI content** is always tagged "Hima AI" in purple; peso figures inside AI answers sit in a "Calculated from your wallet" box because they come from backend data, not the model.
- **Mascot poses:** wave (login, empty states, AI avatar via `mascot-face.png`), point (onboarding tips), rocket hug (confirmed payments only), rocket ride over `sky-clouds.jpg` (splash). Never on pending or failed payments.

## Sample data (placeholders, but internally consistent)

Student "Bea Reyes". Weekly allowance ₱3,000, school days Mon/Wed/Fri, "today" = Wed 14 Oct 2026.

- Plan: food ₱150 × 3 school days = ₱450, transport ₱80 × 3 = ₱240, school ₱200/week, free days ₱100 × 4 = ₱400 → planned ₱1,290. Protected: savings ₱500 + emergency ₱300 = ₱800. **Safe-to-Spend = 3,000 − 1,290 − 800 = ₱910/week** (about ₱130/day).
- **Safe-to-Spend formula:** wallet balance − remaining planned expenses this period − protected reserves.
- By Wednesday morning ₱420 is spent (₱10 under plan), wallet ₱2,580, remaining planned ₱860 → Safe-to-Spend ₱920.
- A purchase covered by today's category plan doesn't reduce Safe-to-Spend (₱85 canteen lunch in 12a). Spending beyond plan comes out of Safe-to-Spend, then the emergency reserve (12b), and can never exceed the real wallet balance (12c).
- Merchants, reference `HM-1014-0042`, tx hash and wallet address are placeholders.

## Assets

`assets/` holds the mascot renders (trimmed and resized from the original art, not altered) and the splash sky. Copy them into `mobile/assets/mascot/` and `mobile/assets/illustrations/` when scaffolding the app.
