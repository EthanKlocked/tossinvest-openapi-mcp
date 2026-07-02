import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../dist/config.js';

test('loadConfig defaults to read-only safe mode and zero max order amounts', () => {
  const config = loadConfig({});
  assert.equal(config.hasCredentials, false);
  assert.equal(config.enableTrading, false);
  assert.equal(config.enableOrderCreate, false);
  assert.equal(config.enableOrderModify, false);
  assert.equal(config.enableOrderCancel, false);
  assert.equal(config.requireConfirmation, true);
  assert.equal(config.maxOrderKrw, 0);
  assert.equal(config.maxOrderUsd, 0);
  assert.deepEqual(config.allowedSymbols, []);
  assert.deepEqual(config.blockedSymbols, []);
});

test('loadConfig ignores TOSS_BASE_URL and always uses official Toss Open API origin', () => {
  const config = loadConfig({ TOSS_BASE_URL: 'https://example.invalid', TOSS_API_KEY: 'key', TOSS_SECRET_KEY: 'secret' });
  assert.equal(config.baseUrl, 'https://openapi.tossinvest.com');
});

test('loadConfig parses booleans, limits, account sequence, and symbol policies', () => {
  const config = loadConfig({
    TOSS_API_KEY: 'key', TOSS_SECRET_KEY: 'secret', TOSS_ACCOUNT_SEQ: '7', ENABLE_TRADING: 'true',
    ENABLE_ORDER_CREATE: 'true', REQUIRE_CONFIRMATION: 'false', MAX_ORDER_KRW: '100000', MAX_ORDER_USD: '25.50',
    ALLOWED_SYMBOLS: '005930,AAPL', BLOCKED_SYMBOLS: 'TSLA'
  });
  assert.equal(config.hasCredentials, true);
  assert.equal(config.accountSeq, 7);
  assert.equal(config.enableTrading, true);
  assert.equal(config.enableOrderCreate, true);
  assert.equal(config.requireConfirmation, false);
  assert.equal(config.maxOrderKrw, 100000);
  assert.equal(config.maxOrderUsd, 25.5);
  assert.deepEqual(config.allowedSymbols, ['005930', 'AAPL']);
  assert.deepEqual(config.blockedSymbols, ['TSLA']);
});


test('loadConfig parses configurable request timeout with safe default', () => {
  assert.equal(loadConfig({}).requestTimeoutMs, 15000);
  assert.equal(loadConfig({ TOSS_REQUEST_TIMEOUT_MS: '2500' }).requestTimeoutMs, 2500);
  assert.equal(loadConfig({ TOSS_REQUEST_TIMEOUT_MS: '-1' }).requestTimeoutMs, 15000);
});
