# Hima (Paiflow)

Hima is a student allowance app: schedule-based budgeting, a Safe-to-Spend number, Kimi-powered AI suggestions, NFC tap-to-pay at mock merchants, and testnet payments through Paiflow. Android-first, React Native + TypeScript on an Expo development build.

## Source of truth

- `docs/hima-ui-spec.md`: product and UX spec (screens, flows, rules).
- `design/`: the approved UI. Read `design/README.md` first. It has the screen index, design decisions beyond the spec, contrast tokens, and the sample-data math.
- `design/screens/*.html`: one file per screen and state, inline styles. Treat these as the visual spec. Take colors, sizes, spacing, radii, copy and states from them instead of guessing. `design/screens/Foundations.html` and `Components.html` define the tokens and components.
- `design/overview.html` shows every screen side by side.

**Replicate, don't reinterpret.** The goal is a pixel-faithful React Native copy of the design files: same layout, spacing, sizes, radii, colors, copy, icons and states. Don't redesign, restyle, "improve" or simplify a screen. Port each HTML element 1:1 (a flex `div` becomes a `View` with the same flex props, `px` stays as the same dp value at 360 width, and inline styles become `StyleSheet` entries that read from `theme/`). If something can't be reproduced exactly in React Native, keep it as close as possible and say what differs.

**Check every screen against its design.** After building a screen, run it on a 360-wide Android emulator or device, screenshot it, and compare it with the matching `design/screens/*.html` opened in a browser at the same width. Fix the differences before moving on.

When the spec and the design files disagree, the design files win for visuals. The spec wins for behavior and rules. Ask if a conflict affects money or payment logic.

## Build rules

- The app lives in `mobile/`, following the structure in spec §9.
- One theme: put every token from Foundations into `mobile/theme/` (`colors.ts`, `typography.ts`, `spacing.ts`), including the added contrast and tint tokens. No hex values or font sizes inside screens.
- Build the shared components from spec §6 / `Components.html` before screens, and reuse them everywhere.
- Fonts: Plus Jakarta Sans and Inter (via `@expo-google-fonts`). Money uses tabular figures, `₱` with comma thousands, two decimals, and a true minus sign.
- Icons: `lucide-react-native`.
- Mascot images come from `mobile/assets/mascot/` (copied from `design/assets/`). Never recolor, stretch or crop through the body.
- Never show a payment as successful before it's confirmed on-chain. Pending and failed states have no mascot.
- Status is always icon + label + color.
- AI never changes the user's plan without an explicit approve. Numbers shown in AI answers come from backend calculations, not the model.
- Safe-to-Spend = wallet balance − remaining planned expenses this period − protected reserves (savings + emergency). The calculation is deterministic and lives outside the UI, with unit tests.
- Touch targets at least 44×44; support safe areas, keyboard avoidance, screen readers and reduced motion.
- The sample data in the design files is placeholder only. Wire screens to stores and services, not hardcoded values.

## Suggested build order

1. Expo scaffold, theme tokens, fonts, assets
2. Shared components (`Components.html`)
3. Onboarding: screens 01–06, including 02b and 06b
4. Tabs: 07 Home, 08 Schedule, 09 Insights, 15 Profile
5. Payment flow: 11a–11g, 12a–12c, 13a–13c, 14a–14c
6. Hima AI: 10 and 10b

Build one batch at a time and compare each screen against its design file before moving on.
