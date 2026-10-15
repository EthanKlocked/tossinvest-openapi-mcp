import test from 'node:test';
import assert from 'node:assert/strict';
import { executeTool } from '../dist/tools.js';
import { loadConfig } from '../dist/config.js';
import { clearPreviewStoreForTests } from '../dist/workflow.js';

const request = { symbol: 'TEST', side: 'SELL', orderType: 'LIMIT', quantity: '4', price: '10', currency: 'USD' };
function fixture(payload) {
  const calls = [];
  const config = loadConfig({ ENABLE_TRADING: 'true', ENABLE_ORDER_CREATE: 'true', MAX_ORDER_USD: '10000' });
  const client = {
    async get(path, options) {
      calls.push({ path, options });
      if (path === '/api/v1/sellable-quantity') return payload;
      if (path.includes('market-calendar')) return { isOpen: true };
      if (path === '/api/v1/buying-power') return { result: { cashBuyingPower: 1000 } };
      if (path === '/api/v1/orders') return { result: { orders: [] } };
      if (path.endsWith('/warnings')) return {};
      if (path === '/api/v1/price-limits') return {};
      if (path === '/api/v1/commissions') return { fee: 0 };
      throw new Error('Unexpected read');
    },
    async post() { assert.fail('Order POST forbidden'); }
  };
  return { client, config, calls };
}

const cases = [];
for (const [shape, wrap] of Object.entries({ flat: x => x, result: x => ({ result: x }), data: x => ({ data: x }), payload: x => ({ payload: x }), body: x => ({ body: x }), multiple: x => ({ result: { data: { payload: { body: x } } } }) })) {
  for (const value of [8, '8', 4, '4', 2, '2', 0, '0', 4.5, '4.5']) cases.push([`${shape} ${JSON.stringify(value)}`, wrap({ sellableQuantity: value }), Number(value) >= 4 ? 'pass' : 'blocker']);
  for (const [name, value] of [['negative', -1], ['NaN', NaN], ['infinite', Infinity], ['empty', ''], ['blank', '  '], ['boolean', true], ['object', {}], ['array', [8]], ['null', null], ['undefined', undefined], ['hex', '0x10'], ['text', 'eight']]) cases.push([`${shape} invalid ${name}`, wrap({ sellableQuantity: value }), 'missing']);
}
for (const alias of ['quantity', 'qty', 'orderQuantity']) cases.push([`legacy ${alias}`, { [alias]: '8' }, 'pass']);
cases.push(
  ['absent', {}, 'missing'], ['amount is not quantity', { amount: 1000 }, 'missing'],
  ['nested cash is not quantity', { result: { cashBuyingPower: 1000 } }, 'missing'],
  ['holdings not used', { holdings: [{ quantity: 1000 }] }, 'missing'],
  ['conflicting aliases', { sellableQuantity: 8, quantity: 2 }, 'missing'],
  ['conflicting wrappers', { result: { sellableQuantity: 8 }, data: { sellableQuantity: 2 } }, 'missing'],
  ['invalid alias cannot fall back', { sellableQuantity: '', quantity: 8 }, 'missing'],
  ['matching aliases', { sellableQuantity: '8', quantity: 8 }, 'pass'],
  ['matching wrappers', { sellableQuantity: 8, result: { sellableQuantity: '8' } }, 'pass']
);
for (const [name, payload, status] of cases) test(`sellable ${name}`, async () => {
  clearPreviewStoreForTests();
  const deps = fixture(payload);
  const args = { accountSeq: 7, request };
  const direct = await executeTool('sellable_quantity', { accountSeq: 7, symbol: request.symbol }, deps);
  assert.deepEqual(direct, payload);
  const check = await executeTool('pre_trade_check', args, deps);
  const preview = await executeTool('order_preview', args, deps);
  assert.equal(check.canProceedDryRun, status === 'pass');
  assert.equal(preview.executable, status === 'pass');
  assert.equal(preview.gate.status, status === 'pass' ? 'pass' : 'blocked');
  assert.equal(preview.quantityCheck.status, status);
  const reads = deps.calls.filter(x => x.path === '/api/v1/sellable-quantity');
  assert.equal(reads.length, 3);
  for (const read of reads) assert.deepEqual(read.options, { query: { symbol: 'TEST' }, accountRequired: true, accountSeq: 7 });
});
test('BUY remains not applicable and missing other required data blocks gate', async () => {
  const deps = fixture({});
  const args = { request: { ...request, side: 'BUY' } };
  const preview = await executeTool('order_preview', args, deps);
  assert.equal(preview.executable, true);
  assert.equal(preview.quantityCheck.status, 'not_applicable_or_not_calculable');
  const get = deps.client.get;
  deps.client.get = (path, options) => path.includes('market-calendar') ? {} : get(path, options);
  const missing = await executeTool('order_preview', args, deps);
  assert.equal(missing.executable, false);
  assert.equal(missing.gate.status, 'blocked');
});
