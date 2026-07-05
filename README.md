# tossinvest-openapi-mcp

Safe-by-default local stdio MCP server for the official Toss Securities / 토스증권 Open API.

This package is an independent developer tool and is not affiliated with, endorsed by, or sponsored by Toss Securities.

This package is designed for developers who want read-only account, market, and order data in an MCP client, with optional order operations protected by multiple explicit safety gates.

## Safety defaults

- Uses only the official Toss Open API server: `https://openapi.tossinvest.com`
- Starts without credentials; `auth_status` reports missing configuration instead of crashing.
- Keeps OAuth access tokens in memory only.
- On `401 invalid-token` data API responses, discards the cached token, requests a fresh OAuth token, and retries the original request once.
- `auth_status` separates token issuance from data endpoint reachability and reports whether a default `TOSS_ACCOUNT_SEQ` is configured.
- Redacts API keys, secrets, bearer tokens, account headers, and account numbers from tool output/errors.
- Trading is disabled by default.
- v0.2 workflow tools are safety-first and preview-based: `portfolio_snapshot → pre_trade_check → order_preview → approval → order_execute → order_status_summary`.
- `order_preview` stores preview contracts in memory only and never calls Toss order POST endpoints.
- `order_execute` is intentionally fast: it rechecks only preview/confirmation/hash/env/delegated-authority gates, submits at most one order POST, and reports timeout/network ambiguity as `unknown_execution_state` for reconciliation before any manual retry.
- Order tools default to `dryRun=true`.
- Real create/modify/cancel operations require `ENABLE_TRADING=true` plus the operation-specific gate.
- Confirmation is required by default.
- Default max order amounts are `0` KRW and `0` USD.
- `BLOCKED_SYMBOLS` takes precedence over `ALLOWED_SYMBOLS`.

## Install and run

This repository is currently distributed from GitHub source only. It has not been published to npm under an EthanKlocked-owned package.

Important: the unscoped npm name `tossinvest-openapi-mcp` is already used by a different npm package, so do not install or run that package expecting this repository's code.

Clone this repository, then install and build locally:

```bash
git clone https://github.com/EthanKlocked/tossinvest-openapi-mcp.git
cd tossinvest-openapi-mcp
npm install
npm run build
npm test
```

Run locally:

```bash
TOSS_API_KEY=... TOSS_SECRET_KEY=... node dist/index.js
```

Do not put real secrets in committed files. Prefer passing env vars from your local shell or MCP client secret manager.

## MCP client configuration example

Use the local cloned path:

```json
{
  "mcpServers": {
    "tossinvest": {
      "command": "node",
      "args": ["/absolute/path/to/cloned/tossinvest-openapi-mcp/dist/index.js"],
      "env": {
        "TOSS_API_KEY": "${TOSS_API_KEY}",
        "TOSS_SECRET_KEY": "${TOSS_SECRET_KEY}",
        "TOSS_ACCOUNT_SEQ": "${TOSS_ACCOUNT_SEQ}"
      }
    }
  }
}
```

If this project is later published to npm, use a package name owned by the maintainer, such as `@ethanklocked/tossinvest-openapi-mcp`, rather than the already-taken unscoped name.

## Environment variables

| Name | Default | Purpose |
| --- | --- | --- |
| `TOSS_API_KEY` | unset | Toss Open API client id / API key. |
| `TOSS_SECRET_KEY` | unset | Toss Open API client secret. |
| `TOSS_ACCOUNT_SEQ` | unset | Optional default account sequence for account-scoped tools. |
| `ENABLE_TRADING` | `false` | Global gate for any real order operation. |
| `ENABLE_ORDER_CREATE` | `false` | Gate for real order create. |
| `ENABLE_ORDER_MODIFY` | `false` | Gate for real order modify. |
| `ENABLE_ORDER_CANCEL` | `false` | Gate for real order cancel. |
| `REQUIRE_CONFIRMATION` | `true` | Requires exact confirmation text for real order operations. |
| `MAX_ORDER_KRW` | `0` | Maximum allowed calculated KRW order amount. |
| `MAX_ORDER_USD` | `0` | Maximum allowed calculated USD order amount. |
| `ALLOWED_SYMBOLS` | unset | Optional comma-separated allow list. |
| `BLOCKED_SYMBOLS` | unset | Optional comma-separated block list; always wins over allow list. |
| `TOSS_REQUEST_TIMEOUT_MS` | `15000` | Timeout for OAuth, read-only, and order requests. Set `0` only for local debugging to disable the timeout. |

