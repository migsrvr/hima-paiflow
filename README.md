# Hima × Paiflow

Hima is an Android-first student allowance app with schedule-aware budgeting, a Safe-to-Spend balance, AI budget advice, NFC merchant checkout, and a Stellar testnet payment integration through Paiflow.

**Current stage:** functional demo with the Paiflow integration partly complete. Authentication and some analytics still use demo data; live end-to-end payment verification remains outstanding.

- **[Project documentation and feature status](docs/PROJECT_STATUS.md)** — completed work, features in progress, planned work, verification, and next steps. Updated 14 October 2026.
- [Payment integration handoff](PAIFLOW_PROGRESS.md) — detailed implementation batches and integration decisions.
- [Product and UX specification](docs/hima-ui-spec.md) — intended behavior and screen requirements.
- [Approved design reference](design/README.md) — screen index, visual rules, and sample data.
- [Backend setup and API](server/README.md).
- [Windows and Android phone setup](mobile/WINDOWS_PHONE_SETUP.md).
- [Original MVP implementation plan](mobile/HIMA_IMPLEMENTATION_PLAN.md) — planning reference; its proposed architecture and unchecked tasks are not a current completion report.

Application code lives in `mobile/`; the Express API lives in `server/`. The current AI provider is **Groq**, replacing Kimi references in older planning documents. Payments use **Stellar testnet**, and the PHP budget ledger is separate from the on-chain XLM balance.
