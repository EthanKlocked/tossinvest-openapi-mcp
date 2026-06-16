import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateOrderGate, CONFIRMATION_TEXT } from '../dist/tradingSafety.js';
import { loadConfig } from '../dist/config.js';

test('order_validate and dry-run never execute POST operations', () => {
  const result = evaluateOrderGate('create', loadConfig({}), { dryRun: true, request: { symbol: '005930', side: 'BUY', orderType: 'LIMIT', quantity: '1', price: '70000', currency: 'KRW' } });
  assert.equal(result.shouldExecute, false);
  assert.equal(result.dryRun, true);
  assert.ok(result.failures.includes('ENABLE_TRADING must be true for real trading'));
});

test('real create requires all safety gates and respects amount limit', () => {
  const config = loadConfig({ ENABLE_TRADING: 'true', ENABLE_ORDER_CREATE: 'true', MAX_ORDER_KRW: '100000', ALLOWED_SYMBOLS: '005930' });
  const pass = evaluateOrderGate('create', config, { dryRun: false, confirmation: CONFIRMATION_TEXT, request: { symbol: '005930', side: 'BUY', orderType: 'LIMIT', quantity: '1', price: '70000', currency: 'KRW' } });
  assert.equal(pass.shouldExecute, true);
  assert.deepEqual(pass.failures, []);
  const overLimit = evaluateOrderGate('create', config, { dryRun: false, confirmation: CONFIRMATION_TEXT, request: { symbol: '005930', side: 'BUY', orderType: 'LIMIT', quantity: '2', price: '70000', currency: 'KRW' } });
  assert.equal(overLimit.shouldExecute, false);
  assert.match(overLimit.failures.join(' '), /MAX_ORDER_KRW/);
});

test('real order execution blocks non-positive quantity, price, and orderAmount values', () => {
  const config = loadConfig({ ENABLE_TRADING: 'true', ENABLE_ORDER_CREATE: 'true', MAX_ORDER_KRW: '100000', ALLOWED_SYMBOLS: '005930' });
  const base = { symbol: '005930', side: 'BUY', orderType: 'LIMIT', currency: 'KRW' };

  const zeroQuantity = evaluateOrderGate('create', config, { dryRun: false, confirmation: CONFIRMATION_TEXT, request: { ...base, quantity: '0', price: '70000' } });
  assert.equal(zeroQuantity.shouldExecute, false);
  assert.match(zeroQuantity.failures.join(' '), /quantity must be greater than 0/);

  const negativePrice = evaluateOrderGate('create', config, { dryRun: false, confirmation: CONFIRMATION_TEXT, request: { ...base, quantity: '1', price: '-1' } });
  assert.equal(negativePrice.shouldExecute, false);
  assert.match(negativePrice.failures.join(' '), /price must be greater than 0/);

  const negativeOrderAmount = evaluateOrderGate('create', config, { dryRun: false, confirmation: CONFIRMATION_TEXT, request: { ...base, orderAmount: '-100' } });
  assert.equal(negativeOrderAmount.shouldExecute, false);
  assert.match(negativeOrderAmount.failures.join(' '), /orderAmount must be greater than 0/);
});

test('blocked symbols take precedence over allowed symbols', () => {
  const config = loadConfig({ ENABLE_TRADING: 'true', ENABLE_ORDER_CREATE: 'true', MAX_ORDER_KRW: '100000', ALLOWED_SYMBOLS: '005930', BLOCKED_SYMBOLS: '005930' });
  const result = evaluateOrderGate('create', config, { dryRun: false, confirmation: CONFIRMATION_TEXT, request: { symbol: '005930', side: 'BUY', orderType: 'LIMIT', quantity: '1', price: '1', currency: 'KRW' } });
  assert.equal(result.shouldExecute, false);
  assert.match(result.failures.join(' '), /blocked/i);
});

test('modify and cancel require their operation gates and confirmation', () => {
  const modify = evaluateOrderGate('modify', loadConfig({ ENABLE_TRADING: 'true', ENABLE_ORDER_MODIFY: 'true' }), { dryRun: false, confirmation: 'wrong', request: { symbol: 'AAPL', quantity: '1', price: '10', currency: 'USD' } });
  assert.equal(modify.shouldExecute, false);
  assert.match(modify.failures.join(' '), /confirmation/);
  const cancel = evaluateOrderGate('cancel', loadConfig({ ENABLE_TRADING: 'true', ENABLE_ORDER_CANCEL: 'true' }), { dryRun: false, confirmation: CONFIRMATION_TEXT, request: { symbol: 'AAPL' } });
  assert.equal(cancel.shouldExecute, true);
});