Confirmation text for real order operations:

```text
I understand this may place a real Toss Securities order
```

## Tools

Read-only tools:

- `auth_status`
- `accounts`
- `holdings`
- `prices`
- `orderbook`
- `trades`
- `price_limits`
- `candles`
- `stock_info`
- `stock_warnings`
- `exchange_rate`
- `market_calendar`
- `orders_open`
- `orders_closed`
- `order_detail`
- `buying_power`
- `sellable_quantity`
- `commissions`

Workflow tools:

- `portfolio_snapshot` — reads holdings, KRW/USD buying power, open orders, calculable position weights, account/accountSeq state, warning flags, and partial failures.
- `pre_trade_check` — separate read/check layer for candidate orders; returns `canProceedDryRun`, `realOrderBlockedByDefault`, `checks`, `warnings`, `blockers`, `missing`, `estimate`, and `dataFreshness`.
- `order_preview` — creates an in-memory preview contract; returns `previewId`, `requestHash`, `ttlSeconds`, `expiresAt`, exact `confirmationText`, estimated amount/fee/cash/quantity checks, gate status, risk flags, and calculability notes. It never calls order POST endpoints. Default TTL: 90 seconds; max accepted TTL: 300 seconds.
- `order_execute` — fast preview-based submission; requires `previewId`, matching `requestHash`, exact confirmation (`I approve this exact Toss order preview`), unexpired preview, env gates, and optional delegated-authority bounds. It does not run `pre_trade_check` in the hot path and does not add automatic order POST retry.
- `order_status_summary` — read-only reconciliation summary for open/recently closed orders, state counts, filled/partial/canceled/rejected/replace-related states when present, and caveats for disappeared/replaced orders.

Trading tools:

- `order_validate` — checks local gates only and never calls Toss order POST endpoints.
- `order_create` — defaults to dry-run; real execution requires all create gates.
- `order_modify` — defaults to dry-run; real execution requires all modify gates.
- `order_cancel` — defaults to dry-run; real execution requires all cancel gates. When `ALLOWED_SYMBOLS` or `BLOCKED_SYMBOLS` is configured, real cancellation also requires caller-supplied `request.symbol` so local symbol policy can be evaluated before the POST. The server does not fetch order details before cancel because this would add a second API dependency and the official detail payload shape should be confirmed by users with live credentials before relying on it for safety.

## Auth status and account selection

`auth_status` intentionally separates OAuth token issuance from actual data API reachability:

- `configured`: required credential environment variables are present.
- `tokenAvailable`: `POST /oauth2/token` succeeded.
- `dataApiReachable`: a real read-only data check against `GET /api/v1/accounts` succeeded.
- `authenticated`: `true` only when both token issuance and the data endpoint check succeed.
- `accountSeqConfigured`: `true` when `TOSS_ACCOUNT_SEQ` is set.
- `accountSeqRequiredForAccountTools`: `true`; account-scoped tools need either a per-call `accountSeq` or `TOSS_ACCOUNT_SEQ`.

Most market-data tools such as `prices`, `orderbook`, `trades`, and `stock_info` do not require `accountSeq`. Account-scoped tools such as `holdings`, `orders_open`, `orders_closed`, `order_detail`, `buying_power`, `sellable_quantity`, `commissions`, and real/dry-run order tools require `accountSeq` via the tool arguments or `TOSS_ACCOUNT_SEQ`.

## Endpoint mapping

