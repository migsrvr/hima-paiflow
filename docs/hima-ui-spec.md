# Hima — Mobile UI/UX Design Documentation

- **Version:** 2.0
- **Platform:** React Native + TypeScript
- **Development:** Expo Development Build
- **Primary device:** Android
- **Design inspiration:** Tarsi-style budget tracker clarity, modern fintech UI, friendly mascot-based branding
- **Brand tagline:** Your allowance, made smarter.

## 1. Design Overview

Hima is a student-focused financial application that helps users manage their allowance using university schedule-based budgeting, Safe-to-Spend calculations, Kimi AI recommendations, NFC checkout, and automated testnet payment workflows through Paiflow.

The UI should be modern, inviting, polished, and easy to navigate.

Unlike a traditional corporate banking interface, Hima should have a friendly personality through its tiger-and-rocket mascot. However, the application must still communicate important financial data with clarity and professionalism.

### Core Design Goals

- Display financial information clearly and immediately.
- Make Safe-to-Spend the most recognizable feature.
- Minimize friction during initial budgeting setup.
- Provide intuitive NFC tap-to-pay interactions.
- Integrate Kimi AI without overwhelming the interface.
- Maintain a consistent visual system across all screens.
- Provide clear payment status and error handling.
- Produce a polished, production-inspired interface without requiring a Figma-first workflow.

### Design Personality

Hima should feel:

- Friendly but trustworthy
- Youthful but not childish
- Clean and modern
- Encouraging rather than judgmental
- Intelligent but understandable
- Colorful without being visually cluttered

## 2. Brand Identity

### 2.1 Application Name
Hima

### 2.2 Official Tagline
Your allowance, made smarter.

### 2.3 Mascot Identity

The official Hima mascot is the user-provided tiger-like character with:

- Yellow-and-black fur
- Blue eyes
- Dark styled hair
- A playful expression
- A golden rocket
- Bright blue sky and cloud imagery

The mascot represents momentum, optimism, guidance, and progress toward financial goals.

### 2.4 Mascot Usage

| Context | Usage |
|---|---|
| Splash Screen | Featured character with Hima branding. |
| Onboarding | Introduces budgeting concepts and assists new users. |
| Dashboard | Small contextual mascot illustrations and encouragement. |
| Kimi Assistant | Acts as the visual personality of the AI financial companion. |
| Budget Warnings | Appears with helpful, neutral explanations. |
| Payment Success | Celebrates verified successful transactions. |
| Empty States | Encourages the user to add expenses, set preferences, or begin tracking. |

Design rule: The mascot should support content, not compete with essential payment or financial information.

Do not stretch, recolor, or substantially alter the original mascot artwork without an approved variant. Create optimized crops and transparent derivatives where necessary.

## 3. Visual Design System

### 3.1 Primary Color Palette

**Brand colors**
- Primary Sky Blue: `#39A9E8`
- Deep Sky Blue: `#1678B5`
- Rocket Yellow: `#FFC83D`
- Dark Navy: `#19354A`
- Cloud White: `#FFFFFF`

**Background and surface colors**
- Main Background: `#F5FAFE`
- Secondary Background: `#EAF5FC`
- Card Surface: `#FFFFFF`
- Muted Surface: `#EDF2F6`
- Borders: `#DFE9F0`

**Typography colors**
- Primary Text: `#19354A`
- Secondary Text: `#5D7484`
- Disabled Text: `#9AACB8`

**Semantic colors**
- Safe/Success: `#18856E`
- Warning: `#D18A16`
- Danger: `#CA4B52`
- AI Accent: `#7359BF`

### 3.2 Color Usage

Sky blue serves as the primary interactive color across navigation, selected states, and regular buttons.

Yellow is reserved for distinctive brand elements, mascot-related surfaces, and important primary actions such as Tap to Pay.

Dark navy provides strong contrast for financial information.

Green communicates healthy spending and confirmed positive status.

Purple distinguishes Kimi AI recommendations from standard financial calculations.

Red should be used only for important problems such as insufficient funds or failed payments.

