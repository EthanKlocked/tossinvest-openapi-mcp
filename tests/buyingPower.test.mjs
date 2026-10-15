import test from 'node:test';
import assert from 'node:assert/strict';
import { executeTool } from '../dist/tools.js';
import { loadConfig } from '../dist/config.js';
import { clearPreviewStoreForTests } from '../dist/workflow.js';

function fixture(payload, fail = false) {
  const config = loadConfig({ ENABLE_TRADING: 'true', ENABLE_ORDER_CREATE: 'true', MAX_ORDER_USD: '10000', MAX_ORDER_KRW: '1000000' });
  return { config, client: {
    async get(path) {
      if (path === '/api/v1/buying-power') {
        if (fail) throw new Error('Synthetic buying power read failure');
        return payload;
      }
      if (path.includes('market-calendar')) return { isOpen: true };
      if (path === '/api/v1/orders') return { result: { orders: [] } };
      if (path === '/api/v1/commissions') return { fee: 0 };
      if (path.endsWith('/warnings') || path === '/api/v1/price-limits') return {};
      throw new Error('Unexpected read');
    },
    async post() { assert.fail('Order POST forbidden'); }
  } };
}

for (const currency of ['USD', 'KRW']) {
  for (const [name, payload, expected, fail] of [
    ['sufficient', { result: { cashBuyingPower: '100' } }, 'pass', false],
    ['equal', { amount: 40 }, 'pass', false],
    ['insufficient', { amount: 20 }, 'blocker', false],
    ['zero', { amount: 0 }, 'blocker', false],
    ['missing', {}, 'missing', false],
    ['invalid text', { amount: 'invalid' }, 'missing', false],
    ...[true, false, [100], {}, '', '   ', null, undefined, -1, '-1', NaN, Infinity, 'Infinity', '0x10', '9'.repeat(400)].map((amount, index) => [`invalid value ${index}`, { amount }, 'missing', false]),
    ['conflicting amounts', { amount: 100, result: { cashBuyingPower: 1 } }, 'missing', false],
    ['invalid cannot fall back', { amount: true, result: { cashBuyingPower: 100 } }, 'missing', false],
    ['nested money amount', { result: { amount: { amount: '100' } } }, 'pass', false],
    ['deep wrappers', { data: { payload: { body: { cashBuyingPower: '100.50' } } } }, 'pass', false],
    ['same amounts', { amount: '100', result: { cashBuyingPower: 100 } }, 'pass', false],
    ...['availableAmount', 'buyingPower', 'cashBuyingPower', 'cashOrderableAmount', 'orderableAmount', 'availableCash', 'withdrawableAmount', 'cash', 'orderAmount', 'valuationAmount', 'evaluationAmount', 'marketValue'].map(key => [`legacy alias ${key}`, { [key]: '100' }, 'pass', false]),
    ['nested marketValue amount', { marketValue: { amount: '100' } }, 'pass', false],
    ['amountAfterCost wrapper', { amountAfterCost: { amount: '100' } }, 'pass', false],
    ['depth boundary', Array.from({ length: 8 }).reduce(payload => ({ result: payload }), { amount: '100' }), 'pass', false],
    ['depth exceeded', Array.from({ length: 9 }).reduce(payload => ({ result: payload }), { amount: '100' }), 'missing', false],
    ['nested invalid amount', { result: { amount: true } }, 'missing', false],
    ['empty amount cannot fall back', { amount: {}, result: { cashBuyingPower: 100 } }, 'missing', false],
    ['failed read', {}, 'missing', true]
  ]) test(`BUY buying power ${currency} ${name}`, async () => {
    clearPreviewStoreForTests();
    const deps = fixture(payload, fail);
    const args = { request: { symbol: currency === 'KRW' ? '000000' : 'TEST', side: 'BUY', orderType: 'LIMIT', quantity: '4', price: '10', currency } };
    const check = await executeTool('pre_trade_check', args, deps);
    const preview = await executeTool('order_preview', args, deps);
    assert.equal(check.canProceedDryRun, expected === 'pass');
    assert.equal(preview.executable, expected === 'pass');
    assert.equal(preview.gate.status, expected === 'pass' ? 'pass' : 'blocked');
    if (expected === 'blocker') {
      assert.equal(preview.cashCheck.code, 'insufficient_buying_power');
      assert.equal(preview.cashCheck.status, 'blocker');
    } else if (expected === 'pass') {
      assert.equal(preview.cashCheck.code, 'buying_power_sufficient');
      assert.equal(preview.cashCheck.status, 'pass');
    }
    if (fail) {
      assert.ok(check.dataFreshness.reads.some(item => item.source === 'buying_power' && item.ok === false));
    }
    if (expected === 'missing') {
      const code = fail ? 'buying_power_unavailable' : 'buying_power_not_calculable';
      assert.ok(check.missing.some(item => item.code === code && item.status === 'missing'));
      assert.ok(preview.gate.missing.some(item => item.code === code && item.status === 'missing'));
      assert.ok(!check.warnings.some(item => item.code === code));
      assert.equal(preview.cashCheck.status, 'missing');
      assert.equal(preview.cashCheck.code, code);
    }
  });
}

test('BUY malformed numeric coercion cannot authorize a preview', async () => {
  const args = { request: { symbol: 'TEST', side: 'BUY', orderType: 'LIMIT', quantity: '1', price: '0.5', currency: 'USD' } };
  for (const amount of [true, [100]]) {
    const deps = fixture({ amount });
    const preview = await executeTool('order_preview', args, deps);
    assert.equal(preview.executable, false);
  }
});