| Tool | Method/path | Side effect |
| --- | --- | --- |
| `auth_status` | `POST /oauth2/token`; then `GET /api/v1/accounts` when token issuance succeeds | Token/data reachability check only |
| `accounts` | `GET /api/v1/accounts` | Read-only |
| `holdings` | `GET /api/v1/holdings` | Read-only |
| `prices` | `GET /api/v1/prices` | Read-only |
| `orderbook` | `GET /api/v1/orderbook` | Read-only |
| `trades` | `GET /api/v1/trades` | Read-only |
| `price_limits` | `GET /api/v1/price-limits` | Read-only |
| `candles` | `GET /api/v1/candles` | Read-only |
| `stock_info` | `GET /api/v1/stocks` | Read-only |
| `stock_warnings` | `GET /api/v1/stocks/{symbol}/warnings` | Read-only |
| `exchange_rate` | `GET /api/v1/exchange-rate` | Read-only |
| `market_calendar` | `GET /api/v1/market-calendar/KR` or `GET /api/v1/market-calendar/US` | Read-only |
| `orders_open` | `GET /api/v1/orders?status=OPEN` | Read-only |
| `orders_closed` | `GET /api/v1/orders?status=CLOSED` | Read-only |
| `order_detail` | `GET /api/v1/orders/{orderId}` | Read-only |
| `buying_power` | `GET /api/v1/buying-power` | Read-only |
| `sellable_quantity` | `GET /api/v1/sellable-quantity` | Read-only |
| `commissions` | `GET /api/v1/commissions` | Read-only |
| `portfolio_snapshot` | Composes `GET /api/v1/holdings`, `GET /api/v1/buying-power`, and `GET /api/v1/orders?status=OPEN` | Read-only workflow snapshot |
| `pre_trade_check` | Composes market calendar, warnings, price limits, buying power/sellable quantity, commissions, and open orders | Read/check only; no order POST |
| `order_preview` | Local preview contract plus read/check calls | No Toss order POST; memory-only preview storage |
| `order_execute` | `POST /api/v1/orders` only after preview/confirmation/hash/env gates pass | At most one order POST; no automatic order POST retry |
| `order_status_summary` | `GET /api/v1/orders?status=OPEN` and `GET /api/v1/orders?status=CLOSED` | Read-only reconciliation |
| `order_validate` | Local gate evaluation only | No Toss order POST |
| `order_create` | `POST /api/v1/orders` | Real order only after all gates pass |
| `order_modify` | `POST /api/v1/orders/{orderId}/modify` | Real order modification only after all gates pass |
| `order_cancel` | `POST /api/v1/orders/{orderId}/cancel` | Real order cancellation only after all gates pass |

## v0.2 workflow examples

Recommended safety-first flow:

```text
portfolio_snapshot → pre_trade_check → order_preview → user/delegated approval → order_execute → order_status_summary
```

`portfolio_snapshot` example:

```json
{
  "accountSeq": 1,
  "currencies": ["KRW", "USD"],
  "limit": 50
}
```

`pre_trade_check` example. This is a separate read/check tool and is intentionally not forced into `order_execute`'s hot path:

```json
{
  "accountSeq": 1,
  "request": {
    "symbol": "005930",
    "side": "BUY",
    "orderType": "LIMIT",
    "quantity": "1",
    "price": "70000",
    "currency": "KRW"
  },
  "delegatedAuthority": {
    "remainingAmount": 100000,
    "expiresAt": "2026-07-05T15:00:00.000Z"
  }
}
```

`order_preview` example. It never calls Toss order POST endpoints and returns `previewId`, `requestHash`, TTL, and exact confirmation text:

```json
{
  "accountSeq": 1,
  "ttlSeconds": 90,
  "request": {
    "symbol": "005930",
    "side": "BUY",
    "orderType": "LIMIT",
    "quantity": "1",
    "price": "70000",
    "currency": "KRW"
  }
}
```

`order_execute` example. Copy the `previewId`, `requestHash`, and exact `confirmationText` from the preview response:

```json
{
  "previewId": "preview_...",
  "requestHash": "<sha256-from-preview>",
  "confirmation": "I approve this exact Toss order preview"
}
```