Use dark navy text on yellow surfaces. Do not rely on colors alone to communicate payment status.

### 3.3 Typography

- Primary Font: Plus Jakarta Sans
- Secondary Font: Inter

Suggested hierarchy:

- Hero Financial Figure: 36–40px, Bold
- Page Heading: 26–30px, Bold
- Section Heading: 20px, Semibold
- Card Heading: 16–18px, Semibold
- Standard Body: 14–16px, Regular
- Supporting Text: 12–13px, Regular
- Small Metadata: 11–12px, Medium

Use tabular figures for money amounts.

### 3.4 Layout Standards

- Standard Screen Padding: 20px
- Card Padding: 16–20px
- Card Border Radius: 20px
- Primary Button Radius: 16px
- Input Radius: 14px
- Standard Button Height: 52–56px
- Minimum Touch Target: 44×44px
- Standard Section Gap: 24px
- Component Spacing Scale: 4, 8, 12, 16, 20, 24, 32px

Use generous whitespace, subtle shadows, and clear information hierarchy.
Avoid excessive gradients, decorative borders, or dense charts.

## 4. Navigation Structure

### 4.1 First-Time Onboarding
Splash Screen → Login/Register → Allowance Setup → University Schedule → Expense Preferences → Initial Budget Calculation → Budget Confirmation → Home Dashboard

### 4.2 Returning User
Splash Screen → Session Validation → Home Dashboard

### 4.3 NFC Payment Flow
Home Dashboard → Tap to Pay → NFC Scanner → Merchant Recognition → Checkout → Safe-to-Spend Validation → Payment Authorization → Processing → Payment Result → Recalculated Dashboard

### 4.4 AI Recommendation Flow
Dashboard → Hima AI Insights → Recommendation Details → Review Budget Changes → Confirm Adjustments → Updated Budget

### 4.5 Main Bottom Navigation

**Home**
- Wallet overview
- Safe-to-Spend
- Upcoming expenses
- NFC payment action
- AI insights

**Schedule**
- University attendance schedule
- Daily allowance plan
- Upcoming financial commitments

**Insights**
- Spending analytics
- Category breakdown
- Transaction history
- AI financial recommendations

**Profile**
- Account preferences
- Allowance settings
- AI automation settings
- Wallet/testnet settings
- Security

The AI Assistant should be accessible through a prominent dashboard entry point and contextual recommendation cards.

## 5. Detailed Screen Specifications

### Screen 01 — Splash Screen
**Purpose:** Introduce the Hima brand.

Components: Hima mascot · Hima wordmark · Tagline · Minimal loading indicator

Design: Sky blue and cloud-inspired background · Centered mascot illustration · Simple visual composition

Logic: Check authentication state · Check onboarding completion · Redirect automatically

### Screen 02 — Authentication
**Purpose:** User login and registration.

Components: Welcome message · Small mascot illustration · Email field · Password field · Login/Register button · Forgot password · Validation errors

Design: White background · Blue CTA · Rounded input fields · Clear authentication states

### Screen 03 — Allowance Setup
**Purpose:** Collect initial financial preferences.

Components: Daily/Weekly allowance segmented selector · Large numeric allowance input · Allowance period settings · Continue button · Progress indicator

UX rules:
- Financial values must be entered manually during first-time setup.
- Display PHP currency formatting.
- Prevent negative and invalid values.
- Explain what daily and weekly allowances mean.

### Screen 04 — University Schedule
**Purpose:** Configure attendance days.

Components: Seven-day interactive selector · Selected school-day cards · Optional class start/end times · Schedule summary · Continue button

Design: Calendar-style weekday cards · Blue selected states · Yellow accent for upcoming school days · Small mascot guidance illustration

### Screen 05 — Expense Setup
**Purpose:** Gather manually estimated expenses.

Fields: Food per university day · Transportation per university day · School-related expenses · Non-university-day expenses · Emergency reserve · Savings allocation

