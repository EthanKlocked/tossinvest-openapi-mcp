# Security

## Supported use

This server is intended for local stdio use with the official Toss Securities Open API.

## Secrets

- Never commit real `TOSS_API_KEY` or `TOSS_SECRET_KEY` values.
- OAuth tokens are cached in memory only and are not written to disk.
- Error and tool outputs are sanitized to avoid exposing API keys, secrets, bearer tokens, sensitive account headers, and account numbers.

## Trading controls

Real order operations are disabled unless all applicable environment gates, confirmation text, amount limits, symbol policies, and request-shape checks pass. Keep defaults unchanged unless you explicitly intend real order operations.

## Reporting issues

Open a private security advisory or contact the maintainer privately if you find a vulnerability that can expose secrets/account data or bypass trading gates.