If an order POST times out or returns an ambiguous network failure, `order_execute` returns `status: "unknown_execution_state"` and directs callers to reconcile with `order_status_summary`/`order_detail` before any manual retry. The server does not automatically retry order POSTs.

`order_status_summary` example:

```json
{
  "accountSeq": 1,
  "symbol": "005930",
  "limit": 50
}
```

## Trading safety examples

Dry-run validation:

```json
{
  "request": {
    "symbol": "005930",
    "side": "BUY",
    "orderType": "LIMIT",
    "quantity": "1",
    "price": "70000",
    "currency": "KRW"
  }
}
```

Real create requires all of the following:

```bash
ENABLE_TRADING=true
ENABLE_ORDER_CREATE=true
REQUIRE_CONFIRMATION=true
MAX_ORDER_KRW=100000
ALLOWED_SYMBOLS=005930
```

And the tool call must include:

```json
{
  "dryRun": false,
  "confirmation": "I understand this may place a real Toss Securities order",
  "request": {
    "symbol": "005930",
    "side": "BUY",
    "orderType": "LIMIT",
    "quantity": "1",
    "price": "70000",
    "currency": "KRW"
  }
}
```

## Official endpoint mapping

The implementation is intentionally thin and maps tools to official Toss Open API paths:

- OAuth: `POST /oauth2/token`
- Market/account/order data: `/api/v1/...` paths from `https://openapi.tossinvest.com/openapi-docs/latest/openapi.json`
- Order create/modify/cancel: official `/api/v1/orders` POST paths only, guarded locally before any POST is attempted.

## Development

```bash
npm install
npm test
npm run lint
npm run audit:prod
```

The required test suite uses Node's built-in test runner and mocked fetch calls. It does not require real Toss credentials and does not call live order endpoints.

### Opt-in read-only integration smoke test

After configuring your own Toss credentials locally, you can run a safe read-only smoke test:

```bash
TOSS_API_KEY=... TOSS_SECRET_KEY=... npm run smoke:readonly
```

Optional account-scoped checks can use `TOSS_ACCOUNT_SEQ`, but the default smoke path only calls read-only tools that do not create, modify, or cancel orders: `auth_status`, `accounts`, and `market_calendar`. If `TOSS_API_KEY` or `TOSS_SECRET_KEY` is missing, the command exits successfully with a `SKIP` message and makes no Toss API request. Output is passed through the same redaction helpers used by the MCP server.

### Timeout/retry policy

This server applies a configurable request timeout to OAuth, read-only calls, and order calls. It intentionally does not add broad automatic retries: read-only retry policy should be based on observed Toss API behavior, and order POST retries are disabled unless official idempotency guarantees are documented. The only automatic retry remains the existing one-time token refresh/retry for a `401 invalid-token` response.

## Release checklist

Before publishing or tagging a release:

1. Verify package ownership and name availability; do not publish the unscoped `tossinvest-openapi-mcp` name.
2. Run `npm test`, `npm run lint`, `npm run audit:prod`, and `npm pack --dry-run`.
3. Confirm the dry-run tarball includes only runtime files (`dist/` JavaScript/declarations without source maps), `scripts/smoke-readonly.mjs`, `README.md`, `LICENSE`, `.env.example`, and package metadata.
4. Re-scan docs for secrets, account numbers, local paths, private workflow notes, or investment advice/automation claims.
5. Publish only after explicit maintainer approval.

## Publication hygiene

- `.gitignore` excludes `.env`, `.env.*`, logs, coverage, `node_modules`, and build output.
- `.npmignore` excludes local env files, logs, coverage, internal handoff/QA notes, and local run artifacts.
- `package.json` `files` only publishes `dist`, public docs, `.env.example`, and changelog/security/license files.

## Disclaimer

This software is not investment advice and does not implement trading strategy, rebalancing, optimization, or automated trading loops. Order tools can place real financial orders only when explicitly enabled and used with valid Toss credentials; use at your own risk.