UX rules:
- Clearly indicate whether an expense is daily, per school day, or weekly.
- Show numeric keyboards.
- Allow students to return and edit amounts.
- Include a short explanation that Hima can recommend adjustments later.

### Screen 06 — Budget Calculation
**Purpose:** Generate the student's initial financial plan.

Components: Total allowance · Expected spending breakdown · Protected reserves · Schedule-adjusted daily budgets · Initial Safe-to-Spend amount · Category visualizations · Edit Preferences · Confirm Plan

Design: Strong main summary card · Simple horizontal category progress indicators · Minimal chart clutter · Green Safe-to-Spend highlight

Behavior:
- Use deterministic calculation logic.
- Explain where estimated amounts came from.
- Warn if planned expenses exceed allowance.
- Allow the user to revise inputs before confirming.

### Screen 07 — Home Dashboard
**Purpose:** Primary financial overview.

Recommended visual hierarchy:
- **Header:** Greeting · Current date · Profile avatar · Notification icon
- **Hero card:** Available wallet balance · Safe-to-Spend amount · Current budget period · Financial outlook
- **Primary action:** Large yellow Tap to Pay button with NFC icon
- **Schedule summary:** Upcoming university day · Expected upcoming expenses · Daily spending recommendation
- **Hima AI card:** Brief AI observation · Suggested improvement · Ask Hima action
- **Budget categories:** Food · Transportation · School · Savings · Other expenses
- **Recent transactions:** Merchant · Date · Amount · Status

Design rule: Safe-to-Spend should be visually prioritized without hiding the actual wallet balance or testnet status.

### Screen 08 — Schedule Screen
**Purpose:** Display the university-based financial plan.

Components: Weekly calendar · School-day indicators · Daily budget cards · Planned food/transport expenses · Daily spending status · Edit schedule

Interactions:
- Tap a day to inspect expenses.
- Navigate between weeks.
- Edit planned school days.
- Recalculate projections when approved schedule changes occur.

### Screen 09 — Analytics & Insights
**Purpose:** Show spending behavior.

Components: Weekly/monthly filtering · Category spending distribution · Recent transactions · Budget utilization · Trend graph · AI summary cards · Suggested adjustments

Design: Clean cards · Minimal charts · Readable labels · Purple accent for AI-generated information

### Screen 10 — Hima AI Assistant
**Purpose:** Conversational financial guidance powered by Kimi.

Components: Mascot avatar · Message bubbles · Chat input · Suggested prompts · Budget recommendation cards · Approve/Reject recommendation controls

Suggested questions:
- Can I afford ₱150 today?
- Will my money last until Friday?
- Why do I overspend on Wednesdays?
- Can you improve my weekly budget?
- How much should I reserve for transportation?

UX requirements:
- Clearly identify AI-generated advice.
- Display numerical calculations from verified backend data.
- Require approval before changing financial preferences.
- Provide graceful fallback when the AI service is unavailable.

### Screen 11 — NFC Scanner
**Purpose:** Scan the mock merchant tag.

Components: Large NFC icon · Animated scan rings · Instruction text · Cancel action · Scanning status

States: Ready · Scanning · Merchant Recognized · Unknown Tag · Unsupported Tag · NFC Disabled · Timeout

Demo behavior:
- Detect a readable student-ID tag.
- Associate the allowed demo identifier with a mock merchant.
- Do not modify the student ID.
- Do not automatically execute a payment.

### Screen 12 — Merchant Checkout
**Purpose:** Review the payment.

Components: Merchant identity · Merchant category · Payment amount · Available funds · Safe-to-Spend · Estimated budget after purchase · Hima AI financial insight · Confirm/Cancel controls

Budget states:
- **Within Budget:** Normal confirmation.
- **Exceeds Safe-to-Spend:** Warning with impact explanation and controlled override when permitted.
- **Insufficient Actual Funds:** Payment blocked.

Design: Use clear transaction details rather than excessive visual effects.

### Screen 13 — Payment Processing
**Purpose:** Display transaction progress.

Components: Processing animation · Merchant name · Amount · Payment reference · Status description

