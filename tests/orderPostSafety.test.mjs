import test from 'node:test';
import assert from 'node:assert/strict';
import { executeTool } from '../dist/tools.js';
import { TossInvestClient } from '../dist/tossClient.js';
import { loadConfig } from '../dist/config.js';
import { CONFIRMATION_TEXT } from '../dist/tradingSafety.js';

test('order_create default dry-run makes zero Toss POST calls', async () => {
  const calls = [];
  const config = loadConfig({ TOSS_API_KEY: 'key', TOSS_SECRET_KEY: 'secret', TOSS_ACCOUNT_SEQ: '1' });
  const client = new TossInvestClient(config, async (input, init) => {
    calls.push({ input: String(input), method: init?.method });
    if (String(input).endsWith('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 });
    return new Response(JSON.stringify({ orderId: 'should-not-happen' }), { status: 200 });
  });
  const result = await executeTool('order_create', { request: { symbol: '005930', quantity: '1', price: '1', currency: 'KRW' } }, { client, config });
  assert.equal(result.shouldExecute, false);
  assert.equal(calls.length, 0);
});

test('order_create performs official POST only when all gates pass', async () => {
  const calls = [];
  const config = loadConfig({ TOSS_API_KEY: 'key', TOSS_SECRET_KEY: 'secret', TOSS_ACCOUNT_SEQ: '1', ENABLE_TRADING: 'true', ENABLE_ORDER_CREATE: 'true', MAX_ORDER_KRW: '1000', ALLOWED_SYMBOLS: '005930' });
  const client = new TossInvestClient(config, async (input, init) => {
    calls.push({ input: String(input), method: init?.method, body: init?.body });
    if (String(input).endsWith('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 });
    return new Response(JSON.stringify({ orderId: 'created' }), { status: 200 });
  });
  const result = await executeTool('order_create', { dryRun: false, confirmation: CONFIRMATION_TEXT, request: { symbol: '005930', side: 'BUY', orderType: 'LIMIT', quantity: '1', price: '1', currency: 'KRW' } }, { client, config });
  assert.deepEqual(result, { orderId: 'created' });
  assert.equal(calls[0].input, 'https://openapi.tossinvest.com/oauth2/token');
  assert.equal(calls[1].input, 'https://openapi.tossinvest.com/api/v1/orders');
  assert.equal(calls[1].method, 'POST');
});

test('order_create rejects non-LIMIT order types even when gates pass', async () => {
  const calls = [];
  const config = loadConfig({ TOSS_API_KEY: 'key', TOSS_SECRET_KEY: 'secret', TOSS_ACCOUNT_SEQ: '1', ENABLE_TRADING: 'true', ENABLE_ORDER_CREATE: 'true', MAX_ORDER_KRW: '1000', ALLOWED_SYMBOLS: '005930' });
  const client = new TossInvestClient(config, async (input, init) => {
    calls.push({ input: String(input), method: init?.method, body: init?.body });
    return new Response(JSON.stringify({ orderId: 'should-not-happen' }), { status: 200 });
  });
  const result = await executeTool('order_create', { dryRun: false, confirmation: CONFIRMATION_TEXT, request: { symbol: '005930', side: 'BUY', orderType: 'MARKET', quantity: '1', price: '1', currency: 'KRW' } }, { client, config });
  assert.equal(result.shouldExecute, false);
  assert.match(result.failures.join('\n'), /orderType must be LIMIT/);
  assert.equal(calls.length, 0);
});
