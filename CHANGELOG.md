# Changelog

## Unreleased

- Added GET-only retry/backoff for transient Toss API 429 and 502/503/504 responses while keeping order POST requests non-retried.
- Capped `Retry-After` retry delays so oversized server hints fail quickly instead of blocking local MCP calls.
- Reduced `portfolio_snapshot` read concurrency and added additive `holdings.reason`/`holdings.error` fields so failed reads are not confused with empty accounts.
- Updated mixed-currency `portfolio_snapshot` position weights to use USD/KRW FX conversion and a cash-inclusive KRW denominator.
- Unified `portfolio_snapshot` weight denominator semantics so calculated weights use KRW-converted holdings plus cash buying power, independent of the `buyingPower` response filter, with explicit metadata when cash is incomplete.
- Documented that partial `portfolio_snapshot` responses should not be treated as complete position counts.

## 0.1.0

- Initial local stdio MCP server for the official Toss Securities Open API.
- Added read-only account, market, order, and commission tools.
- Added dry-run-first order validation/create/modify/cancel tools with environment gates, confirmation, amount limits, and symbol policy.
- Added redaction, docs, and test coverage for safe defaults.