Statuses: Awaiting Authorization · Submitting Payment · Awaiting Confirmation · Payment Pending · Payment Failed

Success must not be displayed until the payment is verified.

### Screen 14 — Payment Result
**Purpose:** Show confirmed transaction outcome.

Components: Success, failure, or pending illustration · Merchant · Payment amount · Transaction reference · Transaction hash when available · View on Explorer action · Return to Dashboard

Visual behavior:
- Short mascot celebration on confirmed success
- Simple error illustration on failure
- Non-celebratory indicator for pending status

### Screen 15 — Profile & Settings
Components: Student profile · Allowance preferences · University schedule · Expense categories · Manual/AI recommendation mode · Wallet connection · Notification settings · Security options · Logout

## 6. Reusable Components

**UI components:** `HimaButton` · `HimaInput` · `HimaCard` · `HimaHeader` · `HimaBottomSheet` · `HimaBadge` · `HimaModal` · `HimaEmptyState`

**Finance components:** `WalletBalanceCard` · `SafeToSpendCard` · `BudgetCategoryCard` · `MoneyDisplay` · `SpendingProgress` · `TransactionRow` · `BudgetBreakdownCard`

**Schedule components:** `WeekdaySelector` · `SchoolDayCard` · `DailyBudgetCard` · `UpcomingExpenseCard`

**AI components:** `HimaAssistantCard` · `AIInsightCard` · `AIChatBubble` · `AIRecommendationSheet`

**Payment components:** `NFCScanner` · `MerchantSummary` · `PaymentReview` · `PaymentStatus` · `PaymentReceipt`

All agents must reuse these components and the centralized theme tokens.

## 7. Animation Guidelines

- Navigation transitions: 200–300ms
- Button feedback: light scale or opacity animation
- Financial number updates: subtle transitions
- NFC scan: repeating pulse animation
- AI insight reveal: simple fade/slide
- Payment processing: neutral animated progress
- Confirmed payment: short success animation and optional haptic feedback

Animations should never delay important user actions or misrepresent transaction status.
Support reduced-motion preferences.

## 8. Responsive Design

- Android-first mobile implementation
- Adapt to narrow and large phone widths
- Use safe-area insets
- Support scrollable content
- Adjust for the on-screen keyboard
- Support dynamic type and screen readers
- Maintain readable touch targets
- Keep financial values visible without truncation when possible

## 9. Recommended Frontend Structure

```
mobile/
├── app/
│   ├── (auth)/
│   ├── (onboarding)/
│   ├── (tabs)/
│   ├── payment/
│   └── assistant/
├── components/
│   ├── ui/
│   ├── finance/
│   ├── schedule/
│   ├── ai/
│   └── payment/
├── assets/
│   ├── mascot/
│   ├── icons/
│   └── illustrations/
├── theme/
│   ├── colors.ts
│   ├── typography.ts
│   └── spacing.ts
├── hooks/
├── services/
├── stores/
├── types/
└── utils/
```

## 10. Reference and Implementation Rules

Tarsi serves as inspiration for financial information hierarchy, quick expense comprehension, and visually clean tracking experiences.

Open-source React Native finance applications may be used for component and screen structure references, subject to repository licenses.

Agents must not reproduce proprietary branding, logos, or exact copyrighted screen artwork.

Agent UI rules:

- One centralized design system
- No hardcoded per-screen color palettes
- Shared reusable components
- Consistent spacing and typography
- Mascot assets loaded from the approved source
- Accurate financial labels and calculations
- Functional loading, empty, and error states
- No fake success states for payments

## 11. Final UI Direction

Hima should feel like a real, friendly financial product.

The mascot gives the experience a recognizable personality, while the dashboard communicates financial safety and clarity.

The interface should prioritize Safe-to-Spend, schedule-based planning, AI guidance, and seamless NFC checkout.

**Design identity:** Sky-blue fintech interface + golden accents + friendly tiger mascot + clean financial data + intelligent spending guidance.

Hima — Your allowance, made smarter.
