# tossinvest-openapi-mcp

Safe-by-default local stdio MCP server for the official Toss Securities / 토스증권 Open API.

This package is designed for developers who want read-only account, market, and order data in an MCP client, with optional order operations protected by multiple explicit safety gates.

## Safety defaults

- Uses only the official Toss Open API server: `https://openapi.tossinvest.com`
- Starts without credentials; `auth_status` reports missing configuration instead of crashing.
- Keeps OAuth access tokens in memory only.
- Redacts API keys, secrets, bearer tokens, account headers, and account numbers from tool output/errors.
- Trading is disabled by default.
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

Trading tools:

- `order_validate` — checks local gates only and never calls Toss order POST endpoints.
- `order_create` — defaults to dry-run; real execution requires all create gates.
- `order_modify` — defaults to dry-run; real execution requires all modify gates.
- `order_cancel` — defaults to dry-run; real execution requires all cancel gates.

## Endpoint mapping

| Tool | Method/path | Side effect |
| --- | --- | --- |
| `auth_status` | `POST /oauth2/token` only when credentials exist | Token check only |
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
| `order_validate` | Local gate evaluation only | No Toss order POST |
| `order_create` | `POST /api/v1/orders` | Real order only after all gates pass |
| `order_modify` | `POST /api/v1/orders/{orderId}/modify` | Real order modification only after all gates pass |
| `order_cancel` | `POST /api/v1/orders/{orderId}/cancel` | Real order cancellation only after all gates pass |

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

## Publication hygiene

- `.gitignore` excludes `.env`, `.env.*`, logs, coverage, `node_modules`, and build output.
- `.npmignore` excludes local env files, logs, coverage, internal handoff/QA notes, and local run artifacts.
- `package.json` `files` only publishes `dist`, public docs, `.env.example`, and changelog/security/license files.

## Disclaimer

This software is not investment advice and does not implement trading strategy, rebalancing, optimization, or automated trading loops. Order tools can place real financial orders only when explicitly enabled and used with valid Toss credentials; use at your own risk.
